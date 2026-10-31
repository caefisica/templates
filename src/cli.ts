#!/usr/bin/env bun
// templates: turn a Figma or Penpot frame into a template and render it from data.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Backend, connect, connectTab, type TabBackend } from "./backend";
import { formats, type Format, type FrameInfo, type Layer } from "./design";
import { readFigma } from "./figma/read";
import { frameRuns, pickFrame, pickPage } from "./frames";
import { plan, readRows, variant } from "./data";
import { readFont } from "./font";
import { addFont, teamFonts } from "./penpot/fonts";
import { penpotToken, rpc } from "./penpot/rpc";
import { penpotCopyOf, penpotFreeX, penpotRemove } from "./penpot/page";
import { writePenpot } from "./penpot/write";
import { chooseFields, drift, type Template } from "./template";
import { parseUrl, type Target } from "./url";

const usage = `usage:
  templates pages <url> [--page P]              list pages and their frames
  templates layers <url> [--frame F]            list the frame's text and image layers
  templates init <url> [--frame F] [--field name=layer]... [--list name=row]... [--out template.json]
  templates render <template.json> --data rows.csv|rows.json [--on url] [--format png|jpg|pdf|svg] [--scale N] [--out dir]
  templates check <template.json> [--on url]    report fields whose layer is gone or changed
  templates copy <figma-url> --to <penpot-url> [--frame F]
  templates fonts <penpot-url> [file.ttf|file.otf]... [--family name]
                                                list the team's fonts, or add these files to them

<url> is a Figma design URL or a Penpot workspace URL. A Penpot file is read
over its API when PENPOT_TOKEN or ~/.config/templates/penpot-token holds an
access token; anything else runs in the browser on CDP_URL (default
http://127.0.0.1:9222), as copy always does. F is a frame id or name; a Figma URL
with node-id names one. --on renders or checks another design, such as the
Penpot copy, and finds the frame there by name. --list names a repeating row;
--field list.name=layer picks a layer inside it, and a JSON data cell holds
the rows. fonts needs the token; it reads each file's family, weight and style,
and --family files them under another family name, such as the one a Figma
design asks for.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    frame: { type: "string" },
    page: { type: "string" },
    field: { type: "string", multiple: true, default: [] },
    list: { type: "string", multiple: true, default: [] },
    out: { type: "string" },
    data: { type: "string" },
    on: { type: "string" },
    to: { type: "string" },
    family: { type: "string" },
    format: { type: "string", default: "png" },
    scale: { type: "string", default: "1" },
  },
});

const [command, subject, ...files] = positionals;
const commands: Record<string, (subject: string) => Promise<void>> = {
  pages,
  layers,
  init,
  render,
  check,
  copy,
  fonts,
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
  const all = await backend.pages();
  for (const page of values.page ? [pickPage(all, values.page)] : all) {
    console.log(`${page.name}  (${page.id})`);
    for (const { first: f, count } of frameRuns(page.frames))
      console.log(
        `  ${f.id.padEnd(12)}  ${f.section ? `${f.section} / ` : ""}${f.name}  ${f.w}×${f.h}` +
          (count > 1 ? `  ×${count}` : ""),
      );
  }
}

async function layers(url: string) {
  await using backend = await open(url);
  const frame = await findFrame(backend, values.frame);
  printLayers(await backend.layers(frame));
}

async function init(url: string) {
  const out = values.out ?? "template.json";
  if (await Bun.file(out).exists()) throw new Error(`${out} exists; pass another --out`);
  await using backend = await open(url);
  const frame = await findFrame(backend, values.frame);
  const fields = chooseFields(await backend.layers(frame), values.field!, values.list!);
  const { id, name, page } = frame;
  const template: Template = {
    design: url,
    frame: { id, name, ...(page && { page }) },
    fields,
  };
  await Bun.write(out, JSON.stringify(template, null, 2) + "\n");
  console.log(`${out}: ${frame.name}`);
  for (const f of fields) {
    console.log(`  ${f.name.padEnd(12)} ${f.kind.padEnd(5)}  ${f.layer}`);
    if (f.kind === "list")
      for (const sub of f.fields)
        console.log(`    ${sub.name.padEnd(10)} ${sub.kind.padEnd(5)}  ${sub.layer}`);
  }
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
  for await (const { bytes, overflow } of backend.render(
    frame,
    variants,
    format,
    Number(values.scale),
  )) {
    const path = join(outDir, `${plans[i++]!.file}.${format}`);
    await Bun.write(path, bytes);
    console.log(`${path}  ${Math.round(bytes.length / 1024)} KB`);
    for (const o of overflow)
      console.log(`  warning: ${o.path} runs ${o.px} px past the ${o.edge} edge`);
  }
}

async function check(templatePath: string) {
  const template = await readTemplate(templatePath);
  await using backend = await open(values.on ?? template.design);
  const frame = await templateFrame(backend, template);
  const problems = drift(template, await backend.layers(frame));
  if (problems.length === 0)
    return console.log(`${frame.name}: all ${template.fields.length} fields match`);
  for (const line of problems) console.log(line);
  process.exitCode = 1;
}

async function copy(url: string) {
  if (!values.to) throw new Error("copy needs --to <penpot-url>");
  await using source = await openTab(url);
  if (source.target.tool !== "figma") throw new Error("copy reads from Figma");
  const frame = await findFrame(source, values.frame);
  const design = await source.session.call(readFigma, { id: frame.id });

  await using dest = await openTab(values.to);
  if (dest.target.tool !== "penpot") throw new Error("copy writes to Penpot");
  const earlier = await dest.session.call(penpotCopyOf, {
    source: design.source,
  });
  const at = earlier ?? {
    x: await dest.session.call(penpotFreeX, undefined),
    y: 0,
  };
  const made = await dest.session.call(writePenpot, {
    design,
    x: at.x,
    y: at.y,
  });
  if (earlier) await dest.session.call(penpotRemove, { id: earlier.id });
  console.log(
    `${frame.name} → Penpot board ${made.id}` + (earlier ? `, replacing ${earlier.id}` : ""),
  );
  for (const warning of [...design.warnings, ...made.warnings])
    console.log(`  warning: ${warning}`);
}

async function fonts(url: string) {
  const target = parseUrl(url);
  if (target.tool !== "penpot") throw new Error("fonts takes a Penpot workspace URL");
  const token = await penpotToken();
  if (!token) throw new Error("fonts needs a Penpot token in PENPOT_TOKEN or the token file");
  const api = rpc(target.origin, token);
  // Read every file first, so a bad one stops the run before any upload.
  const uploads = await Promise.all(
    files.map(async (path) => {
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
      try {
        const read = readFont(bytes);
        return { path, bytes, font: { ...read, family: values.family ?? read.family } };
      } catch (error) {
        throw new Error(`${path}: ${(error as Error).message}`);
      }
    }),
  );
  const team = await teamFonts(api, target.team);
  for (const { path, bytes, font } of uploads) {
    const label = `${font.family} ${font.weight} ${font.style}`;
    const added = await addFont(api, target.team, bytes, font, team);
    if (!added) {
      console.log(`${path}: the team already has ${label}`);
      continue;
    }
    team.push(added);
    console.log(`${path} → ${label}`);
    if (font.variable)
      console.log(
        `  warning: Penpot draws a variable font at its default instance; add static files for other weights`,
      );
  }
  if (files.length > 0) return;
  const families = Map.groupBy(team, (f) => f.family);
  if (families.size === 0) return console.log("the team has no fonts of its own");
  for (const [family, variants] of families)
    console.log(
      `${family}  ${variants
        .toSorted((a, b) => a.weight - b.weight || b.style.localeCompare(a.style))
        .map((v) => (v.style === "italic" ? `${v.weight}i` : String(v.weight)))
        .join(" ")}`,
    );
}

async function open(url: string): Promise<Backend & AsyncDisposable> {
  return disposable(await connect(parseUrl(url)));
}

// Copying runs page functions, so it always needs the tab.
async function openTab(url: string): Promise<TabBackend & AsyncDisposable> {
  return disposable(await connectTab(parseUrl(url)));
}

function disposable<B extends Backend>(backend: B): B & AsyncDisposable {
  return { ...backend, [Symbol.asyncDispose]: async () => backend.close() };
}

async function readTemplate(path: string): Promise<Template> {
  return (await Bun.file(path).json()) as Template;
}

// The frame named by --frame, else by the URL.
async function findFrame(backend: Backend, wanted: string | undefined): Promise<FrameInfo> {
  const target = backend.target;
  const key = wanted ?? (target.tool === "figma" ? target.frame : undefined);
  const pages = await backend.pages();
  if (!key) {
    const frames = pages.flatMap((p) => p.frames);
    throw new Error(
      `name a frame with --frame:\n${frames.map((f) => `  ${f.id}  ${f.name}`).join("\n")}`,
    );
  }
  const page = urlPage(target);
  return pickFrame(pages, key, page) ?? (await backend.frame(key, page)) ?? missing(key);
}

// The template's frame by id on its own design, by name on any other.
async function templateFrame(backend: Backend, template: Template): Promise<FrameInfo> {
  const pages = await backend.pages();
  const { id, name, page = urlPage(backend.target) } = template.frame;
  return (
    pickFrame(pages, id, page) ??
    (await backend.frame(id, page)) ??
    pickFrame(pages, name) ??
    missing(name)
  );
}

// The page a Penpot URL opens, which settles an id that several pages hold.
function urlPage(target: Target): string | undefined {
  return target.tool === "penpot" ? target.page : undefined;
}

function missing(key: string): never {
  throw new Error(`no frame "${key}"; list them with the pages command`);
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
