# Probe

```sh
bun probe tabs
bun probe run <tab-match> <script> [--name N] [--arg key=value]... [--depth D] [--items I]
bun probe show <name> [path] [--depth D] [--items I] [--full]
```

`probe` runs a script in a browser tab and prints a short sketch of the result.
The full result is saved as `.probe/<name>.json`, named after the script unless
`--name` says otherwise. `show` reads a saved result again, from a dotted path.

```sh
bun probe run figma.com probes/figma-texts.js --arg id=52:2
```

```
.probe/figma-texts.json  309 bytes  0.0s
[
  "feria laboral 3x 473,218,557,136",
  "23 dE MAYO 593,298,435,56",
  "FERIA LABORAL CIENCIAS B 1099,217,661,136",
  … 6 more
]
```

`<tab-match>` is any part of a tab's URL from `bun probe tabs`. A script is the
body of an async function: `args` holds the `--arg` values, `figma` is the Figma
plugin API, and `globalThis.ɵcontext` is the Penpot one. A result with `bytes`
(base64) and `ext` also writes `.probe/<name>.<ext>`.

| Option    | Default | Meaning                               |
| --------- | ------- | ------------------------------------- |
| `--depth` | 4       | Nesting shown before an object folds. |
| `--items` | 3       | Array items shown before `… N more`.  |
| `--full`  | off     | `show` prints the whole value.        |

`probes/` holds the scripts worth keeping. Each says in its first line what it
does and which `args` it takes.
