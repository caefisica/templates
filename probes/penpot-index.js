// args: id, path, index. Sets a shape's parent index.
const p = globalThis.ɵcontext;
let s = p.currentPage.getShapeById(args.id);
for (const n of args.path.split("/")) s = s.children.find((c) => c.name === n);
s.setParentIndex(Number(args.index));
return s.parent.children.map((c) => `${c.name} idx${c.parentIndex}`);
