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

  // `gradientTransform` maps the node's unit box to gradient space. There a
  // linear gradient's stop position is x, and a radial gradient is the circle
  // of radius 0.5 about (0.5, 0.5).
  const gradient = (paint: any) => {
    const [[a, b, c], [d, e, f]] = paint.gradientTransform;
    const det = a * e - b * d;
    const back = (x: number, y: number): [number, number] => [
      (e * (x - c) - b * (y - f)) / det,
      (a * (y - f) - d * (x - c)) / det,
    ];
    const shape = {
      stops: paint.gradientStops.map((s: any) => ({
        offset: s.position,
        color: hex(s.color),
        opacity: s.color.a,
      })),
      opacity: paint.opacity ?? 1,
    };
    const start = back(0, 0.5);
    if (paint.type === "GRADIENT_LINEAR") {
      // The position a·x + b·y + c grows fastest along (a, b), by a² + b² per unit.
      const k = a * a + b * b;
      return {
        kind: "linear" as const,
        start,
        end: [start[0] + a / k, start[1] + b / k],
        width: 1,
        ...shape,
      };
    }
    // The circle maps to an ellipse with conjugate radii u and v. Its radius
    // at angle θ is u·cos θ + v·sin θ, longest at θ = t and shortest at a
    // right angle to that.
    const centre = back(0.5, 0.5);
    const [ux, uy, vx, vy] = [e / 2 / det, -d / 2 / det, -b / 2 / det, a / 2 / det];
    const t = Math.atan2(2 * (ux * vx + uy * vy), ux ** 2 + uy ** 2 - vx ** 2 - vy ** 2) / 2;
    const radius = (θ: number) =>
      [ux * Math.cos(θ) + vx * Math.sin(θ), uy * Math.cos(θ) + vy * Math.sin(θ)] as const;
    const [major, minor] = [radius(t), radius(t + Math.PI / 2)];
    return {
      kind: "radial" as const,
      start: centre,
      end: [centre[0] + major[0], centre[1] + major[1]],
      width: Math.hypot(minor[0], minor[1]) / Math.hypot(major[0], major[1]),
      ...shape,
    };
  };

  const flat = (paint: any) => {
    if (paint.type === "SOLID")
      return { kind: "solid" as const, color: hex(paint.color), opacity: paint.opacity ?? 1 };
    if (paint.type === "GRADIENT_LINEAR" || paint.type === "GRADIENT_RADIAL")
      return gradient(paint);
    return undefined;
  };

  // Figma exports a turned node as its turned drawing in an upright box, but
  // the model turns the box itself. So an export runs on a page-level copy
  // with the turn taken out of its transform, flips and skew kept. The model
  // carries visibility, opacity and effects, so the copy drops them: Penpot
  // cannot move the raw element an SVG filter becomes. The caller removes
  // the copy.
  const upright = (n: any) => {
    const [[a, b], [c, d]] = n.absoluteTransform;
    const angle = Math.atan2(c, a);
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    const m = [cos * a + sin * c, cos * b + sin * d, cos * c - sin * a, cos * d - sin * b] as const;
    const copy = n.clone();
    figma.currentPage.appendChild(copy);
    try {
      copy.relativeTransform = [
        [m[0], m[1], 0],
        [m[2], m[3], 0],
      ];
      copy.visible = true;
      copy.opacity = 1;
      copy.effects = [];
    } catch (error) {
      copy.remove();
      throw error;
    }
    return { copy, m, cos, sin };
  };

  // A paint Penpot has no counterpart for becomes a picture of the node's box
  // filled with that paint alone.
  const bake = async (n: any, paint: any, index: number) => {
    let frame = upright(n).copy;
    try {
      if (frame.type === "INSTANCE") frame = frame.detachInstance();
      // A hugging layout would shrink once its children go.
      if (frame.layoutMode) frame.layoutMode = "NONE";
      for (const child of frame.children ?? []) child.remove();
      frame.fills = [{ ...paint, opacity: 1 }];
      frame.strokes = [];
      const key = `bake-${n.id}-${index}`;
      assets[key] = {
        mime: "image/png",
        base64: base64(
          await frame.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } }),
        ),
      };
      return { kind: "image" as const, asset: key, opacity: paint.opacity ?? 1 };
    } finally {
      frame.remove();
    }
  };

  // A Figma paint can blend with what lies under it: the layer's lower paints,
  // and, when the layer passes through, the layers below. Penpot blends whole
  // layers only. A pass-through layer whose paints share one mode takes that
  // mode as its own. In an isolated layer a blended paint with nothing under
  // it draws as a normal one, and over other paints it is dropped. Any other
  // blended paint draws normal. Returns the paints to draw and the layer mode.
  const mode = (paint: any) => paint.blendMode ?? "NORMAL";
  const spoken = (m: string) => m.toLowerCase().replace("_", " ");
  const unblend = (n: any, list: readonly any[]) => {
    const shown = list.filter((paint) => paint.visible !== false);
    const painted = shown.filter((paint) => paint.opacity !== 0);
    const modes = new Set(painted.map(mode));
    if (!painted.some((paint) => mode(paint) !== "NORMAL")) return { fills: shown };
    if (n.blendMode !== "PASS_THROUGH") {
      const fills = shown.filter((paint) => {
        if (mode(paint) === "NORMAL" || painted.indexOf(paint) <= 0) return true;
        warnings.add(`${n.name}: ${spoken(mode(paint))} paint over other paints dropped`);
        return false;
      });
      return { fills };
    }
    if (modes.size === 1)
      return { fills: shown, blend: spoken(painted[0].blendMode).replace(" ", "-") };
    for (const m of modes)
      if (m !== "NORMAL") warnings.add(`${n.name}: ${spoken(m)} paint drawn normal`);
    return { fills: shown };
  };

  const fillList = (n: any) =>
    !("fills" in n)
      ? []
      : n.fills === figma.mixed
        ? n.getStyledTextSegments(["fills"])[0].fills
        : n.fills;

  const paints = async (n: any, list: readonly any[]) => {
    const out = [];
    for (const [index, paint] of list.entries()) {
      const simple = paint.type === "IMAGE" ? undefined : flat(paint);
      if (simple) out.push(simple);
      else if (paint.type === "IMAGE" && paint.scaleMode === "FILL")
        out.push({
          kind: "image" as const,
          asset: await imageAsset(paint.imageHash),
          opacity: paint.opacity ?? 1,
        });
      else {
        const what =
          paint.type === "IMAGE"
            ? `${paint.scaleMode.toLowerCase()} image`
            : `${paint.type.toLowerCase()} paint`;
        if (n.type === "TEXT") warnings.add(`${n.name}: ${what} dropped`);
        else {
          out.push(await bake(n, paint, index));
          warnings.add(`${n.name}: ${what} baked to a picture`);
        }
      }
    }
    return out;
  };

  const strokes = (n: any) => {
    if (!("strokes" in n) || n.strokeWeight === figma.mixed) return [];
    const align =
      n.strokeAlign === "INSIDE" ? "inner" : n.strokeAlign === "OUTSIDE" ? "outer" : "center";
    // Penpot draws a dash pattern of its own; a dash no longer than the
    // stroke is wide reads as dots.
    const dash = n.dashPattern ?? [];
    const style = !dash.length ? "solid" : dash[0] <= n.strokeWeight ? "dotted" : "dashed";
    const out = [];
    for (const s of n.strokes) {
      if (s.visible === false) continue;
      const paint = s.type === "IMAGE" ? undefined : flat(s);
      if (paint) out.push({ paint, width: n.strokeWeight, align, style });
      else warnings.add(`${n.name}: ${s.type.toLowerCase()} stroke dropped`);
    }
    return out;
  };

  const effects = (n: any) => {
    const out = { shadows: [] as any[], blur: 0 };
    if (!("effects" in n)) return out;
    for (const e of n.effects) {
      if (e.visible === false) continue;
      // Figma's blur radius is twice the Gaussian deviation its SVG export uses.
      if (e.type === "LAYER_BLUR" && e.blurType !== "PROGRESSIVE") out.blur = e.radius / 2;
      else if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW")
        out.shadows.push({
          inner: e.type === "INNER_SHADOW",
          x: e.offset.x,
          y: e.offset.y,
          blur: e.radius,
          spread: e.spread ?? 0,
          color: hex(e.color),
          opacity: e.color.a,
        });
      else if (e.type === "LAYER_BLUR") warnings.add(`${n.name}: progressive blur dropped`);
      else warnings.add(`${n.name}: ${e.type.toLowerCase()} dropped`);
    }
    return out;
  };

  // The SVG's box is the drawing's, which differs from the node's for a line
  // or an outside stroke, so the box is placed by the drawing's centre.
  // Returns null when nothing is drawn.
  const vectorSvg = async (n: any) => {
    const { copy: flat, m, cos, sin } = upright(n);
    const [ma, mb, mc, md] = m;
    try {
      const bounds = flat.absoluteRenderBounds;
      if (!bounds) return null;
      const svg: string = await flat.exportAsync({ format: "SVG_STRING" });
      // Figma rounds the SVG's size up to whole pixels.
      const size = (key: string) => Number(svg.match(new RegExp(`${key}="([\\d.]+)"`))![1]);
      const [w, h] = [size("width"), size("height")];
      const dx = bounds.x + w / 2 - (ma * n.width + mb * n.height) / 2;
      const dy = bounds.y + h / 2 - (mc * n.width + md * n.height) / 2;
      const box = place(n);
      const cx = box.x + box.w / 2 + dx * cos - dy * sin;
      const cy = box.y + box.h / 2 + dx * sin + dy * cos;
      return { svg, x: round(cx - w / 2), y: round(cy - h / 2), w, h };
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
    // Figma loads only fonts this machine or the team has; others stay unmeasured.
    const fonts = n.getRangeAllFontNames(0, n.characters.length);
    try {
      await Promise.all(fonts.map((f: any) => figma.loadFontAsync(f)));
    } catch {
      warnings.add(`${n.name}: font ${fonts[0].family} not loadable, cap-height trim not offset`);
      return [0, 0];
    }
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

  // Figma's auto line height is the font's own ascent and descent, which
  // Penpot does not know, so a one-letter copy measures it as a ratio.
  const autoLine = async (n: any) => {
    const fonts = n.getRangeAllFontNames(0, n.characters.length);
    try {
      await Promise.all(fonts.map((f: any) => figma.loadFontAsync(f)));
    } catch {
      warnings.add(
        `${n.name}: font ${fonts[0].family} not loadable, auto line height taken as 1.2`,
      );
      return 1.2;
    }
    const copy = n.clone();
    try {
      figma.currentPage.appendChild(copy);
      copy.leadingTrim = "NONE";
      copy.textAutoResize = "WIDTH_AND_HEIGHT";
      copy.characters = "H";
      return copy.height / copy.getRangeFontSize(0, 1);
    } finally {
      copy.remove();
    }
  };

  // Figma calls a text's font mixed when this machine lacks the font, even
  // with one style, so the styles come from the segments, which name it.
  const text = async (n: any) => {
    const fields = ["fontName", "fontSize", "fontWeight", "fills", "lineHeight", "letterSpacing"];
    const segments = n.characters.length
      ? n.getStyledTextSegments(fields)
      : [Object.fromEntries(fields.map((f) => [f, n[f]]))];
    const runs = segments.map((s: any) => ({
      start: s.start ?? 0,
      end: s.end ?? 0,
      family: s.fontName.family,
      weight: s.fontWeight,
      italic: /italic/i.test(s.fontName.style),
      size: round(s.fontSize),
      fills: unblend(n, s.fills).fills.map(flat).filter(Boolean),
    }));
    const [{ lineHeight: line, letterSpacing: letter, fontSize: size }] = segments;
    const same = (field: string) =>
      segments.every((s: any) => JSON.stringify(s[field]) === JSON.stringify(segments[0][field]));
    if (!same("lineHeight") || !same("letterSpacing"))
      warnings.add(`${n.name}: mixed line height or letter spacing flattened to the first`);
    if (n.paragraphIndent) warnings.add(`${n.name}: paragraph indent dropped`);
    return {
      chars: n.characters,
      runs: runs.length > 1 ? runs : [],
      family: runs[0].family,
      weight: runs[0].weight,
      italic: runs[0].italic,
      size: runs[0].size,
      lineHeight: round(
        line.unit === "PERCENT"
          ? line.value / 100
          : line.unit === "PIXELS"
            ? line.value / size
            : await autoLine(n),
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

  // CSS has no linear burn or dodge, so they become the nearest CSS mode.
  const nearBlend: Record<string, string> = { LINEAR_BURN: "multiply", LINEAR_DODGE: "screen" };
  const blend = (n: any) => {
    if (!n.blendMode || n.blendMode === "PASS_THROUGH") return "normal";
    const near = nearBlend[n.blendMode];
    if (!near) return n.blendMode.toLowerCase().replace("_", "-");
    warnings.add(
      `${n.name}: ${n.blendMode.toLowerCase().replace("_", " ")} blend drawn as ${near}`,
    );
    return near;
  };

  // Penpot's clip isolates a board, so a layer inside it blends with nothing
  // outside the board, where a Figma frame clips without isolating. A clip
  // that cuts nothing, with every painted descendant inside the box and clear
  // of its rounded corners, is left off when a blend needs what lies below.
  const blends = (d: any) =>
    (d.blendMode && !["PASS_THROUGH", "NORMAL"].includes(d.blendMode)) ||
    (Array.isArray(d.fills) && d.fills.some((paint: any) => mode(paint) !== "NORMAL"));
  const clips = (n: any) => {
    if (!n.clipsContent) return false;
    if (!n.findOne?.(blends)) return true;
    const box = n.absoluteBoundingBox;
    const [tl, tr, br, bl] = radii(n);
    const painted = n.findAll(
      (d: any) =>
        d.visible &&
        (!d.children?.length ||
          (Array.isArray(d.fills) && d.fills.some((p: any) => p.visible !== false))),
    );
    return painted.some((d: any) => {
      // Render bounds are already cut by the clips above, so they cannot show overflow.
      const b = d.absoluteBoundingBox;
      if (!b) return false;
      const [left, top, right, bottom] = [
        b.x - box.x,
        b.y - box.y,
        b.x + b.width - box.x,
        b.y + b.height - box.y,
      ];
      if (left < -0.5 || top < -0.5 || right > box.width + 0.5 || bottom > box.height + 0.5)
        return true;
      const inCorner = (r: number, x0: number, y0: number) =>
        r > 0 && left < x0 + r && right > x0 && top < y0 + r && bottom > y0;
      return (
        inCorner(tl, 0, 0) ||
        inCorner(tr, box.width - tr, 0) ||
        inCorner(br, box.width - br, box.height - br) ||
        inCorner(bl, 0, box.height - bl)
      );
    });
  };

  const radii = (n: any): [number, number, number, number] => {
    if (n.cornerRadius === figma.mixed)
      return [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius];
    const r = typeof n.cornerRadius === "number" ? n.cornerRadius : 0;
    return [r, r, r, r];
  };

  const read = async (n: any, parent: any): Promise<any> => {
    // A vector's SVG carries its own paints.
    const vector = vectorTypes.includes(n.type);
    const unblended = vector ? { fills: [] } : unblend(n, fillList(n));
    const base: any = {
      id: n.id,
      name: n.name,
      visible: n.visible,
      ...place(n),
      opacity: n.opacity ?? 1,
      blend: unblended.blend ?? blend(n),
      fills: await paints(n, unblended.fills),
      strokes: vector ? [] : strokes(n),
      ...effects(n),
      radius: radii(n),
      bleed: [0, 0, 0, 0],
    };
    if (parent && parent.layoutMode && parent.layoutMode !== "NONE")
      base.child = {
        h: sizing(n.layoutSizingHorizontal),
        v: sizing(n.layoutSizingVertical),
        absolute: n.layoutPositioning === "ABSOLUTE",
      };
    if (vectorTypes.includes(n.type)) {
      const drawn = await vectorSvg(n);
      if (!drawn) {
        warnings.add(`${n.name}: vector draws nothing, copied as an empty rectangle`);
        return { ...base, kind: "rect" };
      }
      const { svg, ...box } = drawn;
      assets[`svg-${n.id}`] = {
        mime: "image/svg+xml",
        base64: base64(new TextEncoder().encode(svg)),
      };
      const bleed = [
        base.y - box.y,
        box.x + box.w - base.x - base.w,
        box.y + box.h - base.y - base.h,
        base.x - box.x,
      ].map(round);
      return { ...base, ...box, bleed, kind: "svg", asset: `svg-${n.id}` };
    }
    if (n.type === "TEXT") {
      const [top, bottom] = await trim(n);
      return {
        ...base,
        kind: "text",
        y: base.y - top,
        h: round(base.h + top + bottom),
        bleed: [top, 0, bottom, 0],
        text: await text(n),
      };
    }
    if (n.type === "RECTANGLE") return { ...base, kind: "rect" };
    if (n.type === "ELLIPSE") return { ...base, kind: "ellipse" };
    // Penpot draws a shadow through a filter, which isolates the layer as a
    // clip does, so a shadow gives way to the blends inside.
    if (base.shadows.length && (unblended.blend || n.findOne?.(blends))) {
      warnings.add(`${n.name}: shadow dropped so the blends inside reach the layers below`);
      base.shadows = [];
    }
    const children = [];
    // A layer mode on a frame would blend its children too, so the frame's
    // paints move to a backing rectangle that takes the mode.
    if (unblended.blend && n.children?.length) {
      children.push({
        ...base,
        id: `${n.id}-paint`,
        name: `${n.name} paint`,
        visible: true,
        opacity: 1,
        strokes: [],
        shadows: [],
        blur: 0,
        child:
          n.layoutMode && n.layoutMode !== "NONE"
            ? { h: "fixed", v: "fixed", absolute: true }
            : undefined,
        kind: "rect",
      });
      Object.assign(base, { blend: blend(n), fills: [] });
    }
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
    return { ...base, kind: "frame", clip: clips(n), layout, children };
  };

  return {
    source: `figma:${figma.fileKey}/${args.id}`,
    root: await read(root, null),
    assets,
    warnings: [...warnings],
  };
}
