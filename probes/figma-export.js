// args: id, scale. Exports one Figma node as PNG.
const node = await figma.getNodeByIdAsync(args.id);
const bytes = await node.exportAsync({
  format: "PNG",
  constraint: { type: "SCALE", value: Number(args.scale ?? 1) },
});
let binary = "";
for (let i = 0; i < bytes.length; i += 0x8000)
  binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
return { ext: "png", bytes: btoa(binary) };
