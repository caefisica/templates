# Agents

- Run `mise run check` before you hand work back.
- A function sent to the page (`src/figma/*.ts`, `src/penpot/page.ts`,
  `src/penpot/write.ts`) runs from its source text. It must not reference
  imports, module constants or other functions outside its own body; types are
  fine.
- The tab backend needs Chrome on `CDP_URL` with Figma and Penpot logged in.
  Test a change to a page function against a real tab, not only the unit tests.
- A change to `engine/` needs `engine/build.sh` and a render with
  `TEMPLATES_ENGINE=$PWD/engine/dist`. Shipping it needs a new release and new
  hashes; see [docs/engine.md](docs/engine.md).
- Put investigation scripts in `probes/` and their output in `.probe/`. Read
  [docs/probe.md](docs/probe.md).
