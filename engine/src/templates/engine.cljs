(ns templates.engine
  "Renders variants of a Penpot board with render-wasm, with no browser.

  A variant maps a layer path to a value, as in the templates CLI: text,
  hidden, image or list. The engine applies the values to the board's shape
  data, lays the text out, propagates the layout changes the way the editor
  does, and renders the board. It does no network I/O of its own: every URL
  goes through the `fetch` function the caller passes."
  (:require
   ["node:fs" :as fs]
   ["node:path" :as path]
   [app.common.data :as d]
   [app.common.fonts :as cfnt]
   [app.common.geom.matrix :as gmt]
   [app.common.geom.point :as gpt]
   [app.common.geom.rect]
   [app.common.geom.shapes :as gsh]
   [app.common.render-wasm.api.props :as props]
   [app.common.render-wasm.api.select :as wselect]
   [app.common.render-wasm.api.upload :as upload]
   [app.common.render-wasm.helpers :as h]
   [app.common.render-wasm.mem :as mem]
   [app.common.render-wasm.mem.heap32 :as mem.h32]
   [app.common.render-wasm.serializers :as sr]
   [app.common.render-wasm.svg-derived :as svg-derived]
   [app.common.render-wasm.wasm :as rw]
   [app.common.transit :as t]
   [app.common.types.fills.impl]
   [app.common.types.modifiers :as ctm]
   [app.common.types.objects-map]
   [app.common.types.path.impl]
   [app.common.types.shape]
   [app.common.types.shape.images :as images]
   [app.common.uuid :as uuid]
   [app.wasm :as wasm]
   [app.wasm.text :as wtext]
   [promesa.core :as p]
   [shadow.esm :refer [dynamic-import]]))

;; --- module

