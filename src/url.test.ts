import { expect, test } from "bun:test";
import { parseUrl, tabMatch } from "./url";

test("a Figma design URL gives the file key and the frame", () => {
  const target = parseUrl(
    "https://www.figma.com/design/WVusOCX9e0MlKX2ZgqJOw4/Feria?node-id=52-2&t=x",
  );
  expect(target).toMatchObject({ tool: "figma", file: "WVusOCX9e0MlKX2ZgqJOw4", frame: "52:2" });
  expect(tabMatch(target)).toBe("/WVusOCX9e0MlKX2ZgqJOw4");
});

test("a Figma URL without a node names no frame", () => {
  expect(parseUrl("https://www.figma.com/file/abc/Name")).not.toHaveProperty("frame");
});

test("a Penpot workspace URL reads from the hash or the query", () => {
  const hash = parseUrl("https://design.penpot.app/#/workspace?team-id=t1&file-id=f1&page-id=p1");
  const query = parseUrl("https://design.penpot.app/?screen=workspace&team-id=t1&file-id=f1");
  expect(hash).toMatchObject({
    tool: "penpot",
    origin: "https://design.penpot.app",
    team: "t1",
    file: "f1",
    page: "p1",
  });
  expect(query).toMatchObject({ tool: "penpot", team: "t1", file: "f1" });
  expect(tabMatch(query)).toBe("file-id=f1");
});

test("any other URL is refused", () => {
  expect(() => parseUrl("https://example.com/design")).toThrow("neither");
});
