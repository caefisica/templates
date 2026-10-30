// args: id. Lists a shape's children in API order with a few properties.
const p = globalThis.ɵcontext;
const shape = p.currentPage.getShapeById(args.id);
const kid = (c) => ({
  name: c.name,
  type: c.type,
  blend: c.blendMode,
  opacity: c.opacity,
  fills: c.fills?.map?.(
    (f) => f.fillColor ?? (f.fillImage ? "image " + f.fillImage.id?.slice(0, 8) : "?"),
  ),
  kids: c.children?.length,
});
const out = { order: shape.children.map(kid) };
if (args.path) {
  let s = shape;
  for (const n of args.path.split("/")) s = s.children.find((c) => c.name === n);
  out.at = s.children ? s.children.map(kid) : kid(s);
}
return out;
