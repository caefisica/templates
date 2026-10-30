import { expect, test } from "bun:test";
import { pick, sketch } from "./sketch";

test("long arrays show the first items and a count", () => {
  expect(sketch({ frames: [1, 2, 3, 4, 5] }, { depth: 4, items: 2, text: 60 })).toBe(
    "{ frames: [1, 2, … 3 more] }",
  );
});

test("a value too wide for one line breaks across lines", () => {
  const wide = { a: "x".repeat(40), b: "y".repeat(40) };
  expect(sketch(wide).split("\n")).toHaveLength(4);
});

test("long strings are cut with their length", () => {
  expect(sketch("abcdef", { depth: 4, items: 3, text: 3 })).toBe('"abc… (6 chars)"');
});

test("nesting past the depth lists keys only", () => {
  const deep = { a: { b: { c: "z".repeat(50) } }, d: "w".repeat(40) };
  expect(sketch(deep, { depth: 1, items: 3, text: 60 })).toContain("a: {… b}");
});

test("pick follows a dotted path through arrays", () => {
  expect(pick({ kids: [{ name: "Title" }] }, "kids.0.name")).toBe("Title");
});
