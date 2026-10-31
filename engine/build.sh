#!/usr/bin/env bash
# Builds the headless Penpot engine into engine/dist: engine.js, from
# src/templates/engine.cljs and Penpot's ClojureScript, and render-wasm.js and
# render-wasm.wasm, Penpot's renderer. Needs git, rustup, Java 25, the Clojure
# CLI, Node and pnpm; it fetches Penpot and emsdk into ENGINE_WORK.
set -euo pipefail

penpot_rev=723267cfdd8a8f3f436be8f4acbab0c4fb8b16db
emsdk_version=4.0.6
here=$(cd "$(dirname "$0")" && pwd)
work=${ENGINE_WORK:-${XDG_CACHE_HOME:-$HOME/.cache}/templates/engine-build}

mkdir -p "$work"
cd "$work"
[ -d emsdk ] || git clone -q --depth 1 https://github.com/emscripten-core/emsdk.git
emsdk/emsdk install "$emsdk_version" >/dev/null
emsdk/emsdk activate "$emsdk_version" >/dev/null
if [ ! -d penpot ]; then
  git init -q penpot
  git -C penpot remote add origin https://github.com/penpot/penpot.git
fi
git -C penpot fetch -q --depth 1 origin "$penpot_rev"
git -C penpot checkout -q --force FETCH_HEAD
git -C penpot clean -qfd
for patch in "$here"/patches/*.patch; do git -C penpot apply "$patch"; done

# Penpot's build sources emsdk from its devenv path, and exits 0 when cargo
# fails, so the artifact's presence is the check.
sed -i "s|/opt/emsdk/emsdk_env.sh|$work/emsdk/emsdk_env.sh|" penpot/render-wasm/build
rm -rf penpot/exporter/resources/wasm
(cd penpot/render-wasm && BUILD_MODE=release ./build export)
test -f penpot/exporter/resources/wasm/render-wasm.wasm

cp -r "$here/src/templates" penpot/exporter/src/
cp "$here/shadow-cljs.edn" penpot/exporter/shadow-cljs.edn
(cd penpot/exporter && pnpm install --frozen-lockfile && clojure -M:dev:shadow-cljs release engine)

mkdir -p "$here/dist"
cp penpot/exporter/target/engine/engine.js penpot/exporter/resources/wasm/render-wasm.js \
  penpot/exporter/resources/wasm/render-wasm.wasm "$here/dist/"
ls -l "$here/dist"
