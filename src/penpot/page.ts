// Functions that run inside a Penpot workspace tab through CDP, on
// `ɵcontext`, the plugin API object the workspace exposes on the page. Each
// must not reference anything outside its own body.

import type { Format, FrameInfo, Layer, Overflow, PageInfo, Variant } from "../design";

export async function penpotPages(): Promise<PageInfo[]> {
  const p = (globalThis as any)["ɵcontext"];
  return p.currentFile.pages.map((page: any) => ({
    id: page.id,
    name: page.name,
    frames: (page.root?.children ?? [])
      .filter((s: any) => s.type === "board")
      .map((s: any) => ({
        id: s.id,
        name: s.name,
        w: Math.round(s.width),
        h: Math.round(s.height),
        page: page.id,
      })),
  }));
}

// Any board on the open page by id, however deep, or null. Boards on other
// pages are reachable by `penpotPages` only.
// getShapeById throws on an id that is not a uuid, such as a Figma node id.
export async function penpotFrame(args: { id: string; page?: string }): Promise<FrameInfo | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args.id)) return null;
  const open = (globalThis as any)["ɵcontext"].currentPage;
  if (args.page && open.id !== args.page) return null;
  const s = open.getShapeById(args.id);
  if (s?.type !== "board") return null;
  return {
    id: s.id,
    name: s.name,
    w: Math.round(s.width),
    h: Math.round(s.height),
    page: open.id,
  };
}

// Shapes are reachable only on the open page, so this opens the page that
// holds the frame before any other call uses it: `page`, else the open page
// when it holds the frame, else the first page that does.
export async function penpotOpen(args: { frame: string; page?: string }): Promise<void> {
  const p = (globalThis as any)["ɵcontext"];
  if (args.page ? p.currentPage.id === args.page : p.currentPage.getShapeById(args.frame)) return;
  const page = p.currentFile.pages.find((pg: any) =>
    args.page ? pg.id === args.page : pg.root?.children?.some((s: any) => s.id === args.frame),
  );
  if (!page) throw new Error(`no frame ${args.frame} in this file`);
  p.openPage(page);
  for (let i = 0; i < 100 && !p.currentPage.getShapeById(args.frame); i++)
    await new Promise((r) => setTimeout(r, 100));
  if (!p.currentPage.getShapeById(args.frame)) throw new Error(`page ${page.name} did not open`);
}

export async function penpotLayers(args: { frame: string }): Promise<Layer[]> {
  const p = (globalThis as any)["ɵcontext"];
  const frame = p.currentPage.getShapeById(args.frame);
  if (!frame) throw new Error(`no frame ${args.frame} on the open page`);
  const layers = new Map<string, Layer>();
  const visit = (s: any, path: string) => {
    if (s.hidden) return;
    const image = (s.fills ?? []).find((f: any) => f.fillImage);
    const kind = s.type === "text" ? "text" : image ? "image" : null;
    if (kind) {
      const seen = layers.get(path);
      if (seen) seen.count++;
      else
        layers.set(path, {
          path,
          kind,
          value: kind === "text" ? s.characters : image.fillImage.name,
          count: 1,
        });
    }
    for (const child of s.children ?? []) visit(child, `${path}/${child.name}`);
  };
  for (const child of frame.children) visit(child, child.name);
  return [...layers.values()];
}

