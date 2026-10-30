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
