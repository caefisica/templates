// Loads the headless Penpot engine that engine/build.sh makes. TEMPLATES_ENGINE
// names a directory that holds a local build; otherwise the release build is
// downloaded once into the cache and checked against these hashes.

import { mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Layer } from "../design";

const release = "engine-723267c";

const sha256: Record<string, string> = {
  "engine.js": "c3608d1f28dc3ef579f557a90f22a9f9f3e253ca99baf048260cd1166402f864",
  "render-wasm.js": "d36f8fb63eee2799e2e95e813c925c5b823db16071ba5c02240ec85a54fd46eb",
  "render-wasm.wasm": "105f0a191d643d5f9e5dbd6a77fccb0e5debbb1fdbe6880bebec4e352e03bcb3",
};

export type RenderOptions = {
  // The transit text of a `get-page` response that holds the frame.
  page: string;
  frame: string;
  variants: unknown[];
  format: string;
  scale: number;
  // The Penpot URL with a trailing slash; fonts and images resolve under it.
  origin: string;
  fetch: (url: string) => Promise<ArrayBuffer | null>;
  // The transit text of a `get-font-variants` response, for team fonts.
  fontVariants?: string;
};

export type Engine = {
  render(options: RenderOptions): Promise<Uint8Array[]>;
  layers(page: string, frame: string): Layer[];
};

export async function loadEngine(): Promise<Engine> {
  const dir = process.env.TEMPLATES_ENGINE ?? (await download());
  const mod = await import(join(dir, "engine.js"));
  return {
    render: (options) => mod.render({ ...options, wasmDir: dir }),
    layers: (page, frame) => mod.layers(page, frame),
  };
}

async function download(): Promise<string> {
  const cache = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const dir = join(cache, "templates", release);
  await mkdir(dir, { recursive: true });
  for (const [name, hash] of Object.entries(sha256)) {
    const path = join(dir, name);
    if (await Bun.file(path).exists()) continue;
    const url = `https://github.com/caefisica/templates/releases/download/${release}/${name}.gz`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    const bytes = Bun.gunzipSync(new Uint8Array(await response.arrayBuffer()));
    const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (got !== hash) throw new Error(`${url}: sha256 ${got}, expected ${hash}`);
    await Bun.write(`${path}.part`, bytes);
    await rename(`${path}.part`, path);
  }
  return dir;
}
