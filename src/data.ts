// Turns data rows into the variants a template renders. A row's columns are
// field names, plus an optional "file" column that names the output. An empty
// cell keeps the design's value. An image cell is a file path, relative to the
// data file, or an http(s) URL. A list cell is a JSON array of objects, one
// per row, keyed by the list's field names; a field an item leaves out is
// hidden in that row.

import { dirname, extname, resolve } from "node:path";
import { parse } from "csv-parse/sync";
import type { Value, Variant } from "./design";
import { slug, type Leaf, type Template } from "./template";

export type Cell = string | Record<string, string>[];

export type Row = Record<string, Cell>;

export type Plan = { file: string; cells: Row };

export async function readRows(path: string): Promise<Row[]> {
  const text = await Bun.file(path).text();
  if (extname(path) === ".json") return JSON.parse(text);
  if (extname(path) === ".csv")
    return parse(text, { columns: true, skip_empty_lines: true, bom: true, trim: true });
  throw new Error(`${path}: data must be a .csv or .json file`);
}

export function plan(template: Template, rows: Row[]): Plan[] {
  const names = new Set(template.fields.map((f) => f.name));
  const unknown = Object.keys(rows[0] ?? {}).filter(
    (column) => column !== "file" && !names.has(column),
  );
  if (unknown.length)
    throw new Error(
      `columns ${unknown.join(", ")} are not fields; the fields are ${[...names].join(", ")}`,
    );
  const width = String(rows.length).length;
  const files = rows.map((row, i) => {
    const cells = Object.fromEntries(
      Object.entries(row).filter(
        ([column, cell]) => column !== "file" && (Array.isArray(cell) || String(cell ?? "") !== ""),
      ),
    );
    const firstText = template.fields.find(
      (f) => f.kind === "text" && typeof cells[f.name] === "string",
    );
    const named =
      (row.file as string) ||
      [String(i + 1).padStart(width, "0"), firstText && slug(cells[firstText.name] as string)]
        .filter(Boolean)
        .join("-");
    return { file: named, cells };
  });
  const repeated = files.find((p, i) => files.findIndex((q) => q.file === p.file) !== i);
  if (repeated) throw new Error(`two rows write ${repeated.file}; give them distinct "file" cells`);
  return files;
}

// Reads a plan's cells into layer values, loading image files and URLs.
export async function variant(template: Template, cells: Row, dataPath: string): Promise<Variant> {
  const out: Variant = {};
  for (const f of template.fields) {
    const cell = cells[f.name];
    if (cell === undefined) continue;
    if (f.kind !== "list") {
      if (typeof cell === "object")
        throw new Error(`${f.name}: a ${f.kind} cell is text, not a list`);
      out[f.layer] = await leaf(f, String(cell), dataPath);
      continue;
    }
    if (!Array.isArray(cell))
      throw new Error(`${f.name}: a list cell is a JSON array of objects; use a .json data file`);
    const items = cell.map(async (item) => {
      const names = new Set(f.fields.map((sub) => sub.name));
      const unknown = Object.keys(item).filter((key) => !names.has(key));
      if (unknown.length)
        throw new Error(
          `${f.name}: ${unknown.join(", ")} are not fields; the fields are ${[...names].join(", ")}`,
        );
      const values: Variant = {};
      for (const sub of f.fields) {
        const text = String(item[sub.name] ?? "");
        values[sub.layer] = text === "" ? { kind: "hidden" } : await leaf(sub, text, dataPath);
      }
      return values;
    });
    out[f.layer] = { kind: "list", items: await Promise.all(items) };
  }
  return out;
}

function leaf(f: Leaf, cell: string, dataPath: string): Promise<Value> | Value {
  return f.kind === "text" ? { kind: "text", text: cell } : image(cell, dirname(dataPath));
}

async function image(cell: string, base: string): Promise<Value> {
  const remote = /^https?:\/\//.test(cell);
  const data = remote
    ? new Uint8Array(await (await fetch(cell)).arrayBuffer())
    : await Bun.file(resolve(base, cell)).bytes();
  const mime = sniff(data);
  // Figma and Penpot both take these three; anything else is converted first.
  if (!mime) throw new Error(`${cell}: images must be PNG, JPEG or GIF`);
  return { kind: "image", mime, base64: data.toBase64() };
}

function sniff(data: Uint8Array): string | null {
  if (data[0] === 0x89 && data[1] === 0x50) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data[0] === 0x47 && data[1] === 0x49) return "image/gif";
  return null;
}
