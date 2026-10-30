// Reads a Figma node into the neutral model. `readFigma` runs inside a Figma
// tab through CDP, so it must not reference anything outside its own body.

import type { Design } from "../model";

declare const figma: any;

export async function readFigma(args: { id: string }): Promise<Design> {
  const root = await figma.getNodeByIdAsync(args.id);
  if (!root) throw new Error(`no node ${args.id} in this file`);
  const assets: Design["assets"] = {};
  const warnings = new Set<string>();
  const origin = root.absoluteTransform;
  const vectorTypes = ["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "POLYGON"];

  const round = (value: number) => Math.round(value * 100) / 100;
  const hex = (c: any) =>
    "#" +
    [c.r, c.g, c.b]
      .map((v: number) =>
        Math.round(v * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");
  const base64 = (bytes: Uint8Array) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };

  // Figma places a node by the transform of its top-left corner; the model
  // keeps the unrotated box and a rotation about its centre.
  const place = (n: any) => {
    const [[a, b, tx], [c, d, ty]] = n.absoluteTransform;
    const cx = a * (n.width / 2) + b * (n.height / 2) + tx - origin[0][2];
    const cy = c * (n.width / 2) + d * (n.height / 2) + ty - origin[1][2];
    return {
      x: round(cx - n.width / 2),
      y: round(cy - n.height / 2),
      w: round(n.width),
      h: round(n.height),
      rotation: round((Math.atan2(c, a) * 180) / Math.PI),
    };
  };

  const imageAsset = async (hash: string) => {
    if (!assets[hash]) {
      const bytes = await figma.getImageByHash(hash).getBytesAsync();
      assets[hash] = {
        mime: bytes[0] === 0x89 ? "image/png" : "image/jpeg",
        base64: base64(bytes),
      };
    }
    return hash;
  };

  const paints = async (n: any) => {
    if (!("fills" in n)) return [];
    const list = n.fills === figma.mixed ? n.getStyledTextSegments(["fills"])[0].fills : n.fills;
    const out = [];
    for (const paint of list) {
      if (paint.visible === false) continue;
      const opacity = paint.opacity ?? 1;
      if (paint.type === "SOLID")
        out.push({ kind: "solid" as const, color: hex(paint.color), opacity });
      else if (paint.type === "IMAGE" && paint.scaleMode === "FILL")
        out.push({ kind: "image" as const, asset: await imageAsset(paint.imageHash), opacity });
      else if (paint.type === "IMAGE") {
        // A cropped or tiled image has no counterpart, so the layer is baked to a picture.
        const key = `bake-${n.id}`;
        assets[key] = {
          mime: "image/png",
          base64: base64(
            await n.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } }),
          ),
        };
        warnings.add(`${n.name}: ${paint.scaleMode.toLowerCase()} image baked to a picture`);
        out.push({ kind: "image" as const, asset: key, opacity });
      } else warnings.add(`${n.name}: ${paint.type.toLowerCase()} paint dropped`);
    }
    return out;
  };

  const strokes = (n: any) =>
    !("strokes" in n) || n.strokeWeight === figma.mixed
      ? []
      : n.strokes
          .filter((s: any) => s.visible !== false && s.type === "SOLID")
          .map((s: any) => ({
            color: hex(s.color),
            opacity: s.opacity ?? 1,
            width: n.strokeWeight,
            align:
              n.strokeAlign === "INSIDE"
                ? "inner"
                : n.strokeAlign === "OUTSIDE"
                  ? "outer"
                  : "center",
          }));

  const shadows = (n: any) => {
    if (!("effects" in n)) return [];
    const out = [];
    for (const e of n.effects) {
      if (e.visible === false) continue;
      if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW")
        out.push({
          inner: e.type === "INNER_SHADOW",
          x: e.offset.x,
          y: e.offset.y,
          blur: e.radius,
          spread: e.spread ?? 0,
          color: hex(e.color),
          opacity: e.color.a,
        });
      else warnings.add(`${n.name}: ${e.type.toLowerCase()} dropped`);
    }
    return out;
  };

  // Figma exports a turned node as its turned drawing in an upright box, but
  // the model turns the box itself. So a copy with the turn taken out of its
  // transform, flips and skew kept, is exported from the page level.
  const unrotatedSvg = async (n: any): Promise<string> => {
    const [[a, b], [c, d]] = n.absoluteTransform;
    const angle = Math.atan2(c, a);
    if (Math.abs(angle) < 1e-6) return n.exportAsync({ format: "SVG_STRING" });
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    const flat = n.clone();
    figma.currentPage.appendChild(flat);
    try {
      flat.relativeTransform = [
        [cos * a + sin * c, cos * b + sin * d, 0],
        [cos * c - sin * a, cos * d - sin * b, 0],
      ];
      return await flat.exportAsync({ format: "SVG_STRING" });
    } finally {
      flat.remove();
    }
  };

  const sizing = (value: string) => (value === "HUG" ? "hug" : value === "FILL" ? "fill" : "fixed");
  const align = (value: string) =>
    ({
      MIN: "start",
      CENTER: "center",
      MAX: "end",
      SPACE_BETWEEN: "space-between",
      BASELINE: "start",
    })[value];

  // Figma's cap-height trim shrinks the box to the glyphs; Penpot has none.
  // Two visible copies, one untrimmed, show how far the trim moved the glyphs'
  // top. A hidden node has no render bounds, hence the copies.
  const trim = async (n: any): Promise<[number, number]> => {
    if (n.leadingTrim !== "CAP_HEIGHT" || !n.characters.trim()) return [0, 0];
    await Promise.all(
      n.getRangeAllFontNames(0, n.characters.length).map((f: any) => figma.loadFontAsync(f)),
    );
    const [cut, full] = [n.clone(), n.clone()];
    try {
      for (const copy of [cut, full]) {
        figma.currentPage.appendChild(copy);
        copy.visible = true;
      }
      full.leadingTrim = "NONE";
      const glyphTop = (copy: any) => copy.absoluteRenderBounds.y - copy.absoluteTransform[1][2];
      const top = glyphTop(full) - glyphTop(cut);
      return [round(top), round(full.height - cut.height - top)];
    } finally {
      cut.remove();
      full.remove();
    }
  };

  const text = (n: any) => {
    if (n.getStyledTextSegments(["fontName", "fontSize"]).length > 1)
      warnings.add(`${n.name}: mixed text styles flattened to the first`);
    const font = n.fontName === figma.mixed ? n.getRangeFontName(0, 1) : n.fontName;
    const size = n.fontSize === figma.mixed ? n.getRangeFontSize(0, 1) : n.fontSize;
    const line = n.lineHeight === figma.mixed ? n.getRangeLineHeight(0, 1) : n.lineHeight;
    const letter =
      n.letterSpacing === figma.mixed ? n.getRangeLetterSpacing(0, 1) : n.letterSpacing;
    return {
      chars: n.characters,
      family: font.family,
      weight: n.fontWeight === figma.mixed ? 400 : n.fontWeight,
      italic: /italic/i.test(font.style),
      size: round(size),
      lineHeight: round(
        line.unit === "PERCENT"
          ? line.value / 100
          : line.unit === "PIXELS"
            ? line.value / size
            : 1.2,
      ),
      letterSpacing: round(letter.unit === "PERCENT" ? (letter.value / 100) * size : letter.value),
      case: ({ UPPER: "upper", LOWER: "lower", TITLE: "title" } as any)[n.textCase] ?? "none",
      align:
        n.textAlignHorizontal.toLowerCase() === "justified"
          ? "justify"
          : n.textAlignHorizontal.toLowerCase(),
      grow:
        n.textAutoResize === "WIDTH_AND_HEIGHT"
          ? "auto-width"
          : n.textAutoResize === "HEIGHT"
            ? "auto-height"
            : "fixed",
    };
  };

  const read = async (n: any, parent: any): Promise<any> => {
    const base: any = {
      id: n.id,
      name: n.name,
      visible: n.visible,
      ...place(n),
      opacity: n.opacity ?? 1,
      blend:
        !n.blendMode || n.blendMode === "PASS_THROUGH"
          ? "normal"
          : n.blendMode.toLowerCase().replace("_", "-"),
      fills: await paints(n),
      strokes: strokes(n),
      shadows: shadows(n),
      radius: typeof n.cornerRadius === "number" ? n.cornerRadius : 0,
    };
    if (parent && parent.layoutMode && parent.layoutMode !== "NONE")
      base.child = {
        h: sizing(n.layoutSizingHorizontal),
        v: sizing(n.layoutSizingVertical),
        absolute: n.layoutPositioning === "ABSOLUTE",
      };
    if (vectorTypes.includes(n.type)) {
      const svg = await unrotatedSvg(n);
      assets[`svg-${n.id}`] = {
        mime: "image/svg+xml",
        base64: base64(new TextEncoder().encode(svg)),
      };
      return { ...base, kind: "svg", asset: `svg-${n.id}`, fills: [], strokes: [] };
    }
    if (n.type === "TEXT") {
      const t = { ...text(n), trim: await trim(n) };
      return {
        ...base,
        kind: "text",
        y: base.y - t.trim[0],
        h: round(base.h + t.trim[0] + t.trim[1]),
        text: t,
      };
    }
    if (n.type === "RECTANGLE") return { ...base, kind: "rect" };
    if (n.type === "ELLIPSE") return { ...base, kind: "ellipse" };
    const children = [];
    for (const child of n.children ?? []) children.push(await read(child, n));
    if (n.type === "GROUP")
      return { ...base, kind: "group", mask: n.children.some((c: any) => c.isMask), children };
    if (n.type !== "FRAME" && n.type !== "COMPONENT" && n.type !== "INSTANCE")
      warnings.add(`${n.name}: ${n.type.toLowerCase()} read as a frame`);
    const layout =
      n.layoutMode && n.layoutMode !== "NONE"
        ? {
            dir: n.layoutMode === "HORIZONTAL" ? "row" : "column",
            // Figma ignores item spacing under space-between; Penpot keeps it as a minimum gap.
            gap: n.primaryAxisAlignItems === "SPACE_BETWEEN" ? 0 : n.itemSpacing,
            pad: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft],
            main: align(n.primaryAxisAlignItems),
            cross: align(n.counterAxisAlignItems),
            wrap: n.layoutWrap === "WRAP",
            hug:
              n.layoutMode === "HORIZONTAL"
                ? [n.primaryAxisSizingMode === "AUTO", n.counterAxisSizingMode === "AUTO"]
                : [n.counterAxisSizingMode === "AUTO", n.primaryAxisSizingMode === "AUTO"],
          }
        : undefined;
    return { ...base, kind: "frame", clip: n.clipsContent, layout, children };
  };

  return {
    source: `figma:${figma.fileKey}/${args.id}`,
    root: await read(root, null),
    assets,
    warnings: [...warnings],
  };
}
