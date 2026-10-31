// The shapes both page backends return, so the CLI treats Figma and Penpot alike.

// `section` names the Figma sections that hold the frame, outermost first.
// `page` is the Penpot page that holds it: a Penpot id is unique within a page
// only, and a duplicated page keeps its shapes' ids.
export type FrameInfo = {
  id: string;
  name: string;
  w: number;
  h: number;
  section?: string;
  page?: string;
};

export type PageInfo = { id: string; name: string; frames: FrameInfo[] };

// A layer a template can edit, addressed by the names from the frame down,
// joined by "/". One path can match several layers; a field sets them all.
export type Layer = { path: string; kind: "text" | "image"; value: string; count: number };

// A list replaces a row and its siblings of the same type with one copy of the
// row per item, each filled from the item's values, keyed by path below the row.
export type Value =
  | { kind: "text"; text: string }
  | { kind: "image"; mime: string; width: number; height: number; base64: string }
  | { kind: "hidden" }
  | { kind: "list"; items: Variant[] };

// Values keyed by layer path.
export type Variant = Record<string, Value>;

// A text a variant pushed past an edge of a frame that clips its content,
// by `px` at its furthest edge. A text the design already ran past an edge
// counts only when it reaches further.
export type Overflow = { path: string; edge: "left" | "right" | "top" | "bottom"; px: number };

// One variant's export.
export type Rendered = { bytes: Uint8Array; overflow: Overflow[] };

export type Format = "png" | "jpg" | "pdf" | "svg";

export const formats: Format[] = ["png", "jpg", "pdf", "svg"];
