// The shapes both page backends return, so the CLI treats Figma and Penpot alike.

export type FrameInfo = { id: string; name: string; w: number; h: number };

export type PageInfo = { id: string; name: string; frames: FrameInfo[] };

// A layer a template can edit, addressed by the names from the frame down,
// joined by "/". One path can match several layers; a field sets them all.
export type Layer = { path: string; kind: "text" | "image"; value: string; count: number };

export type Value =
  | { kind: "text"; text: string }
  | { kind: "image"; mime: string; base64: string };

// Values keyed by layer path.
export type Variant = Record<string, Value>;

export type Format = "png" | "jpg" | "pdf" | "svg";

export const formats: Format[] = ["png", "jpg", "pdf", "svg"];
