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
   [app.common.geom.shapes.bounds :as gsb]
   [app.common.render-wasm.api.props :as props]
   [app.common.render-wasm.api.select :as wselect]
   [app.common.render-wasm.api.upload :as upload]
   [app.common.render-wasm.helpers :as h]
   [app.common.render-wasm.mem :as mem]
   [app.common.render-wasm.mem.heap32 :as mem.h32]
   [app.common.render-wasm.serializers :as sr]
   [app.common.render-wasm.svg-derived :as svg-derived]
   [app.common.render-wasm.text-content :as tc]
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

(defn- provision-fallback-fonts!
  "Stores the fallback fonts once all have arrived, in font id order.
  render-wasm tries them in the order they were stored, and a glyph two of
  them have (⇧ is in both Noto Sans Symbols fonts) takes its line height from
  the first."
  [{:keys [fetch]} objects]
  (let [fonts (for [{:keys [font-id weight style] :as font} (sort-by :font-id (fallback-fonts objects))
                    :let [font-uuid (cfnt/gfont-id->uuid font-id)
                          url       (some-> font-uuid (cfnt/resolve-ttf-url weight style))]
                    :when url]
                [(assoc font :uuid font-uuid) url])]
    (p/fmap (fn [bufs]
              (doseq [[[{:keys [uuid weight style is-emoji is-fallback]}] buf] (map vector fonts bufs)
                      :when buf]
                (wasm/store-font! {:id (uuid/get-u32 uuid) :weight weight :style style
                                   :emoji? (boolean is-emoji) :fallback? (boolean is-fallback)}
                                  buf)))
            (p/all (map #(fetch-cached fetch (second %)) fonts)))))

(defn- ttf-metrics
  "The ascent and descent of a TTF or OTF in `buf` per unit of font size, as
  FreeType reads them: the typo metrics when OS/2 sets USE_TYPO_METRICS or
  hhea holds none, else hhea's. Nil for any other format."
  [buf]
  (let [view   (js/DataView. buf)
        u16    #(.getUint16 view %)
        i16    #(.getInt16 view %)
        tag    #(apply str (map (fn [i] (js/String.fromCharCode (.getUint8 view (+ % i)))) (range 4)))
        tables (when (contains? #{"\u0000\u0001\u0000\u0000" "true" "OTTO"} (tag 0))
                 (into {} (for [i (range (u16 4)) :let [o (+ 12 (* 16 i))]]
                            [(tag o) (.getUint32 view (+ o 8))])))
        {head "head" hhea "hhea" os2 "OS/2"} tables]
    (when (and head hhea)
      (let [upm   (u16 (+ head 18))
            typo? (and os2 (or (bit-test (u16 (+ os2 62)) 7)
                               (and (zero? (i16 (+ hhea 4))) (zero? (i16 (+ hhea 6))))))
            [a d] (if typo?
                    [(i16 (+ os2 68)) (i16 (+ os2 70))]
                    [(i16 (+ hhea 4)) (i16 (+ hhea 6))])]
        {:ascent (/ a upm) :descent (/ (- d) upm)}))))

(defn- leaf-family
  "The family render-wasm loads for `leaf` in `paragraph`."
  [paragraph leaf]
  {:id     (uuid/get-u32 (cfnt/font-id->uuid (:font-id leaf "sourcesanspro")))
   :weight (tc/serialize-font-weight (get leaf :font-weight (tc/serialize-font-weight (:font-weight paragraph))))
   :style  (if (= "italic" (:font-style leaf)) 1 0)})

(defn- family-key [{:keys [id weight style]}]
  [(vec id) weight style])

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
  new line, the [y height] of each line, and the runs after the paragraph's;
  nil when the runs do not spell the text. A run's y is the bottom of its
  content area, so runs of one size on one line share it and a larger run
  sits lower. A run opens a line when its y differs and it starts left of
  the previous run's end. A line takes its tallest run's [y height]."
  [text runs]
  (if (empty? text)
    (when-let [{:keys [y height]} (first runs)] [[] [[y height]] (rest runs)])
    (loop [offset 0 lines [] runs runs breaks [] prev nil]
      (if (= offset (count text))
        [breaks lines runs]
        (let [{run :text :keys [x y width height] :as r} (first runs)
              end       (+ offset (count run))
              new-line? (or (nil? prev)
                            (and (> (abs (- y (:y prev))) 0.5)
                                 (< x (- (+ (:x prev) (:width prev)) 0.5))))]
          (when (and (seq run) (<= end (count text))
                     (= (.toLowerCase (subs text offset end)) (.toLowerCase run)))
            (recur end
                   (cond
                     new-line?                        (conj lines [y height])
                     (> height (second (peek lines))) (conj (pop lines) [y height])
                     :else                            lines)
                   (rest runs)
                   (cond-> breaks (and new-line? (seq lines)) (conj offset))
                   r)))))))

(defn- split-lines
  "Cuts a paragraph's `leaves` at each offset in `breaks` into one vector of
  leaves per line, and ends every line but the last with a newline. When
  `hold-spaces?`, the spaces before the newline become no-break spaces: the
  editor counts a line's trailing spaces when it centers or right-aligns it,
  and Skia counts a no-break space but not a trailing one. A left-aligned
  line keeps its spaces, since counting them can push a full line over the
  width."
  [leaves breaks hold-spaces?]
  (let [hold   #(.replace % #" +$" (fn [spaces] (.repeat (js/String.fromCharCode 0xa0) (count spaces))))
        cut?   (set breaks)
        pieces (mapcat (fn [leaf start]
                         (let [text (:text leaf "")
                               end  (+ start (count text))]
                           (if (empty? text)
                             [[leaf false]]
                             (keep (fn [[from to]]
                                     (when (< from to)
                                       [(assoc leaf :text (cond-> (subs text (- from start) (- to start))
                                                            (and hold-spaces? (cut? to)) hold
                                                            (cut? to) (str "\n")))
                                        (cut? to)]))
                                   (partition 2 1 (concat [start] (filter #(< start % (inc end)) breaks) [end]))))))
                       leaves (reductions + 0 (map #(count (:text % "")) leaves)))]
    (reduce (fn [lines [piece line-end?]]
              (cond-> (update lines (dec (count lines)) conj piece) line-end? (conj [])))
            [[]] pieces)))

(defn- leaf-font-size
  "The font size render-wasm gives `leaf`, which falls back to its paragraph's."
  [paragraph leaf]
  (js/parseFloat (or (:font-size leaf) (:font-size paragraph) "14")))

(defn- leaf-pitch
  "The pitch the editor gives a line of `leaf` in `paragraph`, before
  rounding. The editor steps lines by the paragraph's line height and
  ignores a leaf's."
  [paragraph leaf]
  (* (leaf-font-size paragraph leaf)
     (js/parseFloat (or (:line-height paragraph) (:line-height leaf) "1.2"))))

(defn- line-pitches
  "The stored pitch of each of `lines` of [pitch top]: the step to the next
  line's top. The last line, which has no next top, takes the stored pitch of
  the last line with its own unrounded pitch, or that pitch."
  [lines]
  (let [tops  (mapv second lines)
        last' (let [[pitch top] (peek lines)]
                (+ top (or (some (fn [[[p] step]] (when (= p pitch) step))
                                 (reverse (map vector lines (map - (rest tops) tops))))
                           pitch)))
        tops  (conj tops last')]
    (map - (rest tops) tops)))

(defn- line-heights
  "Whole-pixel heights for lines of `pitches` that keep each line's top within
  half a pixel of its stored top. Skia rounds every line's height on its own,
  so a 22.4 px pitch steps 22 px and the error grows down the text."
  [pitches]
  (let [tops (map js/Math.round (reductions + 0 pitches))]
    (map - (rest tops) tops)))

(defn- snapped-heights
  "Whole-pixel heights, each within a pixel of its line's `:pitch`, that put
  the most of `lines` on the pixel row of their stored `:target`, then
  nearest it, then nearest their pitches rounded up. A half-pixel step
  cannot move a line a whole row, so a line may take a pixel the next line
  gives back. Where heights tie, the one nearest `prefer` wins: the
  rounded-up pitch, which render-wasm centers as the exporter does. Skia
  centers a line's content in its height, puts the target `:offset` below
  that center, and rounds that baseline to a whole unit of the paragraph
  before render-wasm offsets the paragraph by the vertical align of the box
  height less the lines'. The pixel row then rounds the sum again. A line with no target
  draws nothing and only spaces the others. Targets are measured from the
  board top, and heights from the box top, which sits `shift` below it.

  No height moves a lone line in a centered or bottom box, so such a line
  is aligned to the top instead, with heights up to four pixels either side
  of the one that keeps its center. Returns {:heights :valign}."
  [lines box-height valign shift scale]
  (let [lone?   (and (= 1 (count lines)) (:target (first lines)) (contains? #{"center" "bottom"} valign))
        start   (fn [valign total] (case valign "bottom" (- box-height total) "center" (/ (- box-height total) 2) 0))
        center2 (when lone?
                  (let [n (js/Math.ceil (:pitch (first lines)))]
                    (+ (* 2 (start valign n)) n)))
        valign  (if lone? "top" valign)
        row     #(js/Math.round (* % scale))
        options (map (fn [{:keys [pitch]}]
                       (distinct (map #(max 1 %)
                                      (if lone?
                                        (range (- (js/Math.floor center2) 4) (+ (js/Math.ceil center2) 5))
                                        (range (dec (js/Math.floor pitch)) (+ 2 (js/Math.ceil pitch)))))))
                     lines)
        prefer  (fn [pitch] (or center2 (js/Math.ceil pitch)))
        miss    (fn [start top n {:keys [target offset pitch]}]
                  (+ (* 1e-6 (abs (- n (prefer pitch))))
                     (if target
                       (let [s (+ shift start (js/Math.round (+ top (/ n 2) offset)))]
                         (+ (abs (- (row s) (row target))) (* 0.001 (abs (- s target)))))
                       0)))
        fit     (fn [total]
                  (let [start (start valign total)
                        step  (fn [states [line ns]]
                                (reduce-kv
                                 (fn [out top [cost heights]]
                                   (reduce (fn [out n]
                                             (let [cost (+ cost (miss start top n line))]
                                               (if (some-> (get out (+ top n)) first (<= cost))
                                                 out
                                                 (assoc out (+ top n) [cost (conj heights n)]))))
                                           out ns))
                                 {} states))]
                    (get (reduce step {0 [0 []]} (map vector lines options)) total)))]
    {:heights (->> (range (apply + (map first options)) (inc (apply + (map last options))))
                   (keep fit)
                   (apply min-key first)
                   second)
     :valign  valign}))

(defn- line-target
  "Where the exporter draws the line on the board, as {:target :offset} for
  `snapped-heights`; nil for a blank line. It draws each run as SVG text at
  the run's y on the ideographic baseline, which Chrome puts the font's
  descent, rounded at the render `scale`, above the baseline. Chrome maps
  the board's y through the viewBox in single floats, so a y a float's error
  short of a half pixel is the half pixel there and rounds up. The line's
  largest leaf sets it. Without that font's metrics the target is the run's
  center, which Skia's content center meets."
  [{:keys [metrics board-y scale vb-scale vb-shift]} paragraph line [y height]]
  (let [measure (fn [leaf]
                  (when-let [{:keys [ascent descent]} (get metrics (family-key (leaf-family paragraph leaf)))]
                    (let [size (leaf-font-size paragraph leaf)]
                      [size (* size ascent) (* size descent)])))
        fonts   (map measure line)
        f32     js/Math.fround
        on-page #(+ (f32 (* (f32 vb-scale) (f32 (- % board-y)))) vb-shift)]
    (cond
      (re-matches #"\s*" (apply str (map #(:text % "") line))) nil
      (every? some? fonts)
      (let [[_ _ d] (apply max-key first fonts)]
        {:target (- (on-page y) (/ (js/Math.round (* d scale)) scale))
         :offset (apply max (map (fn [[_ a d]] (/ (- a d) 2)) fonts))})
      :else {:target (on-page (- y (/ height 2))) :offset 0})))

(defn- export-viewbox
  "The exporter's SVG viewBox transform for board `frame-id`, as the
  `:vb-scale` and `:vb-shift` that take a y on the board to Chrome's page y.
  The SVG's width, height and viewBox are the board's bounds to three
  decimals, as `render.cljs` formats them. Chrome lays the SVG box out in
  1/64 px units, scales the viewBox to fit it, centered, and floors the
  translation to the same unit."
  [objects frame-id]
  (let [frame  (get objects frame-id)
        bounds (gsb/get-object-bounds objects frame {:ignore-margin? false})
        fixed  #(js/parseFloat (.toFixed % 3))
        unit   #(/ (js/Math.floor (* % 64)) 64)
        top    (fixed (- (:y bounds) (get-in frame [:selrect :y])))
        width  (fixed (:width bounds))
        height (fixed (:height bounds))]
    (if (and (pos? width) (pos? height))
      (let [s (min (/ (unit width) width) (/ (unit height) height))]
        {:vb-scale s
         :vb-shift (unit (- (/ (- (unit height) (* height s)) 2) (* top s)))})
      {:vb-scale 1 :vb-shift 0})))

(defn- stored-pitch
  "Gives each line of `paragraphs` the whole-pixel height its stored runs
  set. `paragraphs` holds [paragraph lines marks] in text order, with one
  leaf vector in `lines` per [y height] in `marks`. A line's content area sits
  centered in its pitch, so its top is y less the mean of its height and
  pitch. Each leaf's line height carries the line's height, and a
  paragraph's line height drops to its smallest leaf's, since render-wasm
  lays out each span at the larger of the two. An unrotated text puts each
  line on its stored baseline's pixel row; a rotated one keeps the pitch.
  Returns [valign paragraphs], with the vertical align the heights assume."
  [{:keys [board-y scale] :as ctx} {:keys [selrect content] :as shape} paragraphs]
  (let [pitch   (fn [paragraph line] (apply max (map #(leaf-pitch paragraph %) line)))
        marks   (for [[paragraph lines marks] paragraphs
                      [line [y height :as mark]] (map vector lines marks)]
                  [(pitch paragraph line) y height (line-target ctx paragraph line mark)])
        pitches (line-pitches (mapv (fn [[p y height]] [p (- y (/ (+ height p) 2))]) marks))
        {:keys [heights valign]}
        (if (gmt/unit? (:transform shape (gmt/matrix)))
          (snapped-heights (map (fn [[_ _ _ target] pitch]
                                  (assoc target :pitch pitch))
                                marks pitches)
                           (:height selrect) (:vertical-align content)
                           (- (:y selrect) board-y) scale)
          {:heights (line-heights pitches) :valign (:vertical-align content)})]
    [valign
     (first
      (reduce (fn [[out heights] [paragraph lines]]
                (let [lines' (map (fn [line height]
                                    (mapv #(assoc % :line-height (/ height (leaf-font-size paragraph %)))
                                          line))
                                  lines heights)
                      leaves (vec (apply concat lines'))]
                  [(conj out (assoc paragraph
                                    :children leaves
                                    :line-height (apply min (map :line-height leaves))))
                   (drop (count lines) heights)]))
              [[] heights] paragraphs))]))

(defn- stored-width
  "Widens an unrotated text box to cover its stored runs, with a pixel to
  spare on the side or sides its `aligns` grow. The editor lets a line wider
  than the box overflow it toward the end, whatever the align, and Skia
  breaks that line instead; Skia also measures a line a fraction wider than
  the editor and can wrap a full one. A justified or mixed-align text keeps
  its width."
  [{:keys [selrect position-data] :as shape} aligns]
  (if (and (= 1 (count aligns)) (not (contains? aligns "justify"))
           (seq position-data) (gmt/unit? (:transform shape (gmt/matrix))))
    (let [{:keys [x x2]} selrect
          [pad-l pad-r] (case (first aligns) "right" [1 0] "center" [1 1] [0 1])
          left  (min x (- (apply min (map :x position-data)) pad-l))
          right (max x2 (+ (apply max (map #(+ (:x %) (:width %)) position-data)) pad-r))]
      (if (or (< left x) (> right x2))
        (let [sx (/ (- right left) (- x2 x))]
          (gsh/apply-transform shape (gmt/matrix sx 0 0 1 (- left (* sx x)) 0)))
        shape))
    shape))

(defn- stored-line-breaks
  "Lays a text out as its position data does. The exporter draws those runs
  as the editor laid them out: Skia's wrap at the same width can move a word,
  and the editor's line pitch is fractional and need not be the font size
  times the line height. Each paragraph breaks where its runs do, and each
  line takes the height between its run and the next. A justified paragraph
  keeps Skia's wrap, which justifies only soft-wrapped lines, and the text
  keeps its line heights; a text whose runs do not spell its content stays
  as it is."
  [ctx {:keys [content position-data] :as shape}]
  (let [paths (for [[si paragraphs] (map-indexed vector (:children content))
                    pi             (range (count (:children paragraphs)))]
                [:children si :children pi])
        step  (fn [[out runs] path]
                (let [paragraph (get-in content path)
                      leaves    (:children paragraph)
                      text      (apply str (map #(:text % "") leaves))]
                  (if-let [[breaks marks runs] (line-breaks text runs)]
                    [(conj out [path paragraph
                                (if (= "justify" (:text-align paragraph))
                                  [leaves]
                                  (split-lines leaves breaks (contains? #{"center" "right"} (:text-align paragraph))))
                                marks])
                     runs]
                    (reduced nil))))
        [paragraphs runs] (reduce step [[] (seq position-data)] paths)
        pitched? (every? (fn [[_ _ lines marks]] (= (count lines) (count marks))) paragraphs)
        [valign updated]
        (if pitched?
          (stored-pitch ctx shape (map rest paragraphs))
          [(:vertical-align content)
           (map (fn [[_ paragraph lines]] (assoc paragraph :children (vec (apply concat lines))))
                paragraphs)])]
    (if (and paragraphs (empty? runs))
      (-> shape
          (assoc :content (reduce (fn [content [[path] paragraph]] (assoc-in content path paragraph))
                                  (cond-> content valign (assoc :vertical-align valign))
                                  (map vector paragraphs updated)))
          (stored-width (set (map (fn [[_ paragraph]] (:text-align paragraph "left")) paragraphs))))
      shape)))

(defn- stored-wraps
  "Gives the board's texts that no value changed their stored line breaks.
  `ctx` holds the `font-metrics`, the board's top and the render scale."
  [state root-id ctx]
  (reduce (fn [state id]
            (cond-> state
              (and (= :text (get-in state [:objects id :type]))
                   (not (contains? (:texts state) id)))
              (update-in [:objects id] #(stored-line-breaks ctx %))))
          state (subtree (:objects state) root-id)))

(defn- font-metrics
  "Promise of a map from each family the board's texts use to its
  `ttf-metrics`. It fetches through the cache that `provision-fonts!` reads."
  [{:keys [fetch] :as opts} objects root-id]
  (let [families (into []
                       (d/distinct-xf family-key)
                       (for [id        (subtree objects root-id)
                             :let      [{:keys [type content]} (get objects id)]
                             :when     (= :text type)
                             paragraph (tree-seq :children :children content)
                             :when     (= "paragraph" (:type paragraph))
                             leaf      (:children paragraph)]
                         (leaf-family paragraph leaf)))]
    (->> families
         (map (fn [family]
                (if-let [url (font-url opts family)]
                  (p/fmap #(when % [(family-key family) (ttf-metrics %)]) (fetch-cached fetch url))
                  (p/resolved nil))))
         (p/all)
         (p/fmap #(into {} (filter second) %)))))

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

(defn- left-letter-spacing
  "The one letter spacing every leaf of `shape`'s text sets, when every
  paragraph aligns left or justified; nil otherwise."
  [{:keys [content]}]
  (let [nodes  (tree-seq :children :children content)
        values (->> (filter :text nodes)
                    (map #(js/parseFloat (or (:letter-spacing %) "0")))
                    distinct)]
    (when (and (= 1 (count values)) (not (zero? (first values)))
               (every? #(contains? #{"left" "justify"} (:text-align % "left"))
                       (filter #(= "paragraph" (:type %)) nodes)))
      (first values))))

(defn- letter-spacing-shift
  "Moves each left-aligned text in the board that sets one letter spacing
  back by half of it along its baseline. Skia puts half a glyph's letter
  spacing before it and half after, where the browser puts all of it after,
  so render-wasm draws such a text half a spacing right of the server export.
  Centered and right-aligned lines already land where the server draws them."
  [objects root-id]
  (reduce (fn [objects id]
            (let [{:keys [type transform] :as shape} (get objects id)
                  ls (when (= :text type) (left-letter-spacing shape))]
              (if ls
                (let [{:keys [a b]} (or transform (gmt/matrix))]
                  (update objects id gsh/move (gpt/point (* -0.5 ls a) (* -0.5 ls b))))
                objects)))
          objects (subtree objects root-id)))

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

;; --- overflow

(defn- visible-texts [objects root-id]
  (letfn [(visit [id]
            (let [shape (get objects id)]
              (when-not (:hidden shape)
                (cons id (mapcat visit (:shapes shape))))))]
    (filter #(= :text (:type (get objects %)))
            (mapcat visit (:shapes (get objects root-id))))))

(defn- layer-path [objects root-id id]
  (->> (iterate #(:parent-id (get objects %)) id)
       (take-while #(and (some? %) (not= root-id %)))
       (map #(:name (get objects %)))
       reverse
       (interpose "/")
       (apply str)))

(defn- past-edges
  "How far the shape `id` reaches past each edge of the board `root-id`."
  [objects root-id id]
  (let [board (get-in objects [root-id :selrect])
        box   (get-in objects [id :selrect])]
    {:left   (- (:x1 board) (:x1 box))
     :right  (- (:x2 box) (:x2 board))
     :top    (- (:y1 board) (:y1 box))
     :bottom (- (:y2 box) (:y2 board))}))

(defn- overflow
  "The texts the variant pushed past an edge of the clipping board `root-id`,
  as [{:path :edge :px}], one per path at its furthest edge. A text that
  already crossed an edge in the design warns only when it reaches further. A
  board that shows its content grows the export instead of clipping it."
  [before after root-id]
  (if (get-in after [root-id :show-content])
    []
    (->> (for [id    (visible-texts after root-id)
               :let  [was (when (contains? before id) (past-edges before root-id id))]
               [edge px] (past-edges after root-id id)
               :when (and (> px 0.5) (> (- px (max 0 (get was edge 0))) 0.5))]
           {:path (layer-path after root-id id) :edge (name edge) :px (js/Math.round px)})
         (group-by :path)
         vals
         (mapv #(apply max-key :px %)))))

;; --- render

(defn- render-bytes [frame-id format scale]
  (case format
    "pdf" (wasm/render-shape-pdf frame-id)
    "svg" (wasm/render-shape-svg frame-id scale)
    "jpg" (wasm/render-shape-raster frame-id scale :jpeg)
    (wasm/render-shape-raster frame-id scale :png)))

(defn- render-variant [opts objects frame-id variant]
  (let [state (-> {:objects (legacy-fill-images objects) :texts #{} :reflow #{} :images {}}
                  (apply-variant frame-id variant))]
    (->> (font-metrics opts (:objects state) frame-id)
         (p/mcat (fn [metrics]
                   (let [ctx   (merge {:metrics metrics
                                       :board-y (get-in objects [frame-id :selrect :y] 0)
                                       :scale   (:scale opts)}
                                      (export-viewbox objects frame-id))
                         state (-> state
                                   (stored-wraps frame-id ctx)
                                   (svg-fill-precedence frame-id)
                                   (svg-pattern-fills frame-id))]
                     (serialize! (:objects state))
                     (wasm/clear-fonts!)
                     (->> (p/all [(provision-fonts! opts frame-id)
                                  (provision-fallback-fonts! opts (:objects state))
                                  (provision-images! opts (:objects state) (:images state))])
                          (p/mcat (fn [_]
                                    (layout-texts! (:objects state))
                                    (let [moved (letter-spacing-shift (lay-out state) frame-id)]
                                      (when-not (identical? moved (:objects state))
                                        (serialize! moved)
                                        (layout-texts! moved))
                                      (p/fmap (fn [bytes] {:bytes bytes :overflow (overflow objects moved frame-id)})
                                              (p/resolved (render-bytes frame-id (:format opts) (:scale opts))))))))))))))

(defonce ^:private module* (atom nil))

(defn render
  "Renders each variant of the board `frame` on a `get-page` response.
  Options: page (the transit text), frame (board id), variants (array of
  {path: value}), format (png, jpg, pdf, svg), scale, origin (the Penpot URL
  with a trailing slash), wasmDir, fetch (url -> Promise of an ArrayBuffer or
  null) and fontVariants (the transit text of `get-font-variants`, optional).
  Returns a Promise of an array of {bytes, overflow}, in variant order:
  bytes is a Uint8Array and overflow lists {path, edge, px} as `overflow`
  does."
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
