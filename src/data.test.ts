import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan, readRows, type Row, variant } from "./data";
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
  const png = await Bun.file(join(import.meta.dir, "testdata", "3x2.png")).bytes();
  await writeFile(join(dir, "p.png"), png);
  await writeFile(join(dir, "rows.csv"), "date,photo\n31 de Octubre,p.png\n");
  const rows = await readRows(join(dir, "rows.csv"));
  const values = await variant(template, plan(template, rows)[0]!.cells, join(dir, "rows.csv"));
  expect(values).toEqual({
    "Header/23 dE MAYO": { kind: "text", text: "31 de Octubre" },
    "Body/Image": { kind: "image", mime: "image/png", width: 3, height: 2, base64: png.toBase64() },
  });
});

test("an image of another type is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "templates-"));
  await writeFile(join(dir, "p.webp"), "RIFF");
  await expect(variant(template, { photo: "p.webp" }, join(dir, "rows.csv"))).rejects.toThrow(
    "PNG, JPEG or GIF",
  );
});

const consejo: Template = {
  design: "",
  frame: { id: "1:2", name: "Consejo" },
  fields: [
    { name: "number", layer: "Header/#11", kind: "text" },
    {
      name: "agenda",
      layer: "Rows/Frame 103",
      kind: "list",
      fields: [
        { name: "title", layer: "Frame 102/Carga", kind: "text" },
        { name: "by", layer: "Frame 102/Enviado", kind: "text" },
      ],
    },
  ],
};

test("a list cell becomes one value per item and hides what an item leaves out", async () => {
  const cells: Row = { agenda: [{ title: "Carga", by: "DAIMF" }, { title: "Vacantes" }] };
  expect(await variant(consejo, cells, "rows.json")).toEqual({
    "Rows/Frame 103": {
      kind: "list",
      items: [
        {
          "Frame 102/Carga": { kind: "text", text: "Carga" },
          "Frame 102/Enviado": { kind: "text", text: "DAIMF" },
        },
        {
          "Frame 102/Carga": { kind: "text", text: "Vacantes" },
          "Frame 102/Enviado": { kind: "hidden" },
        },
      ],
    },
  });
});

test("a list cell from CSV or with unknown keys is refused", async () => {
  await expect(variant(consejo, { agenda: "Carga" }, "rows.csv")).rejects.toThrow(
    "agenda: a list cell is a JSON array of objects",
  );
  await expect(variant(consejo, { agenda: [{ titel: "x" }] }, "rows.json")).rejects.toThrow(
    "agenda: titel are not fields; the fields are title, by",
  );
});

test("a list cell does not name the output", () => {
  expect(plan(consejo, [{ agenda: [], number: "#13" }]).map((p) => p.file)).toEqual(["1-13"]);
});
