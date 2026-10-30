// args: id. One line per text shape under a Penpot board: name and box relative to the board.
const root = globalThis.ɵcontext.currentPage.getShapeById(args.id);
const out = [];
const walk = (s) => {
  if (s.type === "text")
    out.push(
      `${s.name.slice(0, 24)} ${[s.x - root.x, s.y - root.y, s.width, s.height].map(Math.round).join(",")}`,
    );
  (s.children ?? []).forEach(walk);
};
walk(root);
return out;
