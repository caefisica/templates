# Team fonts

```sh
templates fonts '<penpot url>' --family "Satoshi Variable" Satoshi-*.otf
```

```
Satoshi-Black.otf → Satoshi Variable 900 normal
Satoshi-BlackItalic.otf → Satoshi Variable 900 italic
Satoshi-Bold.otf → Satoshi Variable 700 normal
...
```

`fonts` adds font files to the team that owns the Penpot file in the URL. It
reads each file's family, weight and style, uploads it, and files it as a weight
of that family. Penpot then lists the weights as one font, and the headless
engine loads them when it renders the team's files. A weight and style the team
already has is skipped:

```
Satoshi-Black.otf: the team already has Satoshi Variable 900 normal
```

With no files, `fonts` lists the team's own fonts and their weights; `i` marks
an italic:

```sh
templates fonts '<penpot url>'
```

```
Satoshi Variable  300 300i 400 400i 500 500i 700 700i 900 900i
```

`fonts` reads every file before it uploads any, so one bad file stops the run
with nothing added. It needs the Penpot token that the headless backend uses
([engine.md](engine.md)).

## Options

| Option          | Does                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `--family name` | Files every file under this family instead of the one it declares. Use the name a design asks for. |

A design copied from Figma asks for the family Figma shows. `copy` warns
`font missing in Penpot` when the team has no font of that name
([copy.md](copy.md)). Pass that name to `--family`.

## Files

`fonts` takes TrueType (`.ttf`) and OpenType (`.otf`) files. It refuses WOFF and
WOFF2; upload the TTF or OTF the WOFF was made from. Penpot makes the other
formats from the uploaded file.

Penpot draws a variable font at its default instance, so a variable file gives
one weight. `fonts` warns when it adds one. Add the family's static files for
the other weights.
