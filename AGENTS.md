# Agents

- Run `mise run check` before you hand work back.
- A function sent to the page (`src/figma/*.ts`, `src/penpot/*.ts`) runs from
  its source text. It must not reference imports, module constants or other
  functions outside its own body; types are fine.
- The CLI needs Chrome on `CDP_URL` with Figma and Penpot logged in. Test a
  change to a page function against a real tab, not only the unit tests.
- Put investigation scripts in `probes/` and their output in `.probe/`. Read
  [docs/probe.md](docs/probe.md).