// Renders all variants at once from clones of the frame, which are removed
// afterwards. Penpot exports on its server, so the exports run in parallel.
// Returns the exports as base64, in variant order, each with the texts it
// pushed past an edge of the frame (see Overflow).
export async function penpotRender(args: {
  frame: string;
  variants: Variant[];
  format: Format;
  scale: number;
}): Promise<{ base64: string; overflow: Overflow[] }[]> {
  const p = (globalThis as any)["ɵcontext"];
  const frame = p.currentPage.getShapeById(args.frame);
  if (!frame) throw new Error(`no frame ${args.frame} on the open page`);
  const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const base64 = (data: Uint8Array) => {
    let binary = "";
    for (let i = 0; i < data.length; i += 0x8000)
      binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const byPath = (root: any) => {
    const found = new Map<string, any[]>();
    const visit = (s: any, path: string) => {
      found.set(path, [...(found.get(path) ?? []), s]);
      for (const child of s.children ?? []) visit(child, `${path}/${child.name}`);
    };
    for (const child of root.children) visit(child, child.name);
    return found;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Penpot lays text out asynchronously: a grown text box reports its new
  // size some time after the change. Export waits until every edited text
  // keeps its size across two reads.
  const settle = async (texts: any[]) => {
    let last = "";
    for (let i = 0; i < 30; i++) {
      await sleep(150);
      const now = texts.map((t) => `${t.width}x${t.height}`).join();
      if (now === last) return;
      last = now;
    }
  };

  // How far each visible text runs past each edge of `root`, the furthest of
  // the texts at one path. A copy of a list row shares its row's path.
  const sides = ["left", "right", "top", "bottom"] as const;
  const past = (root: any) => {
    const found = new Map<string, Record<string, number>>();
    const visit = (s: any, path: string) => {
      if (s.hidden) return;
      if (s.type === "text") {
        const now = {
          left: root.x - s.x,
          right: s.x + s.width - root.x - root.width,
          top: root.y - s.y,
          bottom: s.y + s.height - root.y - root.height,
        };
        const was = found.get(path);
        for (const side of sides) now[side] = Math.max(now[side], was?.[side] ?? -Infinity);
        found.set(path, now);
      }
      for (const child of s.children ?? []) visit(child, `${path}/${child.name}`);
    };
    for (const child of root.children) visit(child, child.name);
    return found;
  };
  const design = past(frame);
  const overflow = (copy: any): Overflow[] => {
    if (!frame.clipContent) return [];
    const found: Overflow[] = [];
    for (const [path, now] of past(copy)) {
      let worst: Overflow | undefined;
      for (const edge of sides) {
        const px = now[edge]!;
        const was = Math.max(0, design.get(path)?.[edge] ?? 0);
        if (px > 0.5 && px - was > 0.5 && px > (worst?.px ?? 0))
          worst = { path, edge, px: Math.round(px) };
      }
      if (worst) found.push(worst);
    }
    return found;
  };

  const texts: any[] = [];
  const apply = async (root: any, variant: Variant) => {
    const layers = byPath(root);
    for (const [path, value] of Object.entries(variant)) {
      const shapes = layers.get(path);
      if (!shapes) throw new Error(`no layer ${path} in ${frame.name}`);
      if (value.kind === "list") {
        await fill(shapes[0], value.items);
        continue;
      }
      for (const s of shapes) {
        if (value.kind === "hidden") s.hidden = true;
        else if (value.kind === "text") {
          s.characters = value.text;
          texts.push(s);
        } else {
          const image = await p.uploadMediaData(path, bytes(value.base64), value.mime);
          s.fills = s.fills.map((f: any) =>
            f.fillImage ? { ...f, fillImage: { ...image, keepAspectRatio: true } } : f,
          );
        }
      }
    }
  };
  // The row's siblings of its type are the design's other example rows.
  // A flex board draws its children from the end of the list, and ignores
  // insertChild's index, so each copy moves to just after the row: that draws
  // it before the row and after the copies already made.
  const fill = async (row: any, items: Variant[]) => {
    const parent = row.parent;
    for (const sibling of [...parent.children])
      if (sibling.id !== row.id && sibling.type === row.type) sibling.remove();
    for (const item of items) {
      const copy = row.clone();
      copy.setParentIndex(parent.children.findIndex((c: any) => c.id === row.id) + 1);
      await apply(copy, item);
    }
    row.remove();
  };

  const copies: any[] = [];
  try {
    for (const [i, variant] of args.variants.entries()) {
      // On the page itself, a copy of a nested board leaves its siblings in place.
      const copy = frame.clone();
      copies.push(copy);
      p.root.appendChild(copy);
      copy.x = frame.x + (frame.width + 200) * (i + 1);
      copy.y = frame.y;
      await apply(copy, variant);
    }
    await settle(texts);
    const settings =
      args.format === "png" || args.format === "jpg"
        ? { type: args.format === "jpg" ? "jpeg" : "png", scale: args.scale }
        : { type: args.format };
    const exports = await Promise.all(copies.map((copy) => copy.export(settings)));
    return exports.map((data, i) => ({ base64: base64(data), overflow: overflow(copies[i]) }));
  } finally {
    for (const copy of copies) copy.remove();
  }
}

// The board on the open page that an earlier `copy` made from `source`.
export async function penpotCopyOf(args: {
  source: string;
}): Promise<{ id: string; x: number; y: number } | null> {
  const p = (globalThis as any)["ɵcontext"];
  const board = p.currentPage.root.children.find(
    (s: any) => s.type === "board" && s.getSharedPluginData("templates", "source") === args.source,
  );
  return board ? { id: board.id, x: board.x, y: board.y } : null;
}

export async function penpotRemove(args: { id: string }): Promise<void> {
  const p = (globalThis as any)["ɵcontext"];
  p.currentPage.getShapeById(args.id)?.remove();
}

// The x just right of everything on the open page, where a new frame lands
// clear of the rest.
export async function penpotFreeX(): Promise<number> {
  const p = (globalThis as any)["ɵcontext"];
  const ends = p.currentPage.root.children.map((s: any) => s.x + s.width);
  return ends.length ? Math.max(...ends) + 200 : 0;
}
