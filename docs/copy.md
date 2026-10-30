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

| Figma                                 | Penpot                                  |
| ------------------------------------- | --------------------------------------- |
| Frame, component, instance            | Board; components lose their link       |
| Auto layout and child sizing          | Flex layout                             |
| Group, mask group                     | Group, mask                             |
| Rectangle, ellipse                    | Rectangle, ellipse                      |
| Vector, boolean, star, line, polygon  | Shapes built from the node's SVG        |
| Text                                  | Text in the font family, nearest weight |
| Solid and image fills                 | Solid and image fills                   |
| Solid strokes, drop and inner shadows | Strokes and shadows                     |
| Rotation, opacity, blend, hidden      | The same                                |

## Warnings

`copy` prints a warning for each thing it changed or dropped:

| Warning                                    | Meaning                                                   |
| ------------------------------------------ | --------------------------------------------------------- |
| `crop image baked to a picture`            | A cropped or tiled image became a flat PNG at 2×.         |
| `gradient_linear paint dropped`            | Gradients and other non-solid paints are not copied.      |
| `layer_blur dropped`                       | Blur effects are not copied.                              |
| `mixed text styles flattened to the first` | A text with several styles takes its first style.         |
| `font missing in Penpot`                   | Add the font to the Penpot team, then copy again.         |
| `blend unsupported`                        | Penpot has no such blend mode; the layer blends normally. |

## Text boxes

Figma can trim a text box to its cap height. Penpot cannot, so the copy keeps
the full line box. A text inside a flex layout gets negative margins the size of
the trim, so the layout matches Figma while the text's own box is taller.
