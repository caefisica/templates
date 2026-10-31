// Connects to the browser tab that shows a design and offers the same calls
// for Figma and Penpot. The browser is the user's own, logged in to both, and
// reached over CDP; see src/cdp.ts.

import { listTabs, openTab, Session } from "./cdp";
import type { Format, FrameInfo, Layer, PageInfo, Variant } from "./design";
import { figmaFrame, figmaLayers, figmaPages, figmaRender } from "./figma/page";
import { penpotFrame, penpotLayers, penpotOpen, penpotPages, penpotRender } from "./penpot/page";
import { tabMatch, type Target } from "./url";

export type Backend = {
  target: Target;
  session: Session;
  pages(): Promise<PageInfo[]>;
  // A frame by id at any depth; see figmaFrame and penpotFrame for reach.
  frame(id: string): Promise<FrameInfo | null>;
  layers(frame: string): Promise<Layer[]>;
  // Yields each variant's export in order, as its batch finishes.
  render(
    frame: string,
    variants: Variant[],
    format: Format,
    scale: number,
  ): AsyncGenerator<Uint8Array>;
  close(): void;
};

// Variants per page call. Penpot exports a batch in parallel on its server;
// the cap also bounds the size of one CDP reply.
const batch = 4;

export async function connect(target: Target): Promise<Backend> {
  const tab =
    (await listTabs()).find((t) => t.url.includes(tabMatch(target))) ?? (await openTab(target.url));
  const session = await Session.open(tab);
  const ready =
    target.tool === "figma"
      ? "typeof figma === 'object' && figma.root"
      : "globalThis['ɵcontext']?.currentPage";
  if (!(await session.waitFor(ready, 60))) {
    session.close();
    throw new Error(
      target.tool === "figma"
        ? `Figma shows no plugin API at ${target.url}: open it in the editor, logged in with edit access`
        : `Penpot shows no workspace at ${target.url}: open it logged in`,
    );
  }
  const figma = target.tool === "figma";
  const prepare = (frame: string) =>
    figma ? Promise.resolve() : session.call(penpotOpen, { frame });
  return {
    target,
    session,
    pages: () =>
      figma ? session.call(figmaPages, undefined) : session.call(penpotPages, undefined),
    frame: (id) => session.call(figma ? figmaFrame : penpotFrame, { id }),
    layers: async (frame) => {
      await prepare(frame);
      return session.call(figma ? figmaLayers : penpotLayers, { frame });
    },
    async *render(frame, variants, format, scale) {
      await prepare(frame);
      for (let i = 0; i < variants.length; i += batch) {
        const encoded = await session.call(figma ? figmaRender : penpotRender, {
          frame,
          variants: variants.slice(i, i + batch),
          format,
          scale,
        });
        for (const b of encoded) yield Uint8Array.fromBase64(b);
      }
    },
    close: () => session.close(),
  };
}
