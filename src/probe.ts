// probe: run an investigation script in a browser tab, save the full result
// under .probe/, and print only a sketch of it.
//
//   bun probe tabs
//   bun probe run <tab-match> <script> [--name N] [--arg key=value]... [--depth D] [--items I]
//   bun probe show <name> [path] [--depth D] [--items I] [--full]
//
// A script is the body of an async function; `args` holds the --arg values.
// A result with `bytes` (base64) and `ext` also writes .probe/<name>.<ext>.

import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { findTab, formatTabs, listTabs, Session } from "./cdp";
import { defaultLimits, pick, sketch, type SketchLimits } from "./sketch";

const store = ".probe";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    arg: { type: "string", multiple: true, default: [] },
    depth: { type: "string" },
    items: { type: "string" },
    full: { type: "boolean", default: false },
  },
});

const limits: SketchLimits = {
  ...defaultLimits,
  ...(values.depth && { depth: Number(values.depth) }),
  ...(values.items && { items: Number(values.items) }),
};

const [command, ...rest] = positionals;

if (command === "tabs") {
  console.log(formatTabs(await listTabs()));
} else if (command === "run" && rest.length === 2) {
  await run(rest[0]!, rest[1]!);
} else if (command === "show" && rest.length >= 1) {
  await show(rest[0]!, rest[1] ?? "");
} else {
  console.error("usage: probe tabs | probe run <tab-match> <script> | probe show <name> [path]");
  process.exit(2);
}

async function run(match: string, scriptPath: string) {
  const body = await Bun.file(scriptPath).text();
  const args = Object.fromEntries(values.arg!.map((pair) => pair.split(/=(.*)/s).slice(0, 2)));
  const expression = `(async (args) => {\n${body}\n})(${JSON.stringify(args)})`;

  const session = await Session.open(await findTab(match));
  const started = performance.now();
  const result = await session.evaluate<any>(expression).finally(() => session.close());
  const seconds = ((performance.now() - started) / 1000).toFixed(1);

  const name = values.name ?? basename(scriptPath).replace(/\.[^.]+$/, "");
  await mkdir(store, { recursive: true });
  if (result && typeof result.bytes === "string" && typeof result.ext === "string") {
    const file = `${store}/${name}.${result.ext}`;
    await Bun.write(file, Buffer.from(result.bytes, "base64"));
    result.bytes = `<${result.bytes.length} base64 chars written to ${file}>`;
  }
  const json = JSON.stringify(result, null, 2) ?? "undefined";
  await Bun.write(`${store}/${name}.json`, json);

  console.log(`${store}/${name}.json  ${json.length} bytes  ${seconds}s`);
  console.log(sketch(result, limits));
}

async function show(name: string, path: string) {
  const value = pick(await Bun.file(`${store}/${name}.json`).json(), path);
  console.log(values.full ? JSON.stringify(value, null, 2) : sketch(value, limits));
}
