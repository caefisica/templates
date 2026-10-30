// args: id, path. Lists boxes (relative to the root) under a path of names.
const p = globalThis.ɵcontext;
const root = p.currentPage.getShapeById(args.id);
let s = root;
for (const n of args.path.split("/")) s = s.children.find((c) => c.name === n);
const box = (c) =>
  `${c.name} ${c.type} idx${c.parentIndex} ${[c.x - root.x, c.y - root.y, c.width, c.height, c.rotation].map((v) => Math.round(v)).join(",")} hidden=${c.hidden} abs=${c.layoutChild?.absolute}`;
const list = [box(s)];
const walk = (n, d) => {
  for (const c of n.children ?? []) {
    list.push("  ".repeat(d) + box(c));
    walk(c, d + 1);
  }
};
walk(s, 1);
return list;
