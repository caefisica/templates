import { expect, test } from "bun:test";
import type { Layer } from "./design";
import { chooseFields, drift, slug } from "./template";

const layers: Layer[] = [
  { path: "Header/#title", kind: "text", value: "Feria", count: 1 },
  { path: "Header/23 dE MAYO", kind: "text", value: "23 dE MAYO", count: 1 },
  { path: "Body/Image", kind: "image", value: "a0cb", count: 1 },
  { path: "Place/Frame 117/REPLACE NAME", kind: "text", value: "FRENTE", count: 3 },
];

test("layers named with # are the fields when none are picked", () => {
  expect(chooseFields(layers, [])).toEqual([
    { name: "title", layer: "Header/#title", kind: "text" },
  ]);
});

test("picks name a layer by number or path, with or without a field name", () => {
  expect(
    chooseFields(layers, ["date=2", "Body/Image", "place=Place/Frame 117/REPLACE NAME"]),
  ).toEqual([
    { name: "date", layer: "Header/23 dE MAYO", kind: "text" },
    { name: "image", layer: "Body/Image", kind: "image" },
    { name: "place", layer: "Place/Frame 117/REPLACE NAME", kind: "text" },
  ]);
});

test("a pick that matches no layer is refused", () => {
  expect(() => chooseFields(layers, ["9"])).toThrow('no editable layer "9"');
});

test("two fields with one name are refused", () => {
  expect(() => chooseFields(layers, ["a=1", "a=2"])).toThrow('two fields are named "a"');
});

test("a design with no # layers and no picks has no fields", () => {
  expect(() => chooseFields(layers.slice(1), [])).toThrow("no fields");
});

test("slug drops accents and punctuation", () => {
  expect(slug("Ciencias Básicas — 23 de Mayo!")).toBe("ciencias-basicas-23-de-mayo");
});

test("drift names missing layers and changed kinds", () => {
  const template = {
    design: "",
    frame: { id: "1:2", name: "Blue" },
    fields: [
      { name: "title", layer: "Header/#title", kind: "text" as const },
      { name: "photo", layer: "Header/23 dE MAYO", kind: "image" as const },
      { name: "gone", layer: "Footer/Logo", kind: "image" as const },
    ],
  };
  expect(drift(template, layers)).toEqual([
    "photo: Header/23 dE MAYO is text, the template says image",
    "gone: no layer Footer/Logo",
  ]);
});

const agenda: Layer[] = [
  { path: "Header/#11", kind: "text", value: "#11", count: 1 },
  { path: "Rows/Frame 103/Frame 102/Carga", kind: "text", value: "Carga", count: 1 },
  { path: "Rows/Frame 103/Votos", kind: "text", value: "Dr. Quispe", count: 1 },
  { path: "Rows/Frame 104/Frame 102/Vacantes", kind: "text", value: "Vacantes", count: 1 },
];

test("a list takes picks by its name, with paths below its row", () => {
  expect(
    chooseFields(
      agenda,
      ["number=1", "agenda.title=2", "agenda.votes=Rows/Frame 103/Votos"],
      ["agenda=Rows/Frame 103"],
    ),
  ).toEqual([
    { name: "number", layer: "Header/#11", kind: "text" },
    {
      name: "agenda",
      layer: "Rows/Frame 103",
      kind: "list",
      fields: [
        { name: "title", layer: "Frame 102/Carga", kind: "text" },
        { name: "votes", layer: "Votos", kind: "text" },
      ],
    },
  ]);
});

test("a # layer that is no field name, such as #11, is not a field", () => {
  expect(() => chooseFields(agenda.slice(0, 1), [])).toThrow("no fields");
});

test("a list field outside its row, a list without fields or a stray list pick is refused", () => {
  const lists = ["agenda=Rows/Frame 103"];
  expect(() => chooseFields(agenda, ["agenda.title=4"], lists)).toThrow(
    "layer Rows/Frame 104/Frame 102/Vacantes is not in list agenda's row",
  );
  expect(() => chooseFields(agenda, ["3", "agenda.title=2"], lists)).toThrow(
    "layer Rows/Frame 103/Votos is in list agenda",
  );
  expect(() => chooseFields(agenda, ["number=1"], lists)).toThrow("list agenda has no fields");
  expect(() => chooseFields(agenda, ["items.title=2"], lists)).toThrow(
    "--field items.title=2 names no list",
  );
  expect(() => chooseFields(agenda, [], ["agenda=Rows/Frame 109"])).toThrow(
    'no editable layer inside "Rows/Frame 109"',
  );
});

test("drift checks a list's row and the layers below it", () => {
  const template = {
    design: "",
    frame: { id: "1:2", name: "Consejo" },
    fields: [
      {
        name: "agenda",
        layer: "Rows/Frame 103",
        kind: "list" as const,
        fields: [
          { name: "title", layer: "Frame 102/Carga", kind: "text" as const },
          { name: "by", layer: "Frame 102/Enviado", kind: "text" as const },
        ],
      },
      { name: "gone", layer: "Rows/Frame 109", kind: "list" as const, fields: [] },
    ],
  };
  expect(drift(template, agenda)).toEqual([
    "agenda.by: no layer Rows/Frame 103/Frame 102/Enviado",
    "gone: no row Rows/Frame 109",
  ]);
});
