import { afterAll, beforeEach, expect, test } from "bun:test";
import { addFont, teamFonts } from "./fonts";
import { rpc } from "./rpc";

type Call = { method: string; auth: string | null; type: string | null; body: unknown };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: string, init: RequestInit) => {
    const method = String(input).split("/").at(-1)!;
    const headers = new Headers(init.headers);
    const body =
      init.body instanceof FormData
        ? Object.fromEntries(init.body.entries())
        : JSON.parse(String(init.body));
    calls.push({
      method,
      auth: headers.get("authorization"),
      type: headers.get("content-type"),
      body,
    });
    if (method === "get-font-variants")
      return Response.json([
        { fontId: "f1", fontFamily: "Satoshi", fontWeight: 400, fontStyle: "normal" },
      ]);
    if (method === "create-upload-session") return Response.json({ sessionId: "s1" });
    if (method === "upload-chunk") return Response.json({ sessionId: "s1", index: 0 });
    if (method === "create-font-variant") return new Response("[]");
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

const api = rpc("https://penpot.test", "k");
const otf = { mtype: "font/otf" as const, variable: false };

test("team fonts read get-font-variants for the team", async () => {
  expect(await teamFonts(api, "t")).toEqual([
    { fontId: "f1", family: "Satoshi", weight: 400, style: "normal" },
  ]);
  expect(calls).toEqual([
    {
      method: "get-font-variants",
      auth: "Token k",
      type: "application/json",
      body: { teamId: "t" },
    },
  ]);
});

test("a new weight of a family the team has joins its font id", async () => {
  const existing = await teamFonts(api, "t");
  calls = [];
  const bytes = new Uint8Array(21 * 1024 * 1024).fill(7);
  const font = { ...otf, family: "Satoshi", weight: 900, style: "normal" as const };
  expect(await addFont(api, "t", bytes, font, existing)).toEqual({
    fontId: "f1",
    family: "Satoshi",
    weight: 900,
    style: "normal",
  });
  expect(calls.map((c) => c.method)).toEqual([
    "create-upload-session",
    "upload-chunk",
    "upload-chunk",
    "upload-chunk",
    "create-font-variant",
  ]);
  expect(calls[0]!.body).toEqual({ totalChunks: 3 });
  const chunks = calls.slice(1, 4).map((c) => c.body as Record<string, any>);
  expect(chunks.map((c) => [c["session-id"], c.index, c.content.size, c.content.type])).toEqual([
    ["s1", "0", 10 * 1024 * 1024, "font/otf"],
    ["s1", "1", 10 * 1024 * 1024, "font/otf"],
    ["s1", "2", 1024 * 1024, "font/otf"],
  ]);
  expect(calls[4]).toMatchObject({ type: "application/transit+json" });
  expect(calls[4]!.body).toEqual([
    "^ ",
    "~:team-id",
    "~ut",
    "~:font-id",
    "~uf1",
    "~:font-family",
    "Satoshi",
    "~:font-weight",
    900,
    "~:font-style",
    "normal",
    "~:uploads",
    ["^ ", "font/otf", "~us1"],
  ]);
});

test("a new family gets a new font id", async () => {
  const font = { ...otf, family: "Other", weight: 400, style: "normal" as const };
  const added = await addFont(api, "t", new Uint8Array(8), font, await teamFonts(api, "t"));
  expect(added!.fontId).toMatch(/^[0-9a-f-]{36}$/);
  expect((calls.at(-1)!.body as unknown[])[4]).toBe(`~u${added!.fontId}`);
});

test("a weight and style the team has is not uploaded again", async () => {
  const font = { ...otf, family: "Satoshi", weight: 400, style: "normal" as const };
  expect(await addFont(api, "t", new Uint8Array(8), font, await teamFonts(api, "t"))).toBeNull();
  expect(calls.map((c) => c.method)).toEqual(["get-font-variants"]);
});
