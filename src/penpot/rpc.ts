// Calls Penpot's RPC API at /api/main/methods with an access token.

import { homedir } from "node:os";
import { join } from "node:path";

export type Rpc = {
  json<T = any>(method: string, params: object): Promise<T>;
  // A transit body in, the transit text out.
  transit(method: string, body: unknown[]): Promise<string>;
  // A multipart body in, JSON out; upload-chunk takes one.
  form<T = any>(method: string, body: FormData): Promise<T>;
};

// PENPOT_TOKEN, else the token file, else null.
export async function penpotToken(): Promise<string | null> {
  if (process.env.PENPOT_TOKEN) return process.env.PENPOT_TOKEN;
  const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const file = Bun.file(join(config, "templates", "penpot-token"));
  return (await file.exists()) ? (await file.text()).trim() : null;
}

export function rpc(origin: string, token: string): Rpc {
  const call = async (method: string, body: BodyInit, headers: Record<string, string>) => {
    const response = await fetch(`${origin}/api/main/methods/${method}`, {
      method: "POST",
      headers: { authorization: `Token ${token}`, ...headers },
      body,
    });
    if (!response.ok)
      throw new Error(`Penpot ${method}: ${response.status} ${await response.text()}`);
    return response;
  };
  const typed = (type: string) => ({ "content-type": type, accept: type });
  return {
    json: (method, params) =>
      call(method, JSON.stringify(params), typed("application/json")).then((r) => r.json()),
    transit: (method, body) =>
      call(method, JSON.stringify(body), typed("application/transit+json")).then((r) => r.text()),
    form: (method, body) =>
      call(method, body, { accept: "application/json" }).then((r) => r.json()),
  };
}
