# Architecture

The CLI runs in Bun and has two backends. The tab backend works inside a browser
tab: each backend function is sent to the page as source text over the Chrome
DevTools Protocol and calls the plugin API there. `figma` is the Figma editor's
API, and `globalThis.ɵcontext` is the Penpot workspace's. Data crosses the
boundary as JSON, with bytes as base64. The headless backend reads a Penpot file
over Penpot's RPC API and renders it in-process with the engine built from
[engine/](../engine).

## One render

`templates render template.json --data rows.csv --on <penpot url>`:

1. [src/cli.ts](../src/cli.ts) reads the template and the rows.
2. [src/data.ts](../src/data.ts) checks the columns against the fields, names
   each output file, and turns each row into a `Variant`: a map from layer path
   to a text or an image's bytes.
3. [src/url.ts](../src/url.ts) parses the URL into a `Target`: Figma or Penpot,
   the file, and the frame or page when the URL names one.
4. [src/backend.ts](../src/backend.ts) finds a tab showing that file, or opens
   one, through [src/cdp.ts](../src/cdp.ts). It waits until the plugin API is on
   the page and returns a `Backend`, which offers the same calls for both tools.
5. `templateFrame` in the CLI finds the template's frame by id on its own
   design, or by name on another.
6. The backend sends four variants at a time to `penpotRender` in
   [src/penpot/page.ts](../src/penpot/page.ts), or `figmaRender` in
   [src/figma/page.ts](../src/figma/page.ts). The page function copies the
   frame, sets each field's layers, exports the copy and deletes it. It returns
   the exports as base64.
7. The CLI writes each export to `--out` as its batch arrives.

`pages`, `layers` and `check` take steps 3 to 5 and call `pages` or `layers` on
the backend.

## One headless render

When `penpotToken` finds a token, `connect` in step 4 returns the backend in
[src/penpot/headless.ts](../src/penpot/headless.ts) instead, and no tab opens:

1. `pages` and `frame` read the file's shapes from `get-file`.
2. `render` fetches the frame's top-level board from `get-page` as transit, and
   the team's fonts from `get-font-variants`.
3. [src/penpot/engine.ts](../src/penpot/engine.ts) loads `engine.js` and the
   renderer from the cache, downloading them on first use.
4. `render` in
   [engine/src/templates/engine.cljs](../engine/src/templates/engine.cljs)
   applies each variant to the shapes in memory, loads their fonts and images
   through the backend's `fetch`, lays out the text and flex layouts in the
   renderer, and returns the export's bytes.

`layers` takes steps 1 to 3 and calls the engine's `layers`.
[src/template.ts](../src/template.ts) turns layers into fields for `init` and
compares them for `check`.

## Copy

`copy` reads a Figma frame with `readFigma` in
[src/figma/read.ts](../src/figma/read.ts), which returns a `Design`: the
tool-neutral tree in [src/model.ts](../src/model.ts) plus its images and SVGs.
The CLI passes it to `writePenpot` in
[src/penpot/write.ts](../src/penpot/write.ts), which builds the board.

## Fonts

`fonts` reads each file's family, weight and style with `readFont` in
[src/font.ts](../src/font.ts). `addFont` in
[src/penpot/fonts.ts](../src/penpot/fonts.ts) uploads it in chunks and adds it
to the team. Both it and the headless backend call Penpot through `rpc` in
[src/penpot/rpc.ts](../src/penpot/rpc.ts).

## Core data

| Type       | File                                  | Holds                                          |
| ---------- | ------------------------------------- | ---------------------------------------------- |
| `Target`   | [src/url.ts](../src/url.ts)           | Tool, file, and frame or page of a design URL. |
| `Layer`    | [src/design.ts](../src/design.ts)     | A text or image layer's path, value and count. |
| `Template` | [src/template.ts](../src/template.ts) | The design URL, the frame, and the fields.     |
| `Variant`  | [src/design.ts](../src/design.ts)     | One row's values by layer path.                |
| `Design`   | [src/model.ts](../src/model.ts)       | A frame's full tree for `copy`.                |

## Investigation

[src/probe.ts](../src/probe.ts) runs a script from `probes/` in a tab and prints
[src/sketch.ts](../src/sketch.ts)'s short outline of the result. See
[probe.md](probe.md).
