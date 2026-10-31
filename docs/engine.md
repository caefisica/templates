# Penpot without a browser

```sh
echo '<token>' > ~/.config/templates/penpot-token
templates render template.json --data rows.json
```

With a token, `pages`, `layers`, `init`, `render` and `check` on a Penpot URL
call Penpot's API and need no browser. Create the token in Penpot under Your
account, Access tokens. `PENPOT_TOKEN` overrides the file. Without a token, the
CLI uses the browser tab as before. `copy` always uses the tab.

The engine draws each variant with Penpot's renderer, compiled to WebAssembly,
at the version in `engine/build.sh`. It lays out text and flex rows the way the
workspace does, loads the design's fonts and images from the Penpot server, and
leaves the design unchanged. A board on any page can be rendered, and a Penpot
SVG embeds its images.

## The engine files

On first use the CLI downloads the engine, about 5 MB, from this repository's
`engine-723267c-2` release into `~/.cache/templates/engine-723267c-2/`, and
checks each file against the hash in
[src/penpot/engine.ts](../src/penpot/engine.ts).

| File               | Holds                                                      |
| ------------------ | ---------------------------------------------------------- |
| `engine.js`        | Penpot's shape code and `templates.engine`, as one module. |
| `render-wasm.js`   | The loader for the renderer.                               |
| `render-wasm.wasm` | Penpot's renderer: Rust and Skia.                          |

`TEMPLATES_ENGINE` names a directory with these three files to use instead.

## Building it

```sh
engine/build.sh
TEMPLATES_ENGINE=$PWD/engine/dist templates render template.json --data rows.json
```

The script fetches Penpot at a pinned commit and emsdk into `ENGINE_WORK`
(default `~/.cache/templates/engine-build`), applies the fixes in
[engine/patches/](../engine/patches/) to Penpot, builds the renderer, compiles
[engine/src/templates/engine.cljs](../engine/src/templates/engine.cljs) with
Penpot's ClojureScript, and writes the three files to `engine/dist/`. It needs
git, rustup, Java 25, the Clojure CLI, Node and pnpm.

A new build has new hashes. To ship it, gzip each file with `gzip -9 -n`, attach
the `.gz` files to a release named after the Penpot commit and a build number
(`engine-723267c-2`), and update the release name and hashes in
`src/penpot/engine.ts`.

## Licence

`engine.js` and `render-wasm.*` contain Penpot, licensed MPL-2.0. Their source
is Penpot at the commit `engine/build.sh` names, with `engine/patches`,
`engine/src` and `engine/shadow-cljs.edn` from this repository.
