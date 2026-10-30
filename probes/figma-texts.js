// args: id. One line per text layer under a Figma frame: name and box relative to the frame.
const root = await figma.getNodeByIdAsync(args.id);
const [ox, oy] = [root.absoluteTransform[0][2], root.absoluteTransform[1][2]];
return root
  .findAll((s) => s.type === "TEXT")
  .map(
    (s) =>
      `${s.name.slice(0, 24)} ${[s.absoluteTransform[0][2] - ox, s.absoluteTransform[1][2] - oy, s.width, s.height].map(Math.round).join(",")}`,
  );