(defn- init*
  "Loads render-wasm.js and render-wasm.wasm from `dir` and boots it headless."
  [dir]
  (let [wasm-bytes (fs/readFileSync (path/resolve dir "render-wasm.wasm"))]
    (->> (dynamic-import (str "file://" (path/resolve dir "render-wasm.js")))
         (p/mcat (fn [mod]
                   ((unchecked-get mod "default")
                    #js {:instantiateWasm
                         (fn [imports success]
                           (-> (js/WebAssembly.instantiate wasm-bytes imports)
                               (.then #(success (.-instance %))))
                           #js {})
                         :locateFile #(path/resolve dir %)
                         :printErr   #(js/console.error "render-wasm:" %)})))
         (p/fmap (fn [module]
                   (set! rw/internal-module module)
                   (h/call module "_init_headless" 1024 768)
                   (set! rw/context-initialized? true)
                   nil)))))

;; --- fetching, cached for the process

(defonce ^:private bytes* (atom {}))

(defn- fetch-cached
  "Promise of the bytes at `url` (an ArrayBuffer), or nil when the fetch fails."
  [fetch url]
  (or (get @bytes* url)
      (let [result (->> (p/do (fetch url))
                        (p/merr (fn [e]
                                  (js/console.error "fetch failed" url (ex-message e))
                                  (p/resolved nil))))]
        (swap! bytes* assoc url result)
        result)))

;; --- fonts

(defn- find-variant
  "The team font variant for a family: by weight and style, then by weight,
  then any."
  [variants font-uuid weight style]
  (let [style (if (zero? style) "normal" "italic")]
    (or (d/seek #(and (= (:font-id %) font-uuid) (= (:font-weight %) weight)
                      (= (name (:font-style %)) style))
                variants)
        (d/seek #(and (= (:font-id %) font-uuid) (= (:font-weight %) weight)) variants)
        (d/seek #(= (:font-id %) font-uuid) variants))))

(defn- font-url
  "Where a family's TTF lives: a team font asset, Penpot's builtin fonts for
  uuid zero, or the Google catalog."
  [{:keys [origin font-variants]} {:keys [id weight style]}]
  (let [font-uuid (uuid/from-unsigned-parts (aget id 0) (aget id 1) (aget id 2) (aget id 3))
        variant   (find-variant font-variants font-uuid weight style)]
    (cond
      (:ttf-file-id variant) (str origin "assets/by-id/" (:ttf-file-id variant))
      (= uuid/zero font-uuid) (str origin "fonts/" (cfnt/resolve-ttf-file weight style))
      :else (cfnt/resolve-ttf-url font-uuid weight style))))

(defn- provision-fonts! [{:keys [fetch] :as opts} frame-id]
  (wasm/provision-fonts! [frame-id]
                         (fn [family]
                           (if-let [url (font-url opts family)]
                             (fetch-cached fetch url)
                             (p/resolved nil)))))

(defn- fallback-fonts
  "Emoji and per-script Noto fonts the scene's text needs. They render as
  fallbacks, so no span names them and `provision-fonts!` never loads them."
  [objects]
  (let [texts (for [shape (vals objects)
                    :when (= :text (:type shape))
                    node  (tree-seq :children :children (:content shape))
                    :when (string? (:text node))]
                (:text node))]
    (distinct
     (cond-> (cfnt/add-noto-fonts [] (reduce cfnt/collect-used-languages #{} texts))
       (some cfnt/contains-emoji? texts) (cfnt/add-emoji-font)))))

(defn- provision-fallback-fonts! [{:keys [fetch]} objects]
  (p/all
   (for [{:keys [font-id weight style is-emoji is-fallback]} (fallback-fonts objects)
         :let [font-uuid (cfnt/gfont-id->uuid font-id)
               url       (some-> font-uuid (cfnt/resolve-ttf-url weight style))]
         :when url]
     (p/fmap (fn [buf]
               (when buf
                 (wasm/store-font! {:id (uuid/get-u32 font-uuid) :weight weight :style style
                                    :emoji? (boolean is-emoji) :fallback? (boolean is-fallback)}
                                   buf)))
             (fetch-cached fetch url)))))

;; --- images

(defn- provision-images!
  "Stores the design's own images, fetched by file-media id, and the images
  the variant brought."
  [{:keys [fetch origin]} objects added]
  (doseq [[id {:keys [bytes]}] added]
    (wasm/store-image! id bytes))
  (p/all
   (for [id (images/scene-image-ids objects)
         :when (and (not (contains? added id)) (not (wasm/image-cached? id)))]
     (p/fmap #(when % (wasm/store-image! id %))
             (fetch-cached fetch (str origin "assets/by-file-media-id/" id))))))

;; --- the shape tree

(defn- subtree [objects id]
  (tree-seq #(seq (:shapes (get objects %))) #(:shapes (get objects %)) id))

(defn- by-path
  "Layer path -> shape ids, in tree order. A path joins the names from the
  root's children down with \"/\"."
  [objects root-id]
  (letfn [(visit [acc id path]
            (reduce #(let [child (get objects %2)]
                       (visit %1 %2 (str path "/" (:name child))))
                    (update acc path (fnil conj []) id)
                    (:shapes (get objects id))))]
    (reduce #(visit %1 %2 (:name (get objects %2))) {} (:shapes (get objects root-id)))))

(defn- remove-tree [state id]
  (let [objects   (:objects state)
        parent-id (:parent-id (get objects id))]
    (-> state
        (update :objects #(apply dissoc % (subtree objects id)))
        (update-in [:objects parent-id :shapes] (fn [shapes] (filterv #(not= id %) shapes))))))

(defn- clone-tree
  "Copies the subtree under `id` with fresh ids, under the same parent, and
  returns the new state and the copy's id. The parent's child list is left to
  the caller."
  [state id]
  (let [objects (:objects state)
        ids     (subtree objects id)
        new-id  (zipmap ids (repeatedly uuid/next))
        remap   #(get new-id % %)]
    [(reduce (fn [state old]
               (assoc-in state [:objects (new-id old)]
                         (-> (get objects old)
                             (assoc :id (new-id old))
                             (update :parent-id remap)
                             (update :frame-id remap)
                             (d/update-when :shapes #(mapv remap %)))))
             state ids)
     (new-id id)]))

;; --- layers

(defn- characters
  "A text's characters as the plugin API reports them: paragraphs joined by
  newlines."
  [content]
  (->> (tree-seq :children :children content)
       (filter #(= "paragraph" (:type %)))
       (map (fn [paragraph] (apply str (map :text (:children paragraph)))))
       (interpose "\n")
       (apply str)))

(defn- legacy-fill-images
  "Moves a shape's `:fill-image`, an image fill from before fills were a list,
  to the top of its fills. The SVG renderer paints it stretched over the fills
  (ui/shapes/fills.cljs); render-wasm reads only the fills."
  [objects]
  (update-vals objects
               (fn [shape]
                 (if-let [image (:fill-image shape)]
                   (-> shape
                       (dissoc :fill-image)
                       (update :fills #(into [{:fill-opacity 1
                                               :fill-image   (assoc image :keep-aspect-ratio false)}]
                                             %)))
                   shape))))

(defn- layer-list
  "The board's text and image layers, by path, as `penpotLayers` lists them.
  Hidden shapes and everything under them are left out."
  [objects root-id]
  (letfn [(visit [acc id path]
            (let [shape (get objects id)
                  image (d/seek :fill-image (seq (:fills shape)))
                  kind  (cond (= :text (:type shape)) "text" image "image")]
              (if (:hidden shape)
                acc
                (reduce #(visit %1 %2 (str path "/" (:name (get objects %2))))
                        (cond
                          (nil? kind) acc
                          (contains? (:index acc) path)
                          (update-in acc [:layers (get-in acc [:index path]) :count] inc)
                          :else
                          (-> acc
                              (assoc-in [:index path] (count (:layers acc)))
                              (update :layers conj {:path path :kind kind :count 1
                                                    :value (if (= kind "text")
                                                             (characters (:content shape))
                                                             (get-in image [:fill-image :name]))})))
                        (:shapes shape)))))]
    (:layers (reduce #(visit %1 %2 (:name (get objects %2)))
                     {:index {} :layers []}
                     (:shapes (get objects root-id))))))

(defn layers
  "The text and image layers of the board `frame` on a `get-page` response."
  [page frame]
  (let [objects (legacy-fill-images (:objects (t/decode-str page)))]
    (clj->js (layer-list objects (uuid/uuid frame)))))

;; --- variant values

(defn- set-text
  "Replaces a text's content with `text`, one paragraph per line, in the
  style of its first paragraph and first span."
  [content text]
  (let [paragraph (-> content :children first :children first)
        span      (-> paragraph :children first)]
    (assoc-in content [:children 0 :children]
              (mapv #(assoc paragraph :children [(assoc span :text %)])
                    (.split text "\n")))))

(defn- set-image [fills image]
  (mapv #(if (:fill-image %) (assoc % :fill-image image) %) (seq fills)))

(declare apply-variant)

(defn- fill-list
  "Replaces `row` and its siblings of the same type with one copy of `row` per
  item. A flex board lays its children out from the end of the list, so the
  copies go in reverse."
  [state row-id items]
  (let [objects   (:objects state)
        row       (get objects row-id)
        parent-id (:parent-id row)
        state     (reduce remove-tree state
                          (filter #(and (not= % row-id) (= (:type row) (:type (get objects %))))
                                  (:shapes (get objects parent-id))))
        [state copies]
        (reduce (fn [[state copies] item]
                  (let [[state copy-id] (clone-tree state row-id)]
                    [(apply-variant state copy-id item) (conj copies copy-id)]))
                [state []] items)]
    (-> state
        (update-in [:objects parent-id :shapes]
                   (fn [shapes] (into [] (mapcat #(if (= % row-id) (concat (rseq copies) [%]) [%])) shapes)))
        (remove-tree row-id)
        (update :reflow conj parent-id))))

(defn- apply-value [state id {:strs [kind text mime base64 width height]}]
  (let [shape (get-in state [:objects id])]
    (case kind
      "hidden" (-> state
                   (assoc-in [:objects id :hidden] true)
                   (update :reflow conj (:parent-id shape)))
      "text"   (if (= :text (:type shape))
                 (-> state
                     (update-in [:objects id :content] set-text text)
                     (update :texts conj id))
                 state)
      "image"  (let [image-id (uuid/next)]
                 (-> state
                     (assoc-in [:images image-id] {:bytes (js/Buffer.from base64 "base64")})
                     (update-in [:objects id :fills] set-image
                                {:id image-id :width width :height height :mtype mime
                                 :keep-aspect-ratio true}))))))

(defn- apply-variant
  "Applies `variant` to the board `root-id`. Paths resolve against the tree as
  it was before any value applied."
  [state root-id variant]
  (let [layers (by-path (:objects state) root-id)]
    (reduce (fn [state [path value]]
              (let [ids (or (get layers path)
                            (throw (js/Error. (str "no layer " path " in "
                                                   (:name (get-in state [:objects root-id]))))))]
                (if (= "list" (get value "kind"))
                  (fill-list state (first ids) (get value "items"))
                  (reduce #(apply-value %1 %2 value) state ids))))
            state variant)))

;; --- layout

(defn- high-surrogate? [code] (<= 0xd800 code 0xdbff))

(defn- join-surrogates
  "Moves a low surrogate that opens a span onto the span before it, when that
  span ends in a high surrogate. The workspace can split an emoji across two
  spans; the wasm reads span lengths as UTF-8 of each half, which overruns the
  paragraph's UTF-8 buffer and panics."
  [spans]
  (reduce (fn [out span]
            (let [prev (peek out)
                  text (:text span "")
                  head (:text prev "")]
              (if (and prev (seq text) (seq head)
                       (high-surrogate? (.charCodeAt head (dec (count head))))
                       (<= 0xdc00 (.charCodeAt text 0) 0xdfff))
                (conj (pop out) (assoc prev :text (str head (subs text 0 1)))
                      (assoc span :text (subs text 1)))
                (conj out span))))
          [] spans))

(defn- line-breaks
  "The offsets in a paragraph's `text` where its position-data `runs` open a
  new line, and the runs after the paragraph's; nil when the runs do not
  spell the text. An empty paragraph has one blank run."
  [text runs]
  (if (empty? text)
    [[] (rest runs)]
    (loop [offset 0 prev-y nil runs runs breaks []]
      (if (= offset (count text))
        [breaks runs]
        (let [{run :text y :y} (first runs)
              end (+ offset (count run))]
          (when (and (seq run) (<= end (count text))
                     (= (.toLowerCase (subs text offset end)) (.toLowerCase run)))
            (recur end y (rest runs)
                   (cond-> breaks (and prev-y (> (abs (- y prev-y)) 0.5)) (conj offset)))))))))

(defn- break-leaves
  "Ends the line at each paragraph offset in `breaks` with a newline, in the
  leaf that holds the line's last character. When `hold-spaces?`, the spaces
  before the newline become no-break spaces: the editor counts a line's
  trailing spaces when it centers or right-aligns it, and Skia counts a
  no-break space but not a trailing one. A left-aligned line keeps its
  spaces, since counting them can push a full line over the width."
  [leaves breaks hold-spaces?]
  (let [hold #(.replace % #" +$" (fn [spaces] (.repeat (js/String.fromCharCode 0xa0) (count spaces))))]
    (mapv (fn [leaf start]
            (let [text  (:text leaf "")
                  cuts  (keep #(when (< start % (+ start (count text) 1)) (- % start)) breaks)
                  lines (map #(subs text %1 %2) (cons 0 cuts) (concat cuts [(count text)]))
                  lines (if hold-spaces? (concat (map hold (butlast lines)) [(last lines)]) lines)]
              (cond-> leaf
                (seq cuts) (assoc :text (.join (clj->js lines) "\n")))))
          leaves (reductions + 0 (map #(count (:text % "")) leaves)))))

(defn- stored-line-breaks
  "Breaks each paragraph of a text where its position data does. The exporter
  draws those runs as the editor wrapped them, and Skia's wrap at the same
  width can move a word. A justified paragraph keeps Skia's wrap, which
  justifies only soft-wrapped lines; so does a text whose runs do not spell
  its content."
  [{:keys [content position-data] :as shape}]
  (let [paths   (for [[si paragraphs] (map-indexed vector (:children content))
                      pi             (range (count (:children paragraphs)))]
                  [:children si :children pi])
        step    (fn [[content runs] path]
                  (let [paragraph (get-in content path)
                        text      (apply str (map #(:text % "") (:children paragraph)))]
                    (if-let [[breaks runs] (line-breaks text runs)]
                      [(cond-> content
                         (and (seq breaks) (not= "justify" (:text-align paragraph)))
                         (update-in (conj path :children) break-leaves breaks
                                    (contains? #{"center" "right"} (:text-align paragraph))))
                       runs]
                      (reduced nil))))
        [content' runs] (reduce step [content (seq position-data)] paths)]
    (if (and content' (empty? runs)) (assoc shape :content content') shape)))

(defn- stored-wraps
  "Gives the board's texts that no value changed their stored line breaks."
  [state root-id]
  (reduce (fn [state id]
            (cond-> state
              (and (= :text (get-in state [:objects id :type]))
                   (not (contains? (:texts state) id)))
              (update-in [:objects id] stored-line-breaks)))
          state (subtree (:objects state) root-id)))

(defn- repair-text [content]
  (update content :children
          (fn [sets]
            (mapv (fn [set]
                    (update set :children
                            (fn [paragraphs] (mapv #(update % :children join-surrogates) paragraphs))))
                  sets))))

(defn- svg-strokes
  "The stroke an imported SVG shape keeps only in its `:svg-attrs`. render-wasm
  derives fills from those attributes but not strokes, so without this an
  imported outline draws nothing. Colour and gradient parse as a fill would."
  [shape]
  (let [attrs (:svg-attrs shape)
        paint (some-> (svg-derived/svg-fill->fills
                       (assoc shape :svg-attrs (cond-> {:fill (:stroke attrs)}
                                                 (:strokeOpacity attrs)
                                                 (assoc :fillOpacity (:strokeOpacity attrs)))))
                      first)
        cap   ({"round" :round "square" :square} (:strokeLinecap attrs))]
    (when paint
      [(cond-> {:stroke-style     :solid
                :stroke-alignment :center
                :stroke-width     (d/parse-double (:strokeWidth attrs "1") 1)
                :stroke-opacity   (:fill-opacity paint 1)}
         (:fill-color paint)          (assoc :stroke-color (:fill-color paint))
         (:fill-color-gradient paint) (assoc :stroke-color-gradient (:fill-color-gradient paint))
         cap                          (assoc :stroke-cap-start cap :stroke-cap-end cap))])))

(defn- data-url [href]
  (when-let [[_ mime base64] (re-matches #"data:([^;,]+);base64,(.*)" (str href))]
    {:mime mime :bytes (js/Buffer.from base64 "base64")}))

(defn- def-node [defs id]
  (or (get defs (keyword id)) (get defs id)))

(defn- pattern-image
  "The image an SVG pattern stretches over its shape's box: a pattern in
  objectBoundingBox content units holding one image, directly or through a
  `use` scaled to 1x1. Nil for any other pattern."
  [defs id]
  (let [pattern (def-node defs id)
        [child & more] (:content pattern)
        href    #(or (get-in % [:attrs :xlinkHref]) (get-in % [:attrs :href]))
        image   (case (some-> child :tag name)
                  "image" child
                  "use"   (some->> (href child) (re-matches #"#(.+)") second (def-node defs))
                  nil)
        w       (d/parse-double (get-in image [:attrs :width]))
        h       (d/parse-double (get-in image [:attrs :height]))
        scale   (if (= "use" (some-> child :tag name))
                  (some->> (get-in child [:attrs :transform]) (re-matches #"scale\(\s*([-\d.e]+)\s*\)")
                           second d/parse-double)
                  1)
        unit?   #(and % scale (< (js/Math.abs (- 1 (* % scale))) 0.01))]
    (when (and (= "pattern" (some-> pattern :tag name))
               (= "objectBoundingBox" (get-in pattern [:attrs :patternContentUnits]))
               (nil? more) (= "image" (some-> image :tag name)) (unit? w) (unit? h))
      (some-> (data-url (href image)) (assoc :width w :height h)))))

(defn- svg-fill-wins?
  "True when Penpot's SVG renderer paints the shape with its `:svg-attrs` fill
  rather than its fills: the fills render as a `url(#fill-…)` attribute, a
  gradient, an image or several fills, and the imported `fill` attribute
  overrides it (ui/shapes/attrs.cljs, add-fill-props!). A single colour fill
  goes in the style and wins."
  [shape]
  (let [fills (:fills shape)]
    (and (some? (get-in shape [:svg-attrs :fill]))
         (not= :image (:type shape))
         (boolean (or (> (count fills) 1)
                      (some :fill-color-gradient fills)
                      (some :fill-image fills))))))

(defn- svg-fill-precedence
  "Drops the fills of every shape whose imported `fill` attribute wins, so
  render-wasm derives the fill from the attribute as the SVG renderer paints it."
  [state root-id]
  (reduce (fn [state id]
            (cond-> state
              (svg-fill-wins? (get-in state [:objects id]))
              (assoc-in [:objects id :fills] [])))
          state (subtree (:objects state) root-id)))

(defn- svg-pattern-fills
  "Gives each shape in the board whose `fill` is `url(#p)` on an image pattern
  that image as a fill, with its bytes in the state's images. render-wasm
  derives colour and gradient fills from SVG attributes, not patterns."
  [state root-id]
  (reduce (fn [state id]
            (let [shape (get-in state [:objects id])
                  ref   (some->> (get-in shape [:svg-attrs :fill])
                                 (re-matches #"url\(\s*['\"]?#([^)'\"]+)['\"]?\s*\)") second)
                  image (when (and ref (empty? (:fills shape))) (pattern-image (:svg-defs shape) ref))]
              (if image
                (let [image-id (uuid/next)]
                  (-> state
                      (assoc-in [:images image-id] {:bytes (:bytes image)})
                      (assoc-in [:objects id :fills]
                                [{:fill-opacity 1
                                  :fill-image   {:id image-id :width (:width image) :height (:height image)
                                                 :mtype (:mime image) :keep-aspect-ratio false}}])))
                state)))
          state (subtree (:objects state) root-id)))

(defn- set-shape!
  "app.wasm.serialize/set-shape!, with the flex and layout-item records the
  exporter leaves out because it never moves a shape."
  [shape]
  (let [shape (svg-derived/apply-svg-derived shape)]
    (upload/set-shape-upload! shape {:include-layout? true})
    (when (some? (:svg-attrs shape)) (props/set-shape-svg-attrs (:svg-attrs shape)))
    (when (and (#{:path :bool} (:type shape)) (some? (:content shape)))
      (props/set-shape-path-content (:content shape)))
    (props/write-shape-fills! (:fills shape))
    (when-not (= :group (:type shape))
      (props/write-shape-strokes! (or (not-empty (:strokes shape)) (svg-strokes shape))))
    (when (= :text (:type shape)) (wtext/set-shape-text! (repair-text (:content shape))))))

(defn- serialize! [objects]
  (h/call rw/internal-module "_init_shapes_pool" (count objects))
  (run! set-shape! (vals objects)))

(defn- layout-texts! [objects]
  (doseq [[id shape] objects :when (= :text (:type shape))]
    (wasm/update-text-layout! id)))

(defn- text-dimensions [id]
  (wselect/use-shape id)
  (let [ptr (h/call rw/internal-module "_get_text_dimensions")]
    (when-not (zero? ptr)
      (let [o  (mem/->offset-32 ptr)
            f  (mem/get-heap-f32)
            dm {:width (aget f o) :height (aget f (+ o 1))}]
        (mem/free)
        dm))))

(defn- resize-entry
  "The editor's resize-wasm-text-modifiers: the transform that grows a text
  box to its laid-out size."
  [{:keys [id points selrect grow-type] :as shape}]
  (when-let [dm (when (not= :fixed grow-type) (text-dimensions id))]
    (let [w (if (= :auto-height grow-type) (:width selrect) (:width dm))
          m (ctm/resize-modifiers (gpt/point (/ w (:width selrect)) (/ (:height dm) (:height selrect)))
                                  (first points)
                                  (:transform shape (gmt/matrix))
                                  (:transform-inverse shape (gmt/matrix)))]
      [id (ctm/modifiers->transform m)])))

(defn- propagate!
  "Runs the wasm's modifier propagation. An identity transform asks for a
  reflow of that shape's layout. Returns [id matrix] for each moved shape."
  [entries]
  (let [offset (mem/alloc->offset-32 (mem/get-alloc-size entries 44))]
    (reduce (fn [offset [id transform]]
              (-> offset
                  (mem.h32/write-uuid (mem/get-heap-u32) id)
                  (mem.h32/write-matrix (mem/get-heap-f32) transform)
                  (mem.h32/write-u32 (mem/get-heap-u32) (sr/translate-transform-entry-kind :child))))
            offset entries)
    (let [offset (mem/->offset-32 (h/call rw/internal-module "_propagate_modifiers" 0))
          u32    (mem/get-heap-u32)
          f32    (mem/get-heap-f32)
          result (vec (for [i (range (aget u32 offset))
                            :let [o (+ offset 1 (* i 10))]]
                        [(uuid/from-unsigned-parts (aget u32 o) (aget u32 (+ o 1))
                                                   (aget u32 (+ o 2)) (aget u32 (+ o 3)))
                         (gmt/matrix (aget f32 (+ o 4)) (aget f32 (+ o 5)) (aget f32 (+ o 6))
                                     (aget f32 (+ o 7)) (aget f32 (+ o 8)) (aget f32 (+ o 9)))]))]
      (mem/free)
      result)))

(defn- lay-out
  "Grows the edited texts, reflows the layouts that lost or gained children,
  and returns the objects with every moved shape transformed."
  [{:keys [objects texts reflow]}]
  (let [entries (concat (keep #(resize-entry (get objects %)) texts)
                        (for [id reflow :when (contains? objects id)] [id (gmt/matrix)]))
        moved   (if (seq entries) (propagate! (vec entries)) [])]
    (reduce (fn [objects [id m]] (update objects id gsh/apply-transform m)) objects moved)))

;; --- render

(defn- render-bytes [frame-id format scale]
  (case format
    "pdf" (wasm/render-shape-pdf frame-id)
    "svg" (wasm/render-shape-svg frame-id scale)
    "jpg" (wasm/render-shape-raster frame-id scale :jpeg)
    (wasm/render-shape-raster frame-id scale :png)))

(defn- render-variant [opts objects frame-id variant]
  (let [state (-> {:objects (legacy-fill-images objects) :texts #{} :reflow #{} :images {}}
                  (apply-variant frame-id variant)
                  (stored-wraps frame-id)
                  (svg-fill-precedence frame-id)
                  (svg-pattern-fills frame-id))]
    (serialize! (:objects state))
    (wasm/clear-fonts!)
    (->> (p/all [(provision-fonts! opts frame-id)
                 (provision-fallback-fonts! opts (:objects state))
                 (provision-images! opts (:objects state) (:images state))])
         (p/fmap (fn [_]
                   (layout-texts! (:objects state))
                   (let [moved (lay-out state)]
                     (when-not (identical? moved (:objects state))
                       (serialize! moved)
                       (layout-texts! moved))
                     (render-bytes frame-id (:format opts) (:scale opts))))))))

(defonce ^:private module* (atom nil))

(defn render
  "Renders each variant of the board `frame` on a `get-page` response.
  Options: page (the transit text), frame (board id), variants (array of
  {path: value}), format (png, jpg, pdf, svg), scale, origin (the Penpot URL
  with a trailing slash), wasmDir, fetch (url -> Promise of an ArrayBuffer or
  null) and fontVariants (the transit text of `get-font-variants`, optional).
  Returns a Promise of an array of Uint8Array, in variant order."
  [^js opts]
  (let [objects  (:objects (t/decode-str (.-page opts)))
        frame-id (uuid/uuid (.-frame opts))
        opts'    {:origin        (.-origin opts)
                  :fetch         (.-fetch opts)
                  :format        (.-format opts)
                  :scale         (or (.-scale opts) 1)
                  :font-variants (some-> (.-fontVariants opts) t/decode-str)}]
    (when-not (contains? objects frame-id)
      (throw (js/Error. (str "no board " frame-id " in the page"))))
    (->> (or @module* (reset! module* (init* (.-wasmDir opts))))
         (p/mcat (fn [_]
                   (reduce (fn [done variant]
                             (p/mcat (fn [out]
                                       (p/fmap #(conj out %) (render-variant opts' objects frame-id variant)))
                                     done))
                           (p/resolved [])
                           (js->clj (.-variants opts)))))
         (p/fmap clj->js))))
