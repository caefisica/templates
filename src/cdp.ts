// A minimal Chrome DevTools Protocol client over Bun's WebSocket.

export type Tab = { id: string; title: string; url: string; webSocketDebuggerUrl: string };

export const cdpUrl = process.env.CDP_URL ?? "http://127.0.0.1:9222";

export async function listTabs(): Promise<Tab[]> {
  const response = await fetch(`${cdpUrl}/json/list`).catch((error) => {
    throw new Error(`no browser at ${cdpUrl} (${error}); start one with a debug port or tunnel it`);
  });
  const targets = (await response.json()) as (Tab & { type: string })[];
  return targets.filter((target) => target.type === "page");
}

// Picks the tab whose URL or title contains `match`, so "figma.com/design" or a file name selects it.
export async function findTab(match: string): Promise<Tab> {
  const tabs = await listTabs();
  const found = tabs.filter((tab) => tab.url.includes(match) || tab.title.includes(match));
  if (found.length === 0)
    throw new Error(`no tab matches "${match}"; open tabs:\n${formatTabs(tabs)}`);
  return found[0]!;
}

// Opens `url` in a new tab. Chrome reads the whole query as the URL.
export async function openTab(url: string): Promise<Tab> {
  const response = await fetch(`${cdpUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok)
    throw new Error(`cannot open ${url}: ${response.status} ${await response.text()}`);
  return (await response.json()) as Tab;
}

export function formatTabs(tabs: Tab[]): string {
  return tabs.map((tab) => `  ${tab.title.slice(0, 60)}  ${tab.url.slice(0, 100)}`).join("\n");
}

export class Session {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();

  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  static async open(tab: Tab): Promise<Session> {
    const socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot attach to ${tab.url}`)), {
        once: true,
      });
    });
    const session = new Session(socket);
    // Chrome stops rendering in background tabs, and Figma's raster export
    // then never resolves, so every session works on the front tab.
    await session.send("Page.bringToFront");
    return session;
  }

  send(method: string, params: object = {}): Promise<any> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  // Runs `expression` in the page and returns its awaited value as JSON.
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`page threw: ${detail}`);
    }
    return result.result.value as T;
  }

  // Runs a self-contained function in the page with JSON arguments.
  call<A, T>(fn: (args: A) => Promise<T>, args: A): Promise<T> {
    return this.evaluate<T>(`(${fn.toString()})(${JSON.stringify(args)})`);
  }

  // Polls `expression` until it is truthy, for up to `seconds`.
  async waitFor(expression: string, seconds: number): Promise<boolean> {
    for (const deadline = Date.now() + seconds * 1000; Date.now() < deadline; await Bun.sleep(250))
      if (await this.evaluate<boolean>(`!!(${expression})`).catch(() => false)) return true;
    return false;
  }

  close(): void {
    this.socket.close();
  }
}
