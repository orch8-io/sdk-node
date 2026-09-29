// @vitest-environment jsdom
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserWorker } from "../browser/index.js";

// A dedicated-worker stand-in: runs the Blob's source in a fresh VM realm
// that only has worker-like globals (no access to the test's scope), bridging
// postMessage asynchronously and structured-cloning every message.
function installFakeWorker(fetchImpl: typeof fetch, options: { failConstruct?: boolean } = {}) {
  const blobs = new Map<string, string>();
  const created: FakeWorker[] = [];
  let seq = 0;
  class FakeBlob {
    constructor(readonly parts: string[]) {}
  }
  class FakeWorker {
    private readonly toPage = new Map<string, Array<(event: { data: unknown }) => void>>();
    private toWorker: ((event: { data: unknown }) => void) | null = null;
    terminated = false;
    constructor(url: string) {
      if (options.failConstruct) throw new DOMException("blocked by CSP", "SecurityError");
      created.push(this);
      const source = blobs.get(url);
      if (!source) throw new Error("unknown blob URL");
      const self = {
        postMessage: (message: unknown) => {
          const data = structuredClone(message);
          setTimeout(() => {
            if (!this.terminated) for (const l of this.toPage.get("message") ?? []) l({ data });
          }, 0);
        },
        addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
          if (type === "message") this.toWorker = listener;
        },
        fetch: fetchImpl,
      };
      runInNewContext(source, { self, setTimeout, clearTimeout, AbortController, Date });
    }
    postMessage(message: unknown) {
      const data = structuredClone(message);
      setTimeout(() => {
        if (!this.terminated) this.toWorker?.({ data });
      }, 0);
    }
    addEventListener(type: string, listener: (event: { data: unknown }) => void) {
      this.toPage.set(type, [...(this.toPage.get(type) ?? []), listener]);
    }
    terminate() {
      this.terminated = true;
    }
  }
  vi.stubGlobal("Blob", FakeBlob);
  vi.stubGlobal("Worker", FakeWorker);
  // jsdom has no object URLs; define them for the duration of the test.
  Object.assign(URL, {
    createObjectURL: (blob: unknown) => {
      const url = `blob:fake/${++seq}`;
      blobs.set(url, (blob as FakeBlob).parts.join(""));
      return url;
    },
    revokeObjectURL: (url: string) => {
      blobs.delete(url);
    },
  });
  return { created };
}

function fakeFetch() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const pending = [
    {
      id: "task-1", instance_id: "i", block_id: "b", handler_name: "confirm", queue_name: null,
      params: { q: 1 }, context: {}, attempt: 1, timeout_ms: null, state: "claimed", worker_id: "tab-1",
      claimed_at: null, heartbeat_at: null, completed_at: null, output: null, error_message: null,
      error_retryable: null, created_at: "", claim_epoch: 3, checkpoint_seq: 0, effect_id: "eff-9",
    },
  ];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace("https://engine.test", "");
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : {} });
    const body = path.endsWith("/poll") ? { tasks: pending.splice(0), lease_secs: 30 } : undefined;
    return {
      status: body ? 200 : 204,
      ok: true,
      text: async () => (body ? JSON.stringify(body) : ""),
    } as Response;
  });
  return { calls, fetch: impl as unknown as typeof fetch };
}

async function flush(rounds = 30): Promise<void> {
  // 1 ms steps: postMessage hops are modelled as timers.
  for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(1);
}

const token = async () => ({ token: "tok", expiresAt: Date.now() + 600_000, runtimeId: "tab-1" });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (URL as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
});

describe("BrowserWorker in a dedicated Web Worker", () => {
  it("runs the lease loop in the worker and the handler on the page", async () => {
    const server = fakeFetch();
    const { created } = installFakeWorker(server.fetch);
    const seen: unknown[] = [];
    // The page-side fetch is only used for keepalive releases.
    const worker = new BrowserWorker({ baseUrl: "https://engine.test", getToken: token, fetch: server.fetch });
    worker.register("confirm", async (input, ctx) => {
      seen.push(input, ctx.effectId, typeof document.querySelector);
      return { ok: true };
    });
    const starting = worker.start();
    await flush();
    await starting;
    expect(worker.mode).toBe("worker");
    expect(created).toHaveLength(1);
    await flush();

    expect(seen).toEqual([{ q: 1 }, "eff-9", "function"]);
    const poll = server.calls.find((c) => c.path.endsWith("/poll"))!;
    expect(poll.body.capabilities).toMatchObject({ kind: "browser", runtime_id: "tab-1" });
    const complete = server.calls.find((c) => c.path.endsWith("/complete"))!;
    expect(complete.body).toEqual({ worker_id: "tab-1", claim_epoch: 3, output: { ok: true } });
    await worker.stop();
    expect(created[0].terminated).toBe(true);
  });

  it("falls back to the main thread when the worker is blocked", async () => {
    const server = fakeFetch();
    installFakeWorker(server.fetch, { failConstruct: true });
    const worker = new BrowserWorker({ baseUrl: "https://engine.test", getToken: token, fetch: server.fetch });
    worker.register("confirm", async () => ({}));
    await worker.start();
    expect(worker.mode).toBe("main");
    await flush();
    expect(server.calls.some((c) => c.path.endsWith("/complete"))).toBe(true);
    await worker.stop();
  });

  it("mode: 'worker' refuses to fall back", async () => {
    installFakeWorker(fakeFetch().fetch, { failConstruct: true });
    const worker = new BrowserWorker({ baseUrl: "https://engine.test", getToken: token, mode: "worker" });
    worker.register("confirm", async () => ({}));
    await expect(worker.start()).rejects.toThrow(/Web Workers are unavailable/);
  });
});
