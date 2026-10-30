// args: id, path. Shows a text shape's content and style.
const p = globalThis.ɵcontext;
let s = p.currentPage.getShapeById(args.id);
for (const n of args.path.split("/")) s = s.children.find((c) => c.name === n);
const t = s.children ? s.children[0] : s;
return {
  chars: t.characters,
  fills: t.fills,
  family: t.fontFamily,
  size: t.fontSize,
  grow: t.growType,
  wh: [t.width, t.height],
  parentClip: s.clipContent,
  flex: s.flex && { dir: s.flex.dir, h: s.flex.horizontalSizing },
};
