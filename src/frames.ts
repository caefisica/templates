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

export function pickPage(pages: PageInfo[], key: string): PageInfo {
  const found = pages.filter((p) => p.id === key || p.name === key);
  if (found.length === 1) return found[0]!;
  if (found.length > 1) throw new Error(`${found.length} pages are named "${key}"; pass its id`);
  throw new Error(`no page "${key}"; the pages are ${pages.map((p) => p.name).join(", ")}`);
}
