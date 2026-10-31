// Writes a neutral design into the open Penpot file. `writePenpot` runs inside
// a Penpot workspace tab through CDP, so it must not reference anything outside
// its own body. It drives `ɵcontext`, the plugin API object the Penpot
// workspace exposes on the page, which needs no installed plugin.

import type { Design } from "../model";

export async function writePenpot(args: {
  design: Design;
  x: number;
  y: number;
}): Promise<{ id: string; warnings: string[] }> {
  const p = (globalThis as any)["ɵcontext"];
  if (!p?.currentPage) throw new Error("no Penpot file is open in this tab");
  const { design } = args;
  const warnings: string[] = [];
  const media = new Map<string, any>();

  const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

  const image = async (key: string) => {
    if (!media.has(key)) {
      const asset = design.assets[key]!;
      media.set(key, await p.uploadMediaData(key, bytes(asset.base64), asset.mime));
    }
    return media.get(key);
  };

  // Penpot draws a gradient in the shape's unit box, as the model keeps it.
  const gradient = (g: any) => ({
    type: g.kind,
    startX: g.start[0],
    startY: g.start[1],
    endX: g.end[0],
    endY: g.end[1],
    width: g.width,
    stops: g.stops,
  });

  // Penpot lists fills and strokes top first.
  const fills = async (node: any) => {
    const out = [];
    for (const fill of [...node.fills].reverse())
      out.push(
        fill.kind === "solid"
          ? { fillColor: fill.color, fillOpacity: fill.opacity }
          : fill.kind === "image"
            ? {
                fillImage: { ...(await image(fill.asset)), keepAspectRatio: true },
                fillOpacity: fill.opacity,
              }
            : { fillColorGradient: gradient(fill), fillOpacity: fill.opacity },
      );
    return out;
  };

  const font = (text: any) => {
    const family = p.fonts.findByName(text.family);
    if (!family) {
      warnings.push(`${text.family}: font missing in Penpot`);
      return null;
    }
    const style = text.italic ? "italic" : "normal";
    const variants = family.variants.filter((v: any) => v.fontStyle === style);
    const near = (variants.length ? variants : family.variants).reduce((best: any, v: any) =>
      Math.abs(Number(v.fontWeight) - text.weight) < Math.abs(Number(best.fontWeight) - text.weight)
        ? v
        : best,
    );
    return { family, variant: near };
  };

  // Shapes are built unrotated in their parent's frame, and each is turned by
  // its rotation relative to the parent once its children are in place, so a
  // turned parent carries its children with it.
  type Frame = { cx: number; cy: number; bx: number; by: number; rotation: number };
  const placeIn = (node: any, frame: Frame) => {
    const angle = (-frame.rotation * Math.PI) / 180;
    const dx = node.x + node.w / 2 - frame.cx;
    const dy = node.y + node.h / 2 - frame.cy;
    const bx = frame.bx + dx * Math.cos(angle) - dy * Math.sin(angle);
    const by = frame.by + dx * Math.sin(angle) + dy * Math.cos(angle);
    return {
      x: bx - node.w / 2,
      y: by - node.h / 2,
      inner: { cx: node.x + node.w / 2, cy: node.y + node.h / 2, bx, by, rotation: node.rotation },
    };
  };

  const create = async (node: any, frame: Frame): Promise<any> => {
    const at = placeIn(node, frame);
    let shape: any;
    if (node.kind === "frame") shape = p.createBoard();
    else if (node.kind === "rect") shape = p.createRectangle();
    else if (node.kind === "ellipse") shape = p.createEllipse();
    else if (node.kind === "text") shape = p.createText(node.text.chars || " ");
    else if (node.kind === "svg") {
      shape = p.createShapeFromSvg(
        new TextDecoder().decode(bytes(design.assets[node.asset]!.base64)),
      );
      // The import puts the group in the board under the viewport centre,
      // where a flex layout would ignore its position.
      p.root.appendChild(shape);
    } else if (node.kind === "group") {
      const children = [];
      for (const child of node.children) children.push(await create(child, at.inner));
      shape = p.group(children);
      if (node.mask) shape.makeMask();
    }
    shape.name = node.name;
    if (node.kind !== "group") {
      shape.resize(Math.max(node.w, 0.01), Math.max(node.h, 0.01));
      shape.x = at.x;
      shape.y = at.y;
    }
    if (node.kind !== "svg" && node.kind !== "group") shape.fills = await fills(node);
    if (node.strokes.length)
      shape.strokes = [...node.strokes].reverse().map((s: any) => ({
        ...(s.paint.kind === "solid"
          ? { strokeColor: s.paint.color }
          : { strokeColorGradient: gradient(s.paint) }),
        strokeOpacity: s.paint.opacity,
        strokeWidth: s.width,
        strokeAlignment: s.align,
        strokeStyle: "solid",
      }));
    if (node.shadows.length)
      shape.shadows = node.shadows.map((s: any) => ({
        style: s.inner ? "inner-shadow" : "drop-shadow",
        offsetX: s.x,
        offsetY: s.y,
        blur: s.blur,
        spread: s.spread,
        color: { color: s.color, opacity: s.opacity },
      }));
    // Penpot's blur value is the Gaussian deviation its SVG export uses.
    if (node.blur) shape.blur = { value: node.blur, hidden: false };
    if (node.radius) shape.borderRadius = node.radius;
    shape.opacity = node.opacity;
    try {
      shape.blendMode = node.blend;
    } catch {
      warnings.push(`${node.name}: ${node.blend} blend unsupported`);
    }

    if (node.kind === "text") {
      const t = node.text;
      const chosen = font(t);
      if (chosen) chosen.family.applyToText(shape, chosen.variant);
      shape.fontSize = String(t.size);
      shape.lineHeight = String(t.lineHeight);
      shape.letterSpacing = String(t.letterSpacing);
      shape.textTransform = {
        upper: "uppercase",
        lower: "lowercase",
        title: "capitalize",
        none: "none",
      }[t.case as string];
      shape.align = t.align;
      shape.growType = t.grow;
      if (t.grow !== "fixed") shape.resize(node.w, node.h);
    }

    if (node.kind === "frame") {
      shape.clipContent = node.clip;
      if (node.layout) {
        const l = node.layout;
        const flex = shape.addFlexLayout();
        flex.dir = l.dir;
        if (l.dir === "row") flex.columnGap = l.gap;
        else flex.rowGap = l.gap;
        [flex.topPadding, flex.rightPadding, flex.bottomPadding, flex.leftPadding] = l.pad;
        flex.justifyContent = l.main;
        flex.alignItems = l.cross;
        flex.wrap = l.wrap ? "wrap" : "nowrap";
        flex.horizontalSizing = l.hug[0] ? "auto" : "fix";
        flex.verticalSizing = l.hug[1] ? "auto" : "fix";
      }
      // appendChild puts a child at index 0. A plain board draws index 0
      // lowest, so it takes children last first to keep Figma's stacking. A
      // flex board draws index 0 highest and flows from the highest index, so
      // it takes children in Figma order and both flow and stacking hold.
      const children = node.layout ? node.children : [...node.children].reverse();
      for (const child of children) {
        const made = await create(child, at.inner);
        shape.appendChild(made);
        if (child.child) {
          const c = made.layoutChild;
          if (c) {
            c.absolute = child.child.absolute;
            c.horizontalSizing = { fixed: "fix", hug: "auto", fill: "fill" }[
              child.child.h as string
            ];
            c.verticalSizing = { fixed: "fix", hug: "auto", fill: "fill" }[child.child.v as string];
            if (!child.child.absolute)
              [c.topMargin, c.rightMargin, c.bottomMargin, c.leftMargin] = child.bleed.map(
                (v: number) => -v,
              );
          }
          if (child.child.absolute) {
            const again = placeIn(child, at.inner);
            made.x = again.x;
            made.y = again.y;
            // Turning absolute can move the child; index 0 is where Figma's order put it.
            made.setParentIndex(0);
          }
        }
      }
    }

    if (node.rotation !== frame.rotation) shape.rotate(node.rotation - frame.rotation);
    if (!node.visible) shape.hidden = true;
    return shape;
  };

  const root = await create(design.root, { cx: 0, cy: 0, bx: args.x, by: args.y, rotation: 0 });
  root.setSharedPluginData("templates", "source", design.source);
  return { id: root.id, warnings };
}
