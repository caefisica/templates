import { expect, test } from "bun:test";
import { readFont } from "./font";

// A font file with a name table, an OS/2 table and, when asked, an fvar table.
// `names` maps a name id to [platform, language, text].
function sfnt(o: {
  signature?: string;
  names: [number, number, number, string][];
  weightClass: number;
  fsSelection?: number;
  fvar?: boolean;
}): Uint8Array {
  const name = nameTable(o.names);
  const os2 = new Uint8Array(78);
  new DataView(os2.buffer).setUint16(4, o.weightClass);
  new DataView(os2.buffer).setUint16(62, o.fsSelection ?? 0);
  const tables: [string, Uint8Array][] = [
    ["OS/2", os2],
    ["name", name],
    ...(o.fvar ? [["fvar", new Uint8Array(16)] as [string, Uint8Array]] : []),
  ];
  let offset = 12 + tables.length * 16;
  const out = new Uint8Array(offset + tables.reduce((n, [, t]) => n + t.length, 0));
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(o.signature ?? "OTTO"));
  view.setUint16(4, tables.length);
  tables.forEach(([tag, data], i) => {
    out.set(new TextEncoder().encode(tag), 12 + i * 16);
    view.setUint32(12 + i * 16 + 8, offset);
    view.setUint32(12 + i * 16 + 12, data.length);
    out.set(data, offset);
    offset += data.length;
  });
  return out;
}

function nameTable(records: [number, number, number, string][]): Uint8Array {
  const strings = records.map(([, platform, , text]) =>
    platform === 3
      ? new Uint8Array([...text].flatMap((c) => [0, c.charCodeAt(0)]))
      : new TextEncoder().encode(text),
  );
  const head = 6 + records.length * 12;
  const out = new Uint8Array(head + strings.reduce((n, s) => n + s.length, 0));
  const view = new DataView(out.buffer);
  view.setUint16(2, records.length);
  view.setUint16(4, head);
  let at = 0;
  records.forEach(([id, platform, language], i) => {
    const r = 6 + i * 12;
    view.setUint16(r, platform);
    view.setUint16(r + 4, language);
    view.setUint16(r + 6, id);
    view.setUint16(r + 8, strings[i]!.length);
    view.setUint16(r + 10, at);
    out.set(strings[i]!, head + at);
    at += strings[i]!.length;
  });
  return out;
}

test("the preferred family wins over the style-linked one", () => {
  const font = sfnt({
    names: [
      [1, 3, 0x409, "Satoshi Black"],
      [16, 3, 0x409, "Satoshi"],
      [2, 3, 0x409, "Regular"],
    ],
    weightClass: 900,
  });
  expect(readFont(font)).toEqual({
    family: "Satoshi",
    weight: 900,
    style: "normal",
    mtype: "font/otf",
    variable: false,
  });
});

test("US English Windows names win over other languages and Macintosh names", () => {
  const font = sfnt({
    signature: "\0\x01\0\0",
    names: [
      [1, 1, 0, "Mac Name"],
      [1, 3, 0x40c, "Nom"],
      [1, 3, 0x409, "Name"],
    ],
    weightClass: 400,
  });
  expect(readFont(font)).toMatchObject({ family: "Name", mtype: "font/ttf" });
  const mac = sfnt({ names: [[1, 1, 0, "Mac Name"]], weightClass: 400 });
  expect(readFont(mac).family).toBe("Mac Name");
});

test("the weight snaps to one Penpot accepts", () => {
  const weight = (weightClass: number) =>
    readFont(sfnt({ names: [[1, 3, 0x409, "F"]], weightClass })).weight;
  expect(weight(350)).toBe(300);
  expect(weight(380)).toBe(400);
  expect(weight(1000)).toBe(950);
  expect(weight(1)).toBe(100);
});

test("italic comes from fsSelection or from the subfamily name", () => {
  const style = (fsSelection: number, subfamily: string) =>
    readFont(
      sfnt({
        names: [
          [1, 3, 0x409, "F"],
          [2, 3, 0x409, subfamily],
        ],
        weightClass: 400,
        fsSelection,
      }),
    ).style;
  expect(style(1, "Regular")).toBe("italic");
  expect(style(0x40, "Black Italic")).toBe("italic");
  expect(style(0x40, "Regular")).toBe("normal");
});

test("an fvar table marks a variable font", () => {
  expect(
    readFont(sfnt({ names: [[1, 3, 0x409, "F"]], weightClass: 400, fvar: true })).variable,
  ).toBe(true);
});

test("WOFF and other files are refused", () => {
  const woff2 = sfnt({ signature: "wOF2", names: [[1, 3, 0x409, "F"]], weightClass: 400 });
  expect(() => readFont(woff2)).toThrow("upload the TTF or OTF");
  expect(() => readFont(new TextEncoder().encode("hello, this is text"))).toThrow(
    "not a TrueType or OpenType font",
  );
});
