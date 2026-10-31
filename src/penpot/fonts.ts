// Lists and adds a Penpot team's own fonts over the RPC API.

import type { FontInfo } from "../font";
import type { Rpc } from "./rpc";

export type TeamFont = { fontId: string; family: string; weight: number; style: string };

// The chunk size Penpot's own font upload uses.
const chunkSize = 10 * 1024 * 1024;

export async function teamFonts(api: Rpc, team: string): Promise<TeamFont[]> {
  const variants: any[] = await api.json("get-font-variants", { teamId: team });
  return variants.map((v) => ({
    fontId: v.fontId,
    family: v.fontFamily,
    weight: Number(v.fontWeight),
    style: v.fontStyle,
  }));
}

// Adds one file as a variant of `family`, under the font id the team already
// gives that family, so Penpot lists the weights as one font. Returns null
// when the team already has this weight and style.
export async function addFont(
  api: Rpc,
  team: string,
  bytes: Uint8Array<ArrayBuffer>,
  font: FontInfo & { family: string },
  existing: TeamFont[],
): Promise<TeamFont | null> {
  const same = existing.filter((f) => f.family === font.family);
  if (same.some((f) => f.weight === font.weight && f.style === font.style)) return null;
  const fontId = same[0]?.fontId ?? crypto.randomUUID();
  const session = await upload(api, bytes, font.mtype);
  // Transit keeps the uploads map's keys as strings; JSON would make them keywords.
  await api.transit("create-font-variant", [
    "^ ",
    "~:team-id",
    `~u${team}`,
    "~:font-id",
    `~u${fontId}`,
    "~:font-family",
    font.family,
    "~:font-weight",
    font.weight,
    "~:font-style",
    font.style,
    "~:uploads",
    ["^ ", font.mtype, `~u${session}`],
  ]);
  return { fontId, family: font.family, weight: font.weight, style: font.style };
}

// Uploads `bytes` in chunks and returns the session id that holds them.
async function upload(api: Rpc, bytes: Uint8Array<ArrayBuffer>, mtype: string): Promise<string> {
  const totalChunks = Math.ceil(bytes.length / chunkSize);
  const { sessionId } = await api.json("create-upload-session", { totalChunks });
  for (let index = 0; index < totalChunks; index++) {
    const form = new FormData();
    form.append("session-id", sessionId);
    form.append("index", String(index));
    const chunk = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
    form.append("content", new Blob([chunk], { type: mtype }), `chunk-${index}`);
    await api.form("upload-chunk", form);
  }
  return sessionId;
}
