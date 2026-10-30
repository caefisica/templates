// The neutral design model both backends read and write. Coordinates are in
// pixels relative to the root frame's top-left corner, measured on the
// unrotated box; `rotation` turns the box about its centre, in degrees.

export type Paint =
  | { kind: "solid"; color: string; opacity: number }
  | { kind: "image"; asset: string; opacity: number };

export type Stroke = {
  color: string;
  opacity: number;
  width: number;
  align: "inner" | "center" | "outer";
};

export type Shadow = {
  inner: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
  opacity: number;
};

export type Layout = {
  dir: "row" | "column";
  gap: number;
  pad: [number, number, number, number];
  main: "start" | "center" | "end" | "space-between";
  cross: "start" | "center" | "end";
  wrap: boolean;
  // Whether the frame shrinks to its content along width and height.
  hug: [boolean, boolean];
};

export type Sizing = "fixed" | "hug" | "fill";

export type Text = {
  chars: string;
  family: string;
  weight: number;
  italic: boolean;
  size: number;
  lineHeight: number;
  letterSpacing: number;
  case: "none" | "upper" | "lower" | "title";
  align: "left" | "center" | "right" | "justify";
  grow: "fixed" | "auto-width" | "auto-height";
  // Line space the design cuts above the cap height and below the baseline.
  // The node's box is the full line box; a layout flows the cut box.
  trim: [number, number];
};

type Base = {
  id: string;
  name: string;
  visible: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  opacity: number;
  // A CSS mix-blend-mode name, "normal" by default.
  blend: string;
  fills: Paint[];
  strokes: Stroke[];
  shadows: Shadow[];
  radius: number;
  // Set when the parent has a layout: how this node sizes along each axis,
  // and whether it ignores the layout.
  child?: { h: Sizing; v: Sizing; absolute: boolean };
};

export type Node =
  | (Base & { kind: "frame"; clip: boolean; layout?: Layout; children: Node[] })
  | (Base & { kind: "group"; mask: boolean; children: Node[] })
  | (Base & { kind: "rect" })
  | (Base & { kind: "ellipse" })
  | (Base & { kind: "text"; text: Text })
  | (Base & { kind: "svg"; asset: string });

export type Asset = { mime: string; base64: string };

// `warnings` names what the reader saw but the model cannot carry.
export type Design = {
  source: string;
  root: Node;
  assets: Record<string, Asset>;
  warnings: string[];
};

export function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  if ("children" in node) for (const child of node.children) walk(child, visit);
}
