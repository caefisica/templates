# Copy to Penpot

```sh
templates copy 'https://www.figma.com/design/<file>/x?node-id=52-2' --to 'https://design.penpot.app/#/workspace?team-id=<team>&file-id=<file>'
```

```
Blue - Ciencias Básicas → Penpot board c35bd1e2-8b4f-8033-8008-defe01a2535c
  warning: ogbu logo: crop image baked to a picture
```

`copy` reads one Figma frame and builds it again as a Penpot board. The board
goes right of everything on the page the Penpot tab shows. Each run makes a new
board and leaves earlier copies alone, so delete the old board before you copy
again.

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
| Text                                 | Text in the font family, nearest weight |
| Solid, linear and radial fills       | The same                                |
| Image fills                          | Image fills                             |
| Angular and diamond fills            | A picture of the fill                   |
| Solid, linear and radial strokes     | The same                                |
| Drop and inner shadows, layer blur   | The same                                |
| Rotation, opacity, blend, hidden     | The same                                |

## Warnings

`copy` prints a warning for each thing it changed or dropped:

| Warning                                       | Meaning                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `crop image baked to a picture`               | A cropped or tiled image became a PNG of the layer's box at 2×.         |
| `gradient_angular paint baked to a picture`   | Penpot has no angular or diamond gradient; the fill became a PNG at 2×. |
| `gradient_angular paint dropped`              | The same fill on a text is not copied.                                  |
| `image stroke dropped`                        | Penpot strokes take no image, angular or diamond paint.                 |
| `background_blur dropped`                     | Penpot has no background blur.                                          |
| `progressive blur dropped`                    | Penpot blurs a layer evenly only.                                       |
| `vector draws nothing, copied as an empty...` | The vector has no visible paint, so it became an empty rectangle.       |
| `mixed text styles flattened to the first`    | A text with several styles takes its first style.                       |
| `font missing in Penpot`                      | Add the font to the Penpot team, then copy again.                       |
| `blend unsupported`                           | Penpot has no such blend mode; the layer blends normally.               |

## Layout boxes

Some layers draw outside the box Figma's auto layout flows. Figma can trim a
text box to its cap height, and Penpot cannot, so the copy keeps the full line
box. A vector is built from its SVG, whose box is what it draws: a line's stroke
or an outside stroke reaches past the node. Inside a flex layout, such a layer
gets negative margins the size of the overhang, so the layout matches Figma
while the layer's own box is larger.
