import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan, readRows, variant } from "./data";
import type { Template } from "./template";

const template: Template = {
  design: "",
  frame: { id: "1:2", name: "Blue" },
  fields: [
    { name: "date", layer: "Header/23 dE MAYO", kind: "text" },
    { name: "photo", layer: "Body/Image", kind: "image" },
  ],
};

test("rows name their outputs by number and first text field", () => {
  expect(plan(template, [{ date: "31 de Octubre" }, { date: "" }]).map((p) => p.file)).toEqual([
    "1-31-de-octubre",
    "2",
  ]);
});

test("a file column names the output and is not a field", () => {
  expect(plan(template, [{ file: "lima", date: "x" }])).toEqual([
    { file: "lima", cells: { date: "x" } },
  ]);
});

test("an unknown column is refused with the field names", () => {
  expect(() => plan(template, [{ dte: "x" }])).toThrow(
    "columns dte are not fields; the fields are date, photo",
  );
});

test("two rows writing one file are refused", () => {
  expect(() => plan(template, [{ file: "a" }, { file: "a" }])).toThrow("two rows write a");
});

test("cells become layer values and image paths load relative to the data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "templates-"));
  await writeFile(join(dir, "p.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(dir, "rows.csv"), "date,photo\n31 de Octubre,p.png\n");
  const rows = await readRows(join(dir, "rows.csv"));
  const values = await variant(template, plan(template, rows)[0]!.cells, join(dir, "rows.csv"));
  expect(values).toEqual({
    "Header/23 dE MAYO": { kind: "text", text: "31 de Octubre" },
    "Body/Image": { kind: "image", mime: "image/png", base64: "iVBORw==" },
  });
});

test("an image of another type is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "templates-"));
  await writeFile(join(dir, "p.webp"), "RIFF");
  await expect(variant(template, { photo: "p.webp" }, join(dir, "rows.csv"))).rejects.toThrow(
    "PNG, JPEG or GIF",
  );
});
