// Turns data rows into the variants a template renders. A row's columns are
// field names, plus an optional "file" column that names the output. An empty
// cell keeps the design's value. An image cell is a file path, relative to the
// data file, or an http(s) URL.

import { dirname, extname, resolve } from "node:path";
import { parse } from "csv-parse/sync";
import type { Value, Variant } from "./design";
import { slug, type Template } from "./template";

export type Row = Record<string, string>;

export type Plan = { file: string; cells: Record<string, string> };

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
        ([column, cell]) => column !== "file" && String(cell ?? "") !== "",
      ),
    );
    const firstText = template.fields.find((f) => f.kind === "text" && cells[f.name]);
    const named =
      row.file ||
      [String(i + 1).padStart(width, "0"), firstText && slug(cells[firstText.name]!)]
        .filter(Boolean)
        .join("-");
    return { file: named, cells };
  });
  const repeated = files.find((p, i) => files.findIndex((q) => q.file === p.file) !== i);
  if (repeated) throw new Error(`two rows write ${repeated.file}; give them distinct "file" cells`);
  return files;
}

// Reads a plan's cells into layer values, loading image files and URLs.
export async function variant(
  template: Template,
  cells: Record<string, string>,
  dataPath: string,
): Promise<Variant> {
  const out: Variant = {};
  for (const f of template.fields) {
    const cell = cells[f.name];
    if (cell === undefined) continue;
    out[f.layer] =
      f.kind === "text" ? { kind: "text", text: cell } : await image(cell, dirname(dataPath));
  }
  return out;
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
