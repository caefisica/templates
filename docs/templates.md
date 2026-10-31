# Templates

```sh
templates init <url> [--frame F] [--field name=layer]... [--list name=row]... [--out template.json]
templates render template.json --data rows.csv|rows.json [--on url] [--format png] [--scale 1] [--out out]
templates check template.json [--on url]
```

`<url>` is a Figma design URL or a Penpot workspace URL. With a Penpot token the
CLI reads a Penpot file over the API; see [engine.md](engine.md). Otherwise it
finds a browser tab showing that file, or opens one.

## The frame

`F` is a frame id or name from `templates pages <url>`. A Figma URL with a
`node-id` names the frame, so `--frame` is optional there. A Penpot URL does not
name one.

An id also names a frame inside another frame, such as one card of a board that
holds many. In a Penpot tab the board must be on the open page. A name matches
the frames `pages` lists only.

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

## Lists

A list is a row the design repeats with different text, such as the items of an
agenda. `--list` names the row by its path, and `--field list.name=layer` picks
a layer inside it:

```sh
templates init '<url>' --field number=2 --field date=4 --field place=6 \
  --list 'agenda=Frame 125/Auto Layout Vertical/Auto Layout Vertical/Auto Layout Vertical/Frame 103' \
  --field agenda.title=9 --field agenda.by=10 --field agenda.votes=11
```

```
  agenda       list   Frame 125/Auto Layout Vertical/Auto Layout Vertical/Auto Layout Vertical/Frame 103
    title      text   Frame 102/Carga académica de docentes DAIMF 2024-1
    by         text   Frame 102/Enviado por el Departamento del DAIMF
    votes      text   Votos
```

A list field's layer is its path below the row. A layer inside the row cannot be
a plain field, and a list field must be inside its row.

The data cell of a list is an array of objects, one per row, keyed by the list's
field names, so the data file is JSON:

```json
{
  "number": "#14",
  "agenda": [
    { "title": "Estancia Académica 2024-2", "votes": "Dr. Carlos Solano" }
  ]
}
```

The render removes the row's siblings of the same layer type, which are the
design's other example rows, and puts one copy of the row per item in their
place. An item that leaves a field out or empty hides that layer. In Figma, a
text whose auto layout spaces its children between them is emptied instead, so
the other children keep their places.

The rows stack only inside an auto layout (Figma) or flex layout (Penpot). The
frame keeps its height unless it hugs its contents, so a longer list on a
fixed-height frame is cut off at the bottom.

Figma keeps the count of a numbered-list text inside the text, where a plugin
cannot set it, so every copy of a numbered row shows the row's own number.
Penpot has no numbered lists. Turn the list style off and put the numbers in the
data.

## Data

`--data` is a `.csv` file with a header row, or a `.json` array of objects. Each
row renders one file.

- A list field's cell is a JSON array; see [Lists](#lists).
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

In a tab, each variant is a copy of the frame placed beside it, filled, exported
and deleted. The design is unchanged after a render, and a failed render removes
its copies too. Figma exports in the browser, in under a second per variant. A
Penpot tab exports on Penpot's server: four variants take about 13 seconds, and
an SVG links its images from the server instead of embedding them.

Over the API, Penpot renders on your machine and never edits the design. Two
variants of a 1080×770 card take under two seconds.

## Check

`check` compares the template with the design's layers. It prints one line per
field whose layer is gone or is no longer the same kind, and exits 1:

```
date: no layer Frame 124/Body/Frame 128/Header/Title/Frame 12/23 dE MAYO
```

Run it with `--on` to confirm that a Penpot copy can render the template.
