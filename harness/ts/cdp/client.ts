// CDP client built on Node 22+ global WebSocket and fetch.
//
// We deliberately avoid the chrome-remote-interface package: it adds a
// transitive dep tree we do not need, and the protocol surface we use here
// (Page.navigate, Page.captureScreenshot, Runtime.evaluate, Storage.*) is
// small enough to drive directly.

const GlobalWebSocket = (globalThis as { WebSocket?: typeof globalThis.WebSocket }).WebSocket;
if (!GlobalWebSocket) {
  throw new Error(
    "globalThis.WebSocket is not available; require Node >=22. Got " + process.version,
  );
}

export interface CdpVersion {
  Browser: string;
  "Protocol-Version": string;
  webSocketDebuggerUrl: string;
  [k: string]: unknown;
}

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
  [k: string]: unknown;
}

export async function fetchVersion(port: number): Promise<CdpVersion> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!res.ok) throw new Error(`/json/version returned HTTP ${res.status}`);
  return (await res.json()) as CdpVersion;
}

export async function fetchTargets(port: number): Promise<CdpTarget[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  if (!res.ok) throw new Error(`/json returned HTTP ${res.status}`);
  return (await res.json()) as CdpTarget[];
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface CdpResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      this.onMessage((ev as MessageEvent).data);
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error("CDP session closed"));
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpSession> {
    const Ws = GlobalWebSocket as typeof globalThis.WebSocket;
    const ws = new Ws(url);
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        resolve();
      };
      const onError = (ev: Event): void => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        const msg = (ev as { message?: string }).message ?? "unknown";
        reject(new Error(`CDP websocket error: ${msg}`));
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });
    return new CdpSession(ws);
  }

  private onMessage(data: unknown): void {
    let payload: CdpResponse;
    try {
      payload = JSON.parse(typeof data === "string" ? data : String(data)) as CdpResponse;
    } catch {
      return;
    }
    if (typeof payload.id !== "number") return; // protocol event, not a response
    const p = this.pending.get(payload.id);
    if (!p) return;
    this.pending.delete(payload.id);
    if (payload.error) p.reject(new Error(`CDP ${payload.error.code}: ${payload.error.message}`));
    else p.resolve(payload.result);
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) throw new Error("CDP session is closed");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}
