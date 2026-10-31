import type { FrameInfo, PageInfo } from "./design";

// Neighbouring frames in one section with the same name and size, such as a
// slide deck, which `pages` prints as one line.
export type FrameRun = { first: FrameInfo; count: number };

export function frameRuns(frames: FrameInfo[]): FrameRun[] {
  const runs: FrameRun[] = [];
  for (const frame of frames) {
    const last = runs.at(-1)?.first;
    const same =
      last &&
      last.section === frame.section &&
      last.name === frame.name &&
      last.w === frame.w &&
      last.h === frame.h;
    if (same) runs.at(-1)!.count++;
    else runs.push({ first: frame, count: 1 });
  }
  return runs;
}

// The top-level frame `key` names by id or name, or null. `page` settles a key
// that several pages match, such as an id on a duplicated Penpot page.
export function pickFrame(pages: PageInfo[], key: string, page?: string): FrameInfo | null {
  const all = pages.flatMap((p) => p.frames.filter((f) => f.id === key || f.name === key));
  const onPage = all.filter((f) => f.page === page);
  const found = page && onPage.length > 0 ? onPage : all;
  if (found.length === 1) return found[0]!;
  if (found.length === 0) return null;
  if (found.every((f) => f.id === found[0]!.id)) {
    const names = pages.filter((p) => found.some((f) => f.page === p.id)).map((p) => p.name);
    throw new Error(
      `frame ${key} is on pages ${names.join(", ")}; open the one you want and pass its URL, which names its page`,
    );
  }
  throw new Error(`${found.length} frames are named "${key}"; pass an id with --frame`);
}

export function pickPage(pages: PageInfo[], key: string): PageInfo {
  const found = pages.filter((p) => p.id === key || p.name === key);
  if (found.length === 1) return found[0]!;
  if (found.length > 1) throw new Error(`${found.length} pages are named "${key}"; pass its id`);
  throw new Error(`no page "${key}"; the pages are ${pages.map((p) => p.name).join(", ")}`);
}
