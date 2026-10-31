// Functions that run inside a Figma tab through CDP, on the plugin API the
// editor exposes as `figma` on files the user can edit. Each must not
// reference anything outside its own body.

import type { Format, FrameInfo, Layer, Overflow, PageInfo, Variant } from "../design";

declare const figma: any;

// A section only groups frames on the canvas, so the frames in it count as
// top-level frames.
export async function figmaPages(): Promise<PageInfo[]> {
  await figma.loadAllPagesAsync();
  const frames = (nodes: any[], section?: string): any[] =>
    nodes.flatMap((n: any) =>
      n.type === "SECTION"
        ? frames(n.children, section ? `${section}/${n.name}` : n.name)
        : ["FRAME", "COMPONENT", "INSTANCE"].includes(n.type)
          ? [
              {
                id: n.id,
                name: n.name,
                w: Math.round(n.width),
                h: Math.round(n.height),
                ...(section ? { section } : {}),
              },
            ]
          : [],
    );
  return figma.root.children.map((page: any) => ({
    id: page.id,
    name: page.name,
    frames: frames(page.children),
  }));
}

// Any frame by id, however deep, or null.
export async function figmaFrame(args: { id: string }): Promise<FrameInfo | null> {
  const n = await figma.getNodeByIdAsync(args.id);
  if (!n || !["FRAME", "COMPONENT", "INSTANCE"].includes(n.type)) return null;
  return { id: n.id, name: n.name, w: Math.round(n.width), h: Math.round(n.height) };
}

export async function figmaLayers(args: { frame: string }): Promise<Layer[]> {
  const frame = await figma.getNodeByIdAsync(args.frame);
  if (!frame) throw new Error(`no frame ${args.frame} in this file`);
  const layers = new Map<string, Layer>();
  const visit = (n: any, path: string) => {
    if (!n.visible) return;
    const image =
      "fills" in n && Array.isArray(n.fills)
        ? n.fills.find((f: any) => f.type === "IMAGE" && f.visible !== false)
        : null;
    const kind = n.type === "TEXT" ? "text" : image ? "image" : null;
    if (kind) {
      const seen = layers.get(path);
      if (seen) seen.count++;
      else
        layers.set(path, {
          path,
          kind,
          value: kind === "text" ? n.characters : image.imageHash,
          count: 1,
        });
    }
    for (const child of n.children ?? []) visit(child, `${path}/${child.name}`);
  };
  for (const child of frame.children) visit(child, child.name);
  return [...layers.values()];
}

// Renders each variant from a clone of the frame, which is removed afterwards.
// Returns the exports as base64, in variant order.
export async function figmaRender(args: {
  frame: string;
  variants: Variant[];
  format: Format;
  scale: number;
}): Promise<{ base64: string; overflow: Overflow[] }[]> {
  const frame = await figma.getNodeByIdAsync(args.frame);
  if (!frame) throw new Error(`no frame ${args.frame} in this file`);
  // How far each visible text's box runs past each edge of `root`, the
  // furthest of the texts at one path. A copy of a list row shares its row's
  // path.
  const sides = ["left", "right", "top", "bottom"] as const;
  const past = (root: any) => {
    const r = root.absoluteBoundingBox;
    const found = new Map<string, Record<string, number>>();
    const visit = (n: any, path: string) => {
      if (!n.visible) return;
      if (n.type === "TEXT") {
        const b = n.absoluteBoundingBox;
        const now = {
          left: r.x - b.x,
          right: b.x + b.width - r.x - r.width,
          top: r.y - b.y,
          bottom: b.y + b.height - r.y - r.height,
        };
        const was = found.get(path);
        for (const side of sides) now[side] = Math.max(now[side], was?.[side] ?? -Infinity);
        found.set(path, now);
      }
      for (const child of n.children ?? []) visit(child, `${path}/${child.name}`);
    };
    for (const child of root.children) visit(child, child.name);
    return found;
  };
  const design = past(frame);
  const overflow = (copy: any): Overflow[] => {
    if (!frame.clipsContent) return [];
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
  const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const base64 = (data: Uint8Array) => {
    let binary = "";
    for (let i = 0; i < data.length; i += 0x8000)
      binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const byPath = (root: any) => {
    const found = new Map<string, any[]>();
    const visit = (n: any, path: string) => {
      found.set(path, [...(found.get(path) ?? []), n]);
      for (const child of n.children ?? []) visit(child, `${path}/${child.name}`);
    };
    for (const child of root.children) visit(child, child.name);
    return found;
  };
  const write = async (n: any, path: string, text: string) => {
    const fonts = n.characters.length
      ? n.getRangeAllFontNames(0, n.characters.length)
      : [n.fontName];
    for (const font of fonts)
      await figma.loadFontAsync(font).catch(() => {
        throw new Error(
          `${path}: font "${font.family} ${font.style}" is not installed where Figma runs, and Figma edits a text only in a font it can load`,
        );
      });
    // A text Figma names after its characters would otherwise take the new
    // text as its name, and its overflow would report under that name.
    n.autoRename = false;
    n.characters = text;
  };
  const apply = async (root: any, variant: Variant) => {
    const layers = byPath(root);
    for (const [path, value] of Object.entries(variant)) {
      const nodes = layers.get(path);
      if (!nodes) throw new Error(`no layer ${path} in ${frame.name}`);
      if (value.kind === "list") {
        await fill(nodes[0], value.items);
        continue;
      }
      for (const n of nodes) {
        // Figma centers the one child left in a space-between layout, so a
        // text there empties and keeps its place instead.
        if (value.kind === "hidden")
          if (n.type === "TEXT" && n.parent.primaryAxisAlignItems === "SPACE_BETWEEN")
            await write(n, path, "");
          else n.visible = false;
        else if (value.kind === "text") await write(n, path, value.text);
        else {
          const image = figma.createImage(bytes(value.base64));
          n.fills = n.fills.map((f: any) =>
            f.type === "IMAGE" ? { ...f, imageHash: image.hash } : f,
          );
        }
      }
    }
  };
  // The row's siblings of its type are the design's other example rows.
  const fill = async (row: any, items: Variant[]) => {
    const parent = row.parent;
    for (const sibling of [...parent.children])
      if (sibling !== row && sibling.type === row.type) sibling.remove();
    for (const item of items) {
      const copy = row.clone();
      parent.insertChild(parent.children.indexOf(row), copy);
      await apply(copy, item);
    }
    row.remove();
  };
  const settings =
    args.format === "svg"
      ? { format: "SVG" }
      : args.format === "pdf"
        ? { format: "PDF" }
        : {
            format: args.format === "jpg" ? "JPG" : "PNG",
            constraint: { type: "SCALE", value: args.scale },
          };

  const out: { base64: string; overflow: Overflow[] }[] = [];
  for (const variant of args.variants) {
    // On the page itself, a copy of a nested frame leaves its siblings in place.
    const copy = frame.clone();
    let page = frame.parent;
    while (page.type !== "PAGE") page = page.parent;
    page.appendChild(copy);
    const box = frame.absoluteBoundingBox;
    copy.x = box.x + box.width + 400;
    copy.y = box.y;
    try {
      await apply(copy, variant);
      out.push({ base64: base64(await copy.exportAsync(settings)), overflow: overflow(copy) });
    } finally {
      copy.remove();
    }
  }
  return out;
}
