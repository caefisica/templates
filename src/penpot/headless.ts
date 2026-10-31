// Reads and renders a Penpot file over Penpot's RPC API, with no browser. The
// file comes from `get-file`; the frame's board is fetched as transit and drawn
// by the engine (see src/penpot/engine.ts). It needs an access token.

import { homedir } from "node:os";
import { join } from "node:path";
import type { Backend } from "../backend";
import type { FrameInfo, PageInfo } from "../design";
import type { Target } from "../url";
import { type Engine, loadEngine } from "./engine";

type PenpotTarget = Extract<Target, { tool: "penpot" }>;

// get-file's JSON form: camelCase keys, objects keyed by id, root at uuid zero.
type Shape = {
  id: string;
  type: string;
  name: string;
  parentId: string;
  shapes?: string[];
  width: number;
  height: number;
};
type File = {
  data: {
    pages: string[];
    pagesIndex: Record<string, { name: string; objects: Record<string, Shape> }>;
  };
};

const root = "00000000-0000-0000-0000-000000000000";

// PENPOT_TOKEN, else the token file, else null.
export async function penpotToken(): Promise<string | null> {
  if (process.env.PENPOT_TOKEN) return process.env.PENPOT_TOKEN;
  const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const file = Bun.file(join(config, "templates", "penpot-token"));
  return (await file.exists()) ? (await file.text()).trim() : null;
}

export function headless(target: PenpotTarget, token: string): Backend {
  const auth = { authorization: `Token ${token}` };
  const call = async (method: string, body: string, type: string) => {
    const url = `${target.origin}/api/main/methods/${method}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { ...auth, "content-type": type, accept: type },
      body,
    });
    if (!response.ok)
      throw new Error(`Penpot ${method}: ${response.status} ${await response.text()}`);
    return response;
  };
  const json = (method: string, params: object) =>
    call(method, JSON.stringify(params), "application/json").then((r) => r.json());
  const transit = (method: string, body: unknown[]) =>
    call(method, JSON.stringify(body), "application/transit+json").then((r) => r.text());

  let file: Promise<File> | undefined;
  const getFile = (): Promise<File> => (file ??= json("get-file", { id: target.file }));
  let engine: Promise<Engine> | undefined;
  const getEngine = () => (engine ??= loadEngine());
  let fonts: Promise<string> | undefined;
  const getFonts = () =>
    (fonts ??= transit("get-font-variants", ["^ ", "~:team-id", `~u${target.team}`]));

  const info = (s: Shape): FrameInfo => ({
    id: s.id,
    name: s.name,
    w: Math.round(s.width),
    h: Math.round(s.height),
  });

  // The page that holds the board, and the top-level board above it.
  const locate = async (id: string) => {
    const { data } = await getFile();
    for (const page of data.pages) {
      const objects = data.pagesIndex[page]!.objects;
      let shape = objects[id];
      if (shape?.type !== "frame") continue;
      while (shape.parentId !== root) shape = objects[shape.parentId]!;
      return { page, board: shape.id };
    }
    return null;
  };

  // The transit page holding the frame's top-level board and its subtree.
  const boards = new Map<string, Promise<string>>();
  const pageOf = async (frame: string) => {
    const at = await locate(frame);
    if (!at) throw new Error(`no frame ${frame} in this file`);
    if (!boards.has(at.board))
      boards.set(
        at.board,
        transit("get-page", [
          "^ ",
          "~:file-id",
          `~u${target.file}`,
          "~:page-id",
          `~u${at.page}`,
          "~:object-id",
          ["~#set", [`~u${at.board}`]],
        ]),
      );
    return boards.get(at.board)!;
  };

  const origin = `${target.origin}/`;
  const fetchAsset = async (url: string) => {
    const response = await fetch(url, url.startsWith(origin) ? { headers: auth } : {});
    return response.ok ? response.arrayBuffer() : null;
  };

  return {
    target,
    async pages(): Promise<PageInfo[]> {
      const { data } = await getFile();
      return data.pages.map((id) => {
        const { name, objects } = data.pagesIndex[id]!;
        const frames = (objects[root]!.shapes ?? [])
          .map((child) => objects[child]!)
          .filter((s) => s.type === "frame")
          .map(info);
        return { id, name, frames };
      });
    },
    async frame(id) {
      const { data } = await getFile();
      for (const page of data.pages) {
        const shape = data.pagesIndex[page]!.objects[id];
        if (shape?.type === "frame") return info(shape);
      }
      return null;
    },
    async layers(frame) {
      return (await getEngine()).layers(await pageOf(frame), frame);
    },
    async *render(frame, variants, format, scale) {
      const [engine, page, fontVariants] = await Promise.all([
        getEngine(),
        pageOf(frame),
        getFonts(),
      ]);
      for (const v of variants) {
        const [bytes] = await engine.render({
          page,
          frame,
          variants: [v],
          format,
          scale,
          origin,
          fetch: fetchAsset,
          fontVariants,
        });
        yield bytes!;
      }
    },
    close() {},
  };
}
