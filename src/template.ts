// A template is one frame of a design and the layers a data row may change.
// Fields address layers by name path, not id, so a template made on a Figma
// frame also renders the Penpot copy of that frame.

import type { Layer } from "./design";

export type Field = { name: string; layer: string; kind: "text" | "image" };

// `frame.id` pins the frame on `design`; on another design the name finds it.
export type Template = { design: string; frame: { id: string; name: string }; fields: Field[] };

// A layer named "#title" is the field "title". These are the template's
// fields unless `picks` names them instead. A pick is "name=layer" or a bare
// layer, where layer is a path or a 1-based number from the layer listing.
export function chooseFields(layers: Layer[], picks: string[]): Field[] {
  const fields =
    picks.length === 0
      ? layers
          .filter((layer) => leaf(layer.path).startsWith("#"))
          .map((layer) => field(leaf(layer.path).slice(1), layer))
      : picks.map((pick) => {
          const [name, selector] = pick.includes("=")
            ? (pick.split(/=(.*)/s) as [string, string])
            : [null, pick];
          const layer = select(layers, selector);
          return field(name ?? slug(leaf(layer.path)), layer);
        });
  if (fields.length === 0)
    throw new Error('no fields: name layers "#field" in the design, or pick them with --field');
  const names = fields.map((f) => f.name);
  const repeated = names.find((name, i) => names.indexOf(name) !== i);
  if (repeated)
    throw new Error(
      `two fields are named "${repeated}"; give one another name with --field name=layer`,
    );
  return fields;
}

function select(layers: Layer[], selector: string): Layer {
  const layer = /^\d+$/.test(selector)
    ? layers[Number(selector) - 1]
    : layers.find((l) => l.path === selector);
  if (!layer) throw new Error(`no editable layer "${selector}"; list them with the layers command`);
  return layer;
}

function field(name: string, layer: Layer): Field {
  if (!/^[a-z][a-z0-9_-]*$/.test(name))
    throw new Error(`field name "${name}" must be lower case letters, digits, "-" or "_"`);
  return { name, layer: layer.path, kind: layer.kind };
}

const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// Fields whose layer is missing from, or of another kind in, a design's layers.
export function drift(template: Template, layers: Layer[]): string[] {
  return template.fields.flatMap((f) => {
    const layer = layers.find((l) => l.path === f.layer);
    if (!layer) return [`${f.name}: no layer ${f.layer}`];
    if (layer.kind !== f.kind)
      return [`${f.name}: ${f.layer} is ${layer.kind}, the template says ${f.kind}`];
    return [];
  });
}
