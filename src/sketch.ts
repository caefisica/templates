// Renders a large JSON value as a short outline: long strings are cut, long
// arrays show their first items and a count, and nesting stops at a depth.

export type SketchLimits = { depth: number; items: number; text: number };

export const defaultLimits: SketchLimits = { depth: 4, items: 3, text: 60 };

export function sketch(value: unknown, limits: SketchLimits = defaultLimits): string {
  return render(value, limits, 0, "");
}

function render(value: unknown, limits: SketchLimits, depth: number, indent: string): string {
  if (value === null || typeof value !== "object") return scalar(value, limits);
  if (depth >= limits.depth) return collapsed(value);

  const line = oneLine(value, limits, depth);
  if (line.length <= lineWidth) return line;

  const inner = indent + "  ";
  if (Array.isArray(value)) {
    const shown = value
      .slice(0, limits.items)
      .map((item) => inner + render(item, limits, depth + 1, inner));
    return `[\n${[...shown, ...more(value, limits, inner)].join(",\n")}\n${indent}]`;
  }
  const lines = Object.entries(value).map(
    ([key, item]) => `${inner}${key}: ${render(item, limits, depth + 1, inner)}`,
  );
  return `{\n${lines.join(",\n")}\n${indent}}`;
}

const lineWidth = 80;

function oneLine(value: unknown, limits: SketchLimits, depth: number): string {
  if (value === null || typeof value !== "object") return scalar(value, limits);
  if (depth >= limits.depth) return collapsed(value);
  if (Array.isArray(value)) {
    const shown = value.slice(0, limits.items).map((item) => oneLine(item, limits, depth + 1));
    return `[${[...shown, ...more(value, limits, "")].join(", ")}]`;
  }
  const entries = Object.entries(value).map(
    ([key, item]) => `${key}: ${oneLine(item, limits, depth + 1)}`,
  );
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

function scalar(value: unknown, limits: SketchLimits): string {
  if (typeof value !== "string") return String(value);
  const cut =
    value.length > limits.text ? `${value.slice(0, limits.text)}… (${value.length} chars)` : value;
  return JSON.stringify(cut);
}

function collapsed(value: object): string {
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[… ${value.length} items]`;
  const keys = Object.keys(value);
  return keys.length === 0 ? "{}" : `{… ${keys.join(", ")}}`;
}

function more(items: unknown[], limits: SketchLimits, indent: string): string[] {
  return items.length > limits.items ? [`${indent}… ${items.length - limits.items} more`] : [];
}

// Follows a dotted path such as "kids.0.name" into a value.
export function pick(value: unknown, path: string): unknown {
  if (path === "") return value;
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object")
      throw new Error(`path ${path} stops at ${key}`);
    return (current as Record<string, unknown>)[key];
  }, value);
}
