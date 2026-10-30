// Reports whether the Penpot plugin API is on the page, and its members.
const c = globalThis.ɵcontext;
if (!c) return { context: false, href: location.href };
return {
  context: true,
  keys: Object.keys(Object.getPrototypeOf(c) ?? {}).concat(Object.keys(c)),
  page: c.currentPage?.name ?? null,
};
