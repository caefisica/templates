// Reads a Figma or Penpot design URL into the file and frame it names.

export type Target =
  | { tool: "figma"; url: string; file: string; frame?: string }
  | { tool: "penpot"; url: string; origin: string; team: string; file: string; page?: string };

export function parseUrl(url: string): Target {
  const parsed = new URL(url);
  if (parsed.hostname.endsWith("figma.com")) {
    const file = parsed.pathname.match(/^\/(?:design|file|proto)\/([^/]+)/)?.[1];
    if (!file) throw new Error(`no Figma file key in ${url}`);
    // The URL writes node 52:2 as 52-2.
    const frame = parsed.searchParams.get("node-id")?.replace("-", ":");
    return { tool: "figma", url, file, ...(frame && { frame }) };
  }
  // Penpot keeps the workspace parameters in the hash or, after a redirect, in the query.
  const params = new URLSearchParams(parsed.hash.replace(/^#[^?]*\?/, "") || parsed.search);
  const team = params.get("team-id");
  const file = params.get("file-id");
  if (!team || !file)
    throw new Error(`${url} is neither a Figma design URL nor a Penpot workspace URL`);
  const page = params.get("page-id");
  return { tool: "penpot", url, origin: parsed.origin, team, file, ...(page && { page }) };
}

// The text a browser tab's URL contains when it shows this file.
export function tabMatch(target: Target): string {
  return target.tool === "figma" ? `/${target.file}` : `file-id=${target.file}`;
}
