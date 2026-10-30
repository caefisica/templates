# Templates

```sh
templates init <url> [--frame F] [--field name=layer]... [--out template.json]
templates render template.json --data rows.csv [--on url] [--format png] [--scale 1] [--out out]
templates check template.json [--on url]
```

`<url>` is a Figma design URL or a Penpot workspace URL. The CLI finds a browser
tab showing that file, or opens one.

## The frame

`F` is a frame id or name from `templates pages <url>`. A Figma URL with a
`node-id` names the frame, so `--frame` is optional there. A Penpot URL does not
name one.

## Fields

`templates layers` lists the frame's visible text layers and layers with an
image fill, numbered, by name path from the frame down:

```
  2  text   Frame 124/Body/Frame 128/Header/Title/Frame 12/23 dE MAYO  "23 dE MAYO"
  9  text   Place/Frame 117/REPLACE NAME ×3  "frente al comedor | frente al comedor un…"
```

A field is a name and one of these paths. `--field` picks one:

| `--field`                            | Field                               |
| ------------------------------------ | ----------------------------------- |
| `date=2`                             | `date`, layer 2 of the listing      |
| `time=Frame 124/Body/Frame 128/Time` | `time`, the layer at that path      |
| `5`                                  | named from the layer's name: `time` |

With no `--field`, every layer whose name starts with `#` is a field: a layer
named `#title` is the field `title`. Name layers that way in the design to make
`init` need no flags.

A field name is lower case letters, digits, `-` or `_`, and starts with a
letter. Two fields cannot share a name.

`×3` means three layers share the path. A field sets all of them.

`init` writes `template.json` and refuses to overwrite it:

```json
{
  "design": "https://www.figma.com/design/WVusOCX9e0MlKX2ZgqJOw4/x?node-id=52-2",
  "frame": { "id": "52:2", "name": "Blue - Ciencias Básicas" },
  "fields": [
    {
      "name": "date",
      "layer": "Frame 124/Body/Frame 128/Header/Title/Frame 12/23 dE MAYO",
      "kind": "text"
    }
  ]
}
```

## Data

`--data` is a `.csv` file with a header row, or a `.json` array of objects. Each
row renders one file.

- A column is a field name. A column that is not a field stops the render and
  lists the fields.
- An empty cell keeps the design's value.
- An image cell is a file path, relative to the data file, or an `http(s)` URL.
  The image is PNG, JPEG or GIF. It fills the layer the way the design's image
  did.
- The `file` column names the output. Without it, row 3 of 12 with the date
  `31 de Octubre` writes `03-31-de-octubre`. Two rows that write one name stop
  the render.

## Render options

| Option     | Default        | Meaning                                         |
| ---------- | -------------- | ----------------------------------------------- |
| `--on`     | the template's | Render another design, such as the Penpot copy. |
| `--format` | `png`          | `png`, `jpg`, `pdf` or `svg`.                   |
| `--scale`  | `1`            | Pixel scale for `png` and `jpg`.                |
| `--out`    | `out`          | Output directory, created when missing.         |

`--on` finds the frame by the template's frame name, so that name must be unique
in the other design.

Each variant is a copy of the frame placed beside it, filled, exported and
deleted. The design is unchanged after a render, and a failed render removes its
copies too.

Figma exports in the browser, in under a second per variant. Penpot exports on
its server: four variants take about 13 seconds. A Penpot SVG links its images
from the Penpot server and does not embed them.

## Check

`check` compares the template with the design's layers. It prints one line per
field whose layer is gone or is no longer the same kind, and exits 1:

```
date: no layer Frame 124/Body/Frame 128/Header/Title/Frame 12/23 dE MAYO
```

Run it with `--on` to confirm that a Penpot copy can render the template.
