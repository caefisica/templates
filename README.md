# templates

Turn a Figma or Penpot frame into a template and render one image per data row.
A template names the text and image layers that may change. `render` fills them
from a CSV or JSON file and exports each row as PNG, JPEG, PDF or SVG. `copy`
rebuilds a Figma frame in Penpot, and one template renders from either.

The CLI drives your own browser over the Chrome DevTools Protocol. It calls the
plugin API that the Figma editor and the Penpot workspace load into the page, so
it needs no API token and no installed plugin. Figma needs edit access to the
file.

## Install

```sh
bun add -g github:caefisica/templates
```

This puts `templates` in the directory `bun pm bin -g` prints; add it to `PATH`.
From a checkout, `mise run install` and `bun link` do the same. Start Chrome
with `--remote-debugging-port=9222` and log in to Figma and Penpot. Set
`CDP_URL` when the port is elsewhere.

## Example

```sh
templates layers 'https://www.figma.com/design/WVusOCX9e0MlKX2ZgqJOw4/x?node-id=52-2'
```

```
  1  text   Frame 124/Body/Frame 128/Header/Title/Frame 12/feria laboral 3x  "feria laboral\n3x"
  2  text   Frame 124/Body/Frame 128/Header/Title/Frame 12/23 dE MAYO  "23 dE MAYO"
  3  image  Frame 124/Body/Frame 128/Frame 126/Frame 127/Group 653/Image
  4  text   Frame 124/Body/Frame 128/Frame 126/Frame 127/Description  "Conecta con +50 empresas de diversas ind…"
  5  text   Frame 124/Body/Frame 128/Time  "09:00 AM - 02:00 PM"
  6  text   Frame 124/Footer/Frame 125/LEARN MORE  "organizado por"
  7  image  Frame 124/Footer/Frame 125/Frame 118/logo sm
  8  image  Frame 124/Footer/Frame 125/Frame 118/ogbu logo
  9  text   Place/Frame 117/REPLACE NAME ×3  "frente al comedor | frente al comedor un…"
```

```sh
templates init '<figma url>' --field title=1 --field date=2 --field photo=3 --field time=5 --field place=9
templates render template.json --data rows.csv
```

`rows.csv` holds one column per field and an optional `file` column:

```csv
file,title,date,photo,time,place
lima,"feria laboral
4x",31 dE OCTUBRE,photo.png,10:00 AM - 06:00 PM,auditorio principal
```

This writes `out/lima.png`.

## Commands

| Command                                          | Does                                                |
| ------------------------------------------------ | --------------------------------------------------- |
| `pages <url> [--page P]`                         | Lists pages and their top-level frames.             |
| `layers <url> [--frame F]`                       | Lists the frame's visible text and image layers.    |
| `init <url> [--frame F] [--field name=layer]...` | Writes `template.json`.                             |
| `render <template> --data <rows>`                | Renders one file per row.                           |
| `check <template> [--on url]`                    | Reports fields whose layer is gone or changed kind. |
| `copy <figma-url> --to <penpot-url>`             | Rebuilds the Figma frame as a board in Penpot.      |

## Documentation

- [docs/templates.md](docs/templates.md): fields, data rows and render options.
- [docs/copy.md](docs/copy.md): copying a design from Figma to Penpot.
- [docs/readme.md](docs/readme.md): the whole manual.
