// args: id. Exports one shape as PNG and lists its children.
const p = globalThis.ɵcontext;
const shape = p.currentPage.getShapeById(args.id);
const bytes = await shape.export({ type: "png", scale: Number(args.scale ?? 1) });
let binary = "";
for (const b of bytes) binary += String.fromCharCode(b);
return {
  children: shape.children?.map((c) => ({
    name: c.name,
    type: c.type,
    xy: [c.x - shape.x, c.y - shape.y],
    size: [c.width, c.height],
    text: c.characters,
    font: c.fontFamily,
  })),
  ext: "png",
  bytes: btoa(binary),
};
