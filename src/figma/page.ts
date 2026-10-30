// Functions that run inside a Figma tab through CDP, on the plugin API the
// editor exposes as `figma` on files the user can edit. Each must not
// reference anything outside its own body.

import type { Format, Layer, PageInfo, Variant } from "../design";

declare const figma: any;

export async function figmaPages(): Promise<PageInfo[]> {
  await figma.loadAllPagesAsync();
  return figma.root.children.map((page: any) => ({
    id: page.id,
    name: page.name,
    frames: page.children
      .filter((n: any) => ["FRAME", "COMPONENT", "INSTANCE"].includes(n.type))
      .map((n: any) => ({
        id: n.id,
        name: n.name,
        w: Math.round(n.width),
        h: Math.round(n.height),
      })),
  }));
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
}): Promise<string[]> {
  const frame = await figma.getNodeByIdAsync(args.frame);
  if (!frame) throw new Error(`no frame ${args.frame} in this file`);
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
  const settings =
    args.format === "svg"
      ? { format: "SVG" }
      : args.format === "pdf"
        ? { format: "PDF" }
        : {
            format: args.format === "jpg" ? "JPG" : "PNG",
            constraint: { type: "SCALE", value: args.scale },
          };

  const out: string[] = [];
  for (const variant of args.variants) {
    const copy = frame.clone();
    copy.x = frame.x + frame.width + 400;
    try {
      const layers = byPath(copy);
      for (const [path, value] of Object.entries(variant)) {
        const nodes = layers.get(path);
        if (!nodes) throw new Error(`no layer ${path} in ${frame.name}`);
        for (const n of nodes) {
          if (value.kind === "text") {
            const fonts = n.characters.length
              ? n.getRangeAllFontNames(0, n.characters.length)
              : [n.fontName];
            await Promise.all(fonts.map((font: any) => figma.loadFontAsync(font)));
            n.characters = value.text;
          } else {
            const image = figma.createImage(bytes(value.base64));
            n.fills = n.fills.map((f: any) =>
              f.type === "IMAGE" ? { ...f, imageHash: image.hash } : f,
            );
          }
        }
      }
      out.push(base64(await copy.exportAsync(settings)));
    } finally {
      copy.remove();
    }
  }
  return out;
}
