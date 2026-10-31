// A template is one frame of a design and the layers a data row may change.
// Fields address layers by name path, not id, so a template made on a Figma
// frame also renders the Penpot copy of that frame.

import type { Layer } from "./design";

export type Leaf = { name: string; layer: string; kind: "text" | "image" };

// A list's `layer` is the path of one row; its fields' layers are paths below
// that row.
export type List = { name: string; layer: string; kind: "list"; fields: Leaf[] };

export type Field = Leaf | List;

// `frame.id`, with `frame.page` on Penpot, pins the frame on `design`; on another
// design the name finds it.
export type Template = {
  design: string;
  frame: { id: string; name: string; page?: string };
  fields: Field[];
};

// A layer named "#title" is the field "title"; "#11" is no field name and is
// skipped. These are the template's
// fields unless `picks` names them instead. A pick is "name=layer" or a bare
// layer, where layer is a path or a 1-based number from the layer listing.
// `lists` are "name=row path"; a pick "list.name=layer" adds a field to that
// list, and a list with no picks takes the "#" layers in its row.
export function chooseFields(layers: Layer[], picks: string[], lists: string[] = []): Field[] {
  const rows = lists.map((pick) => {
    const [name, row] = pick.split(/=(.*)/s) as [string, string | undefined];
    if (!row) throw new Error(`--list ${pick} needs a row path: --list name=row path`);
    if (!layers.some((l) => l.path.startsWith(`${row}/`)))
      throw new Error(`no editable layer inside "${row}"; a list names a row that holds some`);
    return { name: checkName(name), row };
  });
  const under = (row: string) => (layer: Layer) => layer.path.startsWith(`${row}/`);
  const [listPicks, plain] = partition(picks, (pick) =>
    rows.some((r) => pick.startsWith(`${r.name}.`)),
  );
  const stray = plain.find((pick) => /^[a-z][a-z0-9_-]*\.[^=/]*=/.test(pick));
  if (stray) throw new Error(`--field ${stray} names no list; add it with --list name=row path`);
  const top = leaves(layers, plain, (layer) => {
    const list = rows.find((r) => under(r.row)(layer));
    return list && `is in list ${list.name}; pick it with --field ${list.name}.name=layer`;
  });
  const listed = rows.map(({ name, row }): List => {
    const picked = listPicks
      .filter((p) => p.startsWith(`${name}.`))
      .map((p) => p.slice(name.length + 1));
    const outside = (layer: Layer) => !under(row)(layer) && `is not in list ${name}'s row`;
    const fields = leaves(layers, picked, outside).map((f) => ({
      ...f,
      layer: f.layer.slice(row.length + 1),
    }));
    if (fields.length === 0)
      throw new Error(`list ${name} has no fields; pick them with --field ${name}.name=layer`);
    unique(fields, `--field ${name}.name=layer`);
    return { name, layer: row, kind: "list", fields };
  });
  const fields = [...top, ...listed];
  if (fields.length === 0)
    throw new Error('no fields: name layers "#field" in the design, or pick them with --field');
  unique(fields, "--field name=layer");
  return fields;
}

// `refuse` says why a layer cannot be one of these fields, or nothing. Numbers
// count from the full listing, so they match what the layers command prints.
function leaves(
  layers: Layer[],
  picks: string[],
  refuse: (layer: Layer) => string | false | undefined,
): Leaf[] {
  if (picks.length === 0)
    return layers
      .filter((layer) => !refuse(layer) && /^#[a-z][a-z0-9_-]*$/.test(leaf(layer.path)))
      .map((layer) => field(leaf(layer.path).slice(1), layer));
  return picks.map((pick) => {
    const [name, selector] = pick.includes("=")
      ? (pick.split(/=(.*)/s) as [string, string])
      : [null, pick];
    const layer = select(layers, selector);
    const reason = refuse(layer);
    if (reason) throw new Error(`layer ${layer.path} ${reason}`);
    return field(name ?? slug(leaf(layer.path)), layer);
  });
}

function unique(fields: Field[], hint: string) {
  const names = fields.map((f) => f.name);
  const repeated = names.find((name, i) => names.indexOf(name) !== i);
  if (repeated)
    throw new Error(`two fields are named "${repeated}"; give one another name with ${hint}`);
}

function partition<T>(items: T[], test: (item: T) => boolean): [T[], T[]] {
  return [items.filter(test), items.filter((item) => !test(item))];
}

function select(layers: Layer[], selector: string): Layer {
  const layer = /^\d+$/.test(selector)
    ? layers[Number(selector) - 1]
    : layers.find((l) => l.path === selector);
  if (!layer) throw new Error(`no editable layer "${selector}"; list them with the layers command`);
  return layer;
}

function field(name: string, layer: Layer): Leaf {
  return { name: checkName(name), layer: layer.path, kind: layer.kind };
}

function checkName(name: string): string {
  if (!/^[a-z][a-z0-9_-]*$/.test(name))
    throw new Error(`field name "${name}" must be lower case letters, digits, "-" or "_"`);
  return name;
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
    if (f.kind !== "list") return leafDrift(f.name, f, layers);
    if (!layers.some((l) => l.path.startsWith(`${f.layer}/`)))
      return [`${f.name}: no row ${f.layer}`];
    return f.fields.flatMap((sub) =>
      leafDrift(`${f.name}.${sub.name}`, { ...sub, layer: `${f.layer}/${sub.layer}` }, layers),
    );
  });
}

function leafDrift(name: string, f: Leaf, layers: Layer[]): string[] {
  const layer = layers.find((l) => l.path === f.layer);
  if (!layer) return [`${name}: no layer ${f.layer}`];
  if (layer.kind !== f.kind)
    return [`${name}: ${f.layer} is ${layer.kind}, the template says ${f.kind}`];
  return [];
}
