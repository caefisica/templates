#!/usr/bin/env bun
// templates: turn a Figma or Penpot frame into a template and render it from data.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Backend, connect } from "./backend";
import { formats, type Format, type FrameInfo, type Layer } from "./design";
import { readFigma } from "./figma/read";
import { plan, readRows, variant } from "./data";
import { penpotFreeX } from "./penpot/page";
import { writePenpot } from "./penpot/write";
import { chooseFields, drift, type Template } from "./template";
import { parseUrl } from "./url";

const usage = `usage:
  templates pages <url>                         list pages and their frames
  templates layers <url> [--frame F]            list the frame's text and image layers
  templates init <url> [--frame F] [--field name=layer]... [--out template.json]
  templates render <template.json> --data rows.csv [--on url] [--format png|jpg|pdf|svg] [--scale N] [--out dir]
  templates check <template.json> [--on url]    report fields whose layer is gone or changed
  templates copy <figma-url> --to <penpot-url> [--frame F]

<url> is a Figma design URL or a Penpot workspace URL, open in the browser on
CDP_URL (default http://127.0.0.1:9222). F is a frame id or name; a Figma URL
with node-id names one. --on renders or checks another design, such as the
Penpot copy, and finds the frame there by name.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    frame: { type: "string" },
    field: { type: "string", multiple: true, default: [] },
    out: { type: "string" },
    data: { type: "string" },
    on: { type: "string" },
    to: { type: "string" },
    format: { type: "string", default: "png" },
    scale: { type: "string", default: "1" },
  },
});

const [command, subject] = positionals;
const commands: Record<string, (subject: string) => Promise<void>> = {
  pages,
  layers,
  init,
  render,
  check,
  copy,
};
const run = command && subject ? commands[command] : undefined;
if (!run) {
  console.error(usage);
  process.exit(2);
}
await run(subject!).catch((error: Error) => {
  console.error(`templates: ${error.message}`);
  process.exit(1);
});

async function pages(url: string) {
  await using backend = await open(url);
  for (const page of await backend.pages()) {
    console.log(`${page.name}  (${page.id})`);
    for (const f of page.frames) console.log(`  ${f.id.padEnd(12)}  ${f.name}  ${f.w}×${f.h}`);
  }
}

async function layers(url: string) {
  await using backend = await open(url);
  const frame = await findFrame(backend, values.frame);
  printLayers(await backend.layers(frame.id));
}

async function init(url: string) {
  const out = values.out ?? "template.json";
  if (await Bun.file(out).exists()) throw new Error(`${out} exists; pass another --out`);
  await using backend = await open(url);
  const frame = await findFrame(backend, values.frame);
  const fields = chooseFields(await backend.layers(frame.id), values.field!);
  const template: Template = { design: url, frame: { id: frame.id, name: frame.name }, fields };
  await Bun.write(out, JSON.stringify(template, null, 2) + "\n");
  console.log(`${out}: ${frame.name}`);
  for (const f of fields) console.log(`  ${f.name.padEnd(12)} ${f.kind.padEnd(5)}  ${f.layer}`);
}

async function render(templatePath: string) {
  if (!values.data) throw new Error("render needs --data rows.csv or rows.json");
  const format = values.format as Format;
  if (!formats.includes(format)) throw new Error(`--format must be one of ${formats.join(", ")}`);
  const template = await readTemplate(templatePath);
  const plans = plan(template, await readRows(values.data));
  const variants = await Promise.all(plans.map((p) => variant(template, p.cells, values.data!)));
  const outDir = values.out ?? "out";
  await mkdir(outDir, { recursive: true });

  await using backend = await open(values.on ?? template.design);
  const frame = await templateFrame(backend, template);
  let i = 0;
  for await (const bytes of backend.render(frame.id, variants, format, Number(values.scale))) {
    const path = join(outDir, `${plans[i++]!.file}.${format}`);
    await Bun.write(path, bytes);
    console.log(`${path}  ${Math.round(bytes.length / 1024)} KB`);
  }
}

async function check(templatePath: string) {
  const template = await readTemplate(templatePath);
  await using backend = await open(values.on ?? template.design);
  const frame = await templateFrame(backend, template);
  const problems = drift(template, await backend.layers(frame.id));
  if (problems.length === 0)
    return console.log(`${frame.name}: all ${template.fields.length} fields match`);
  for (const line of problems) console.log(line);
  process.exitCode = 1;
}

async function copy(url: string) {
  if (!values.to) throw new Error("copy needs --to <penpot-url>");
  await using source = await open(url);
  if (source.target.tool !== "figma") throw new Error("copy reads from Figma");
  const frame = await findFrame(source, values.frame);
  const design = await source.session.call(readFigma, { id: frame.id });

  await using dest = await open(values.to);
  if (dest.target.tool !== "penpot") throw new Error("copy writes to Penpot");
  const x = await dest.session.call(penpotFreeX, undefined);
  const made = await dest.session.call(writePenpot, { design, x, y: 0 });
  console.log(`${frame.name} → Penpot board ${made.id}`);
  for (const warning of [...design.warnings, ...made.warnings])
    console.log(`  warning: ${warning}`);
}

async function open(url: string): Promise<Backend & AsyncDisposable> {
  const backend = await connect(parseUrl(url));
  return { ...backend, [Symbol.asyncDispose]: async () => backend.close() };
}

async function readTemplate(path: string): Promise<Template> {
  return (await Bun.file(path).json()) as Template;
}

// The frame named by --frame, else by the URL.
async function findFrame(backend: Backend, wanted: string | undefined): Promise<FrameInfo> {
  const target = backend.target;
  const key = wanted ?? (target.tool === "figma" ? target.frame : undefined);
  const frames = (await backend.pages()).flatMap((p) => p.frames);
  if (!key)
    throw new Error(
      `name a frame with --frame:\n${frames.map((f) => `  ${f.id}  ${f.name}`).join("\n")}`,
    );
  return pickFrame(frames, key);
}

// The template's frame by id on its own design, by name on any other.
async function templateFrame(backend: Backend, template: Template): Promise<FrameInfo> {
  const frames = (await backend.pages()).flatMap((p) => p.frames);
  return frames.find((f) => f.id === template.frame.id) ?? pickFrame(frames, template.frame.name);
}

function pickFrame(frames: FrameInfo[], key: string): FrameInfo {
  const found = frames.filter((f) => f.id === key || f.name === key);
  if (found.length === 1) return found[0]!;
  if (found.length > 1)
    throw new Error(`${found.length} frames are named "${key}"; pass an id with --frame`);
  throw new Error(`no top-level frame "${key}"; list them with the pages command`);
}

function printLayers(list: Layer[]) {
  list.forEach((layer, i) => {
    const value =
      layer.kind === "text"
        ? JSON.stringify(layer.value.length > 40 ? layer.value.slice(0, 40) + "…" : layer.value)
        : "";
    const count = layer.count > 1 ? ` ×${layer.count}` : "";
    console.log(
      `${String(i + 1).padStart(3)}  ${layer.kind.padEnd(5)}  ${layer.path}${count}  ${value}`,
    );
  });
}
