// Reads the family, weight and style a TrueType or OpenType font file declares.

export type FontInfo = {
  family: string;
  weight: number;
  style: "normal" | "italic";
  mtype: "font/ttf" | "font/otf";
  // An fvar table: the font has axes, such as a variable weight.
  variable: boolean;
};

// The weights Penpot accepts for a team font.
const weights = [100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

export function readFont(bytes: Uint8Array): FontInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) throw new Error("not a font file");
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  const signature = tag(0);
  const mtype =
    signature === "OTTO"
      ? "font/otf"
      : signature === "\0\x01\0\0" || signature === "true"
        ? "font/ttf"
        : null;
  if (!mtype)
    throw new Error(
      signature.startsWith("wOF")
        ? "WOFF files carry no readable tables here; upload the TTF or OTF"
        : "not a TrueType or OpenType font",
    );

  const tables = new Map<string, number>();
  for (let i = 0, n = view.getUint16(4); i < n; i++)
    tables.set(tag(12 + i * 16), view.getUint32(12 + i * 16 + 8));
  const os2 = tables.get("OS/2");
  const names = tables.get("name");
  if (os2 === undefined || names === undefined) throw new Error("font has no OS/2 or name table");

  const family = readName(view, names, 16) ?? readName(view, names, 1);
  if (!family) throw new Error("font names no family");
  const weightClass = view.getUint16(os2 + 4);
  const weight = weights.reduce((a, b) =>
    Math.abs(b - weightClass) < Math.abs(a - weightClass) ? b : a,
  );
  // Some files flag italic only in the subfamily name (Satoshi Black Italic).
  const subfamily = readName(view, names, 17) ?? readName(view, names, 2) ?? "";
  const italic = (view.getUint16(os2 + 62) & 1) === 1 || /italic|oblique/i.test(subfamily);
  return {
    family,
    weight,
    style: italic ? "italic" : "normal",
    mtype,
    variable: tables.has("fvar"),
  };
}

// Name `id` from the name table at `at`: the US English Windows record, else
// any Windows record, else a Macintosh one.
function readName(view: DataView, at: number, id: number): string | null {
  const count = view.getUint16(at + 2);
  const strings = at + view.getUint16(at + 4);
  type Found = { rank: number; offset: number; length: number; utf16: boolean };
  let best: Found | null = null;
  for (let i = 0; i < count; i++) {
    const r = at + 6 + i * 12;
    if (view.getUint16(r + 6) !== id) continue;
    const platform = view.getUint16(r);
    const language = view.getUint16(r + 4);
    const rank = platform === 3 ? (language === 0x409 ? 0 : 1) : platform === 1 ? 2 : 3;
    if (rank === 3 || (best && best.rank <= rank)) continue;
    const length = view.getUint16(r + 8);
    best = { rank, offset: strings + view.getUint16(r + 10), length, utf16: platform === 3 };
  }
  if (!best) return null;
  let text = "";
  if (best.utf16)
    for (let i = 0; i < best.length; i += 2)
      text += String.fromCharCode(view.getUint16(best.offset + i));
  else
    for (let i = 0; i < best.length; i++)
      text += String.fromCharCode(view.getUint8(best.offset + i));
  return text.trim() || null;
}
