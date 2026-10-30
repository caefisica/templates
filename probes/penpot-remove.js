// args: ids (comma separated). Removes shapes from the current page.
const p = globalThis.ɵcontext;
return args.ids.split(",").map((id) => {
  const s = p.currentPage.getShapeById(id);
  s?.remove();
  return { id, removed: !!s };
});
