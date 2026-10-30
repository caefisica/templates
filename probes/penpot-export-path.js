// args: id, path, scale. Exports the shape at a path of names under a root.
const p = globalThis.ɵcontext;
let s = p.currentPage.getShapeById(args.id);
for (const n of (args.path ?? "").split("/").filter(Boolean))
  s = s.children.find((c) => c.name === n);
const bytes = await s.export({ type: "png", scale: Number(args.scale ?? 1) });
let binary = "";
for (let i = 0; i < bytes.length; i += 0x8000)
  binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
return { ext: "png", bytes: btoa(binary) };
