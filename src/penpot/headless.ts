// Reads and renders a Penpot file over Penpot's RPC API, with no browser. The
// file comes from `get-file`; the frame's board is fetched as transit and drawn
// by the engine (see src/penpot/engine.ts). It needs an access token.

import type { Backend } from "../backend";
import type { FrameInfo, PageInfo } from "../design";
import type { Target } from "../url";
import { type Engine, loadEngine } from "./engine";
import { rpc } from "./rpc";

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

export function headless(target: PenpotTarget, token: string): Backend {
  const auth = { authorization: `Token ${token}` };
  const { json, transit } = rpc(target.origin, token);

  let file: Promise<File> | undefined;
  const getFile = (): Promise<File> => (file ??= json("get-file", { id: target.file }));
  let engine: Promise<Engine> | undefined;
  const getEngine = () => (engine ??= loadEngine());
  let fonts: Promise<string> | undefined;
  const getFonts = () =>
    (fonts ??= transit("get-font-variants", ["^ ", "~:team-id", `~u${target.team}`]));

  const info = (s: Shape, page: string): FrameInfo => ({
    id: s.id,
    name: s.name,
    w: Math.round(s.width),
    h: Math.round(s.height),
    page,
  });

  // The page that holds the board, `page` or else the first that does, and
  // the top-level board above it.
  const locate = async (id: string, page?: string) => {
    const { data } = await getFile();
    for (const at of page ? [page] : data.pages) {
      const objects = data.pagesIndex[at]?.objects ?? {};
      let shape = objects[id];
      if (shape?.type !== "frame") continue;
      while (shape.parentId !== root) shape = objects[shape.parentId]!;
      return { page: at, shape: objects[id]!, board: shape.id };
    }
    return null;
  };

  // The transit page holding the frame's top-level board and its subtree.
  const boards = new Map<string, Promise<string>>();
  const pageOf = async (frame: FrameInfo) => {
    const at = await locate(frame.id, frame.page);
    if (!at) throw new Error(`no frame ${frame.id} in this file`);
    const key = `${at.page} ${at.board}`;
    if (!boards.has(key))
      boards.set(
        key,
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
    return boards.get(key)!;
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
          .map((s) => info(s, id));
        return { id, name, frames };
      });
    },
    async frame(id, page) {
      const at = await locate(id, page);
      return at && info(at.shape, at.page);
    },
    async layers(frame) {
      return (await getEngine()).layers(await pageOf(frame), frame.id);
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
          frame: frame.id,
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
