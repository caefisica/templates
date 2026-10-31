# Copy to Penpot

```sh
templates copy 'https://www.figma.com/design/<file>/x?node-id=52-2' --to 'https://design.penpot.app/#/workspace?team-id=<team>&file-id=<file>'
```

```
Blue - Ciencias Básicas → Penpot board 9151ea3d-37d3-8010-8008-df1598554186
  warning: ogbu logo: crop image baked to a picture
```

`copy` reads one Figma frame and builds it again as a Penpot board on the page
the Penpot tab shows. The board records its Figma file and frame in Penpot
shared plugin data. Copy the same frame again and the new board takes the old
board's place, and the old board is deleted; the output ends with
`, replacing <id>`. A first copy goes right of everything on the page. Edits
made in Penpot to a copied board are lost on the next copy.

A template made on the Figma frame renders the copy with `--on`, because fields
address layers by name path. Confirm it first:

```sh
templates check template.json --on '<penpot url>'
```

## What carries over

| Figma                                | Penpot                                  |
| ------------------------------------ | --------------------------------------- |
| Frame, component, instance           | Board; components lose their link       |
| Auto layout and child sizing         | Flex layout                             |
| Group, mask group                    | Group, mask                             |
| Rectangle, ellipse                   | Rectangle, ellipse                      |
| Vector, boolean, star, line, polygon | Shapes built from the node's SVG        |
| Text, and each styled run in it      | Text in the font family, nearest weight |
| Solid, linear and radial fills       | The same                                |
| Image fills                          | Image fills                             |
| Angular and diamond fills            | A picture of the fill                   |
| Solid, linear and radial strokes     | The same                                |
| Drop and inner shadows, layer blur   | The same                                |
| Rotation, opacity, blend, hidden     | The same                                |

## Warnings

`copy` prints a warning for each thing it changed or dropped:

| Warning                                        | Meaning                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `crop image baked to a picture`                | A cropped or tiled image became a PNG of the layer's box at 2×.                          |
| `gradient_angular paint baked to a picture`    | Penpot has no angular or diamond gradient; the fill became a PNG at 2×.                  |
| `gradient_angular paint dropped`               | The same fill on a text is not copied.                                                   |
| `image stroke dropped`                         | Penpot strokes take no image, angular or diamond paint.                                  |
| `background_blur dropped`                      | Penpot has no background blur.                                                           |
| `progressive blur dropped`                     | Penpot blurs a layer evenly only.                                                        |
| `vector draws nothing, copied as an empty...`  | The vector has no visible paint, so it became an empty rectangle.                        |
| `mixed line height or letter spacing flatt...` | A text whose runs differ in line height or letter spacing takes the first run's.         |
| `paragraph indent dropped`                     | Penpot has no first-line indent; the first line starts at the margin.                    |
| `list numbers and bullets dropped`             | Penpot texts have no list style; the paragraphs lose their numbers and bullets.          |
| `font ... not loadable, cap-height trim ...`   | Figma on this machine lacks the font, so a trimmed text keeps its box.                   |
| `font ... not loadable, auto line height ...`  | Figma on this machine lacks the font, so an auto line height becomes 1.2.                |
| `font missing in Penpot`                       | Add the font to the Penpot team, then copy again.                                        |
| `blend unsupported`                            | Penpot has no such blend mode; the layer blends normally.                                |
| `linear burn blend drawn as multiply`          | CSS has no linear burn or dodge; they become multiply and screen.                        |
| `overlay paint drawn normal`                   | A paint blends over the layer's other paints and the layers below; it is drawn normal.   |
| `overlay paint over other paints dropped`      | In a layer that does not pass through, a paint that blends over other paints is dropped. |
| `shadow dropped so the blends inside reach...` | Penpot's shadow isolates a layer; the shadow goes so blends inside see what is below.    |

## Blends

Figma can give a single paint its own blend mode. Penpot blends whole layers.
When every blended paint on a pass-through layer shares one mode, the layer
takes that mode. A frame hands its paints to a rectangle behind its children, so
the children do not blend.

Penpot isolates a board that clips or casts a shadow: a layer inside it blends
with nothing outside the board. Figma's frames do not isolate. A frame that
holds a blend keeps its clip only when the clip cuts something, and it loses its
shadow.

## Layout boxes

Some layers draw outside the box Figma's auto layout flows. Figma can trim a
text box to its cap height, and Penpot cannot, so the copy keeps the full line
box. A vector is built from its SVG, whose box is what it draws: a line's stroke
or an outside stroke reaches past the node. Inside a flex layout, such a layer
gets negative margins the size of the overhang, so the layout matches Figma
while the layer's own box is larger.
