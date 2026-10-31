import { expect, test } from "bun:test";
import type { FrameInfo } from "./design";
import { frameRuns, pickPage } from "./frames";

const frame = (id: string, name: string, section?: string): FrameInfo => ({
  id,
  name,
  w: 1080,
  h: 1080,
  ...(section ? { section } : {}),
});

test("neighbouring frames with one name, size and section form one run", () => {
  const runs = frameRuns([
    frame("1", "Slide", "Deck"),
    frame("2", "Slide", "Deck"),
    frame("3", "Slide", "Other"),
    frame("4", "Cover", "Deck"),
    frame("5", "Slide", "Deck"),
  ]);
  expect(runs.map((r) => [r.first.id, r.count])).toEqual([
    ["1", 2],
    ["3", 1],
    ["4", 1],
    ["5", 1],
  ]);
});

test("a page is picked by id or name, and a missing one lists the names", () => {
  const pages = [
    { id: "0:1", name: "Page 1", frames: [] },
    { id: "4:1", name: "tests", frames: [] },
  ];
  expect(pickPage(pages, "tests").id).toBe("4:1");
  expect(pickPage(pages, "0:1").name).toBe("Page 1");
  expect(() => pickPage(pages, "x")).toThrow("the pages are Page 1, tests");
});
