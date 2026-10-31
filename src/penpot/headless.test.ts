import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Variant } from "../design";
import { headless } from "./headless";

const root = "00000000-0000-0000-0000-000000000000";
const shape = (id: string, type: string, parentId: string, shapes: string[] = []) => ({
  id,
  type,
  name: id,
  parentId,
  shapes,
  width: 10.4,
  height: 20,
});
// Page p1 holds boards b1 and b2 and a rect; b2 holds board inner. Page p2 holds b3.
const file = {
  data: {
    pages: ["p1", "p2"],
    pagesIndex: {
      p1: {
        name: "One",
        objects: {
          [root]: shape(root, "frame", root, ["b2", "r", "b1"]),
          b1: shape("b1", "frame", root),
          b2: shape("b2", "frame", root, ["inner"]),
          inner: shape("inner", "frame", "b2"),
          r: shape("r", "rect", root),
        },
      },
      p2: {
        name: "Two",
        objects: { [root]: shape(root, "frame", root, ["b3"]), b3: shape("b3", "frame", root) },
      },
    },
  },
};

const target = {
  tool: "penpot" as const,
  url: "https://penpot.test/#/workspace?team-id=t&file-id=f",
  origin: "https://penpot.test",
  team: "t",
  file: "f",
};

type Request = { url: string; auth: string | null; body: string };
const requests: Request[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  // A stand-in engine that reports what it was given.
  const dir = await mkdtemp(join(tmpdir(), "templates-engine-"));
  await writeFile(
    join(dir, "engine.js"),
    `export const layers = (page, frame) => [{ path: page + " " + frame, kind: "text", value: "", count: 1 }];
     export const render = async (o) => {
       const own = await o.fetch(o.origin + "assets/x");
       const other = await o.fetch("https://fonts.test/a");
       const text = JSON.stringify([o.frame, o.variants, o.format, o.scale, o.wasmDir, o.fontVariants, own !== null, other !== null]);
       return [new TextEncoder().encode(text)];
     };`,
  );
  process.env.TEMPLATES_ENGINE = dir;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    requests.push({ url, auth, body: String(init?.body ?? "") });
    const method = url.split("/").at(-1);
    if (method === "get-file")
      return String(init?.body).includes("gone")
        ? new Response("denied", { status: 403 })
        : Response.json(file);
    if (method === "get-page") return new Response("page:" + String(init?.body));
    if (method === "get-font-variants") return new Response("fonts");
    if (method === "x") return new Response("bytes");
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.TEMPLATES_ENGINE;
});

test("pages list each page's top-level boards in layer order", async () => {
  expect(await headless(target, "k").pages()).toEqual([
    {
      id: "p1",
      name: "One",
      frames: [
        { id: "b2", name: "b2", w: 10, h: 20 },
        { id: "b1", name: "b1", w: 10, h: 20 },
      ],
    },
    { id: "p2", name: "Two", frames: [{ id: "b3", name: "b3", w: 10, h: 20 }] },
  ]);
  expect(requests.at(-1)).toMatchObject({
    url: "https://penpot.test/api/main/methods/get-file",
    auth: "Token k",
  });
});

test("a frame is found at any depth on any page, and only a board", async () => {
  const backend = headless(target, "k");
  expect(await backend.frame("inner")).toEqual({ id: "inner", name: "inner", w: 10, h: 20 });
  expect(await backend.frame("b3")).toMatchObject({ id: "b3" });
  expect(await backend.frame("r")).toBeNull();
  expect(await backend.frame("1:2")).toBeNull();
});

test("layers read the page of the frame's top-level board", async () => {
  const [layer] = await headless(target, "k").layers("inner");
  expect(layer!.path).toBe(
    'page:["^ ","~:file-id","~uf","~:page-id","~up1","~:object-id",["~#set",["~ub2"]]] inner',
  );
});

test("render yields one export per variant and signs only its own asset requests", async () => {
  const out: string[] = [];
  const variants: Variant[] = [{ a: { kind: "hidden" } }, {}];
  for await (const bytes of headless(target, "k").render("b3", variants, "png", 2))
    out.push(new TextDecoder().decode(bytes));
  expect(out.map((o) => JSON.parse(o))).toEqual([
    ["b3", [variants[0]], "png", 2, process.env.TEMPLATES_ENGINE, "fonts", true, false],
    ["b3", [variants[1]], "png", 2, process.env.TEMPLATES_ENGINE, "fonts", true, false],
  ]);
  const auth = (url: string) => requests.findLast((r) => r.url === url)!.auth;
  expect(auth("https://penpot.test/assets/x")).toBe("Token k");
  expect(auth("https://fonts.test/a")).toBeNull();
});

test("an RPC error names the method and status", async () => {
  await expect(headless({ ...target, file: "gone" }, "k").pages()).rejects.toThrow(
    "Penpot get-file: 403 denied",
  );
});

test("a frame missing from the file is refused", async () => {
  await expect(headless(target, "k").layers("zz")).rejects.toThrow("no frame zz in this file");
});
