// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserWorker,
  LeaseLostError,
  TaskReleasedError,
  type BrowserWorkerEvent,
  type BrowserWorkerOptions,
} from "../browser/index.js";

// ---------------------------------------------------------------------------
// Fake engine API
// ---------------------------------------------------------------------------

interface Call {
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  keepalive: boolean;
  at: number;
}

type Reply = { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    instance_id: "inst-1",
    block_id: "confirm",
    handler_name: "confirm",
    queue_name: null,
    params: { orderId: "o-1", note: "PAGE-SECRET-NOTE" },
    context: { data: {} },
    attempt: 1,
    timeout_ms: null,
    state: "claimed",
    worker_id: "tab-1",
    claimed_at: null,
    heartbeat_at: null,
    completed_at: null,
    output: null,
    error_message: null,
    error_retryable: null,
    created_at: "2026-09-27T00:00:00Z",
    claim_epoch: 7,
    checkpoint_seq: 0,
    effect_id: "eff-123",
    ...overrides,
  };
}

function fakeServer() {
  const calls: Call[] = [];
  let queue: unknown[][] = [];
  const routes: Record<string, (call: Call) => Reply> = {
    poll: () => ({ status: 200, body: { tasks: queue.shift() ?? [], lease_secs: 30 } }),
    heartbeat: () => ({ status: 200, body: { checkpoint_seq: 0 } }),
    complete: () => ({ status: 204 }),
    fail: () => ({ status: 204 }),
    release: () => ({ status: 204 }),
  };
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://engine.test", "");
    const call: Call = {
      path,
      body: init?.body ? JSON.parse(String(init.body)) : {},
      headers: (init?.headers ?? {}) as Record<string, string>,
      keepalive: init?.keepalive === true,
      at: Date.now(),
    };
    calls.push(call);
    const action = path.endsWith("/poll") ? "poll" : path.split("/").pop()!;
    const reply = await routes[action](call);
    return {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      text: async () => (reply.body === undefined ? "" : JSON.stringify(reply.body)),
    } as Response;
  });
  return {
    calls,
    routes,
    fetch: fetchImpl as unknown as typeof fetch,
    enqueue: (...tasks: unknown[]) => queue.push(tasks),
    reset: () => { queue = []; },
    of: (action: string) => calls.filter((c) => (action === "poll" ? c.path.endsWith("/poll") : c.path.endsWith(`/${action}`))),
  };
}

async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(0);
}

function makeWorker(server: ReturnType<typeof fakeServer>, overrides: Partial<BrowserWorkerOptions> = {}) {
  const events: BrowserWorkerEvent[] = [];
  const getToken = vi.fn(async () => ({ token: "tok-1", expiresAt: Date.now() + 15 * 60_000, runtimeId: "tab-1" }));
  const worker = new BrowserWorker({
    baseUrl: "https://engine.test/",
    getToken,
    mode: "main",
    fetch: server.fetch,
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  return { worker, events, getToken };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-27T12:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(1);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("BrowserWorker", () => {
  it("polls each handler with browser capabilities bound to the token's runtime", async () => {
    const server = fakeServer();
    const { worker } = makeWorker(server);
    worker.register("confirm", async () => ({})).register("read_page", async () => ({}));
    await worker.start();
    await flush();

    const polls = server.of("poll");
    expect(polls.map((p) => p.body.handler_name).sort()).toEqual(["confirm", "read_page"]);
    const { body, headers } = polls[0];
    expect(headers["x-api-key"]).toBe("tok-1");
    expect(body.worker_id).toBe("tab-1");
    expect(body.limit).toBe(1);
    const caps = body.capabilities as Record<string, unknown>;
    expect(caps).toMatchObject({
      runtime_id: "tab-1",
      kind: "browser",
      trust: "registered",
      handlers: ["confirm", "read_page"],
      offline_capable: false,
    });
    const lifetime = Date.parse(caps.expires_at as string) - Date.parse(caps.observed_at as string);
    expect(lifetime).toBeGreaterThan(0);
    expect(lifetime).toBeLessThanOrEqual(300_000);
    await worker.stop();
  });

  it("caps the capability lifetime at the token expiry", async () => {
    const server = fakeServer();
    const { worker } = makeWorker(server, {
      getToken: async () => ({ token: "t", expiresAt: new Date(Date.now() + 90_000).toISOString(), runtimeId: "tab-1" }),
    });
    worker.register("confirm", async () => ({}));
    await worker.start();
    await flush();
    const caps = server.of("poll")[0].body.capabilities as Record<string, string>;
    expect(Date.parse(caps.expires_at)).toBe(Date.now() + 90_000);
    await worker.stop();
  });

  it("runs the handler with input and ctx, then completes with the claim epoch", async () => {
    const server = fakeServer();
    server.enqueue(task());
    const { worker } = makeWorker(server);
    const seen: unknown[] = [];
    worker.register("confirm", async (input, ctx) => {
      seen.push(input, ctx.effectId, ctx.taskId, ctx.signal.aborted);
      return { confirmed: true, pageTitle: document.title };
    });
    await worker.start();
    await flush();

    expect(seen).toEqual([{ orderId: "o-1", note: "PAGE-SECRET-NOTE" }, "eff-123", "task-1", false]);
    const [complete] = server.of("complete");
    expect(complete.path).toBe("/workers/tasks/task-1/complete");
    expect(complete.body).toEqual({ worker_id: "tab-1", claim_epoch: 7, output: { confirmed: true, pageTitle: "" } });
    await worker.stop();
  });

  it("fails with the handler's error and retryable flag", async () => {
    const server = fakeServer();
    server.enqueue(task());
    const { worker } = makeWorker(server);
    worker.register("confirm", async () => {
      throw Object.assign(new Error("user declined"), { retryable: false });
    });
    await worker.start();
    await flush();
    expect(server.of("fail")[0].body).toEqual({ worker_id: "tab-1", claim_epoch: 7, message: "user declined", retryable: false });
    await worker.stop();
  });

  it("heartbeats at a third of lease_secs, honouring per-task leases", async () => {
    const server = fakeServer();
    server.enqueue(task(), task({ id: "task-2", lease_secs: 9 }));
    const { worker } = makeWorker(server, { maxConcurrent: 2 });
    worker.register("confirm", () => new Promise(() => {}));
    await worker.start();
    await flush();
    const start = Date.now();

    await vi.advanceTimersByTimeAsync(20_500);
    const beats = server.of("heartbeat");
    const offsets = (id: string) => beats.filter((b) => b.path.includes(`/${id}/`)).map((b) => b.at - start);
    expect(offsets("task-1")).toEqual([10_000, 20_000]);
    expect(offsets("task-2")).toEqual([3_000, 6_000, 9_000, 12_000, 15_000, 18_000]);
    expect(beats[0].body).toEqual({ worker_id: "tab-1", claim_epoch: 7 });
    await worker.stop();
  });

  it("aborts the handler signal on a 409 heartbeat and never acknowledges", async () => {
    const server = fakeServer();
    server.enqueue(task());
    server.routes.heartbeat = () => ({ status: 409, body: { error: "stale claim" } });
    const { worker, events } = makeWorker(server);
    let reason: unknown;
    let finish!: () => void;
    worker.register("confirm", (_input, ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener("abort", () => { reason = ctx.signal.reason; });
      finish = () => resolve({ late: true });
    }));
    await worker.start();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();

    expect(reason).toBeInstanceOf(LeaseLostError);
    expect(events).toContainEqual({ type: "task_aborted", taskId: "task-1", reason: "lease_lost" });
    finish();
    await flush();
    expect(server.of("complete")).toHaveLength(0);
    expect(server.of("fail")).toHaveLength(0);
    await worker.stop();
  });

  it("ctx.heartbeat() extends the lease and rejects once the lease is lost", async () => {
    const server = fakeServer();
    server.enqueue(task());
    const { worker } = makeWorker(server);
    const results: unknown[] = [];
    worker.register("confirm", async (_input, ctx) => {
      await ctx.heartbeat();
      results.push("ok");
      server.routes.heartbeat = () => ({ status: 409 });
      await ctx.heartbeat().catch((err) => results.push(err));
      return {};
    });
    await worker.start();
    await flush();
    expect(results[0]).toBe("ok");
    expect(results[1]).toBeInstanceOf(LeaseLostError);
    expect(server.of("complete")).toHaveLength(0);
    await worker.stop();
  });

  it("releases in-flight tasks on pagehide with keepalive and pauses polling", async () => {
    const server = fakeServer();
    server.enqueue(task());
    const { worker, events } = makeWorker(server);
    let abortReason: unknown;
    worker.register("confirm", (_input, ctx) => new Promise(() => {
      ctx.signal.addEventListener("abort", () => { abortReason = ctx.signal.reason; });
    }));
    await worker.start();
    await flush();

    window.dispatchEvent(new Event("pagehide"));
    const [release] = server.of("release");
    // The request is issued synchronously inside the event handler.
    expect(release.path).toBe("/workers/tasks/task-1/release");
    expect(release.keepalive).toBe(true);
    expect(release.headers["x-api-key"]).toBe("tok-1");
    expect(release.body).toEqual({ worker_id: "tab-1", claim_epoch: 7, started: true });
    expect(abortReason).toBeInstanceOf(TaskReleasedError);
    expect(events).toContainEqual({ type: "released", taskIds: ["task-1"], reason: "pagehide" });

    const pollsBefore = server.of("poll").length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.of("poll")).toHaveLength(pollsBefore);
    expect(server.of("heartbeat")).toHaveLength(0);

    // Restored from the back/forward cache: polling resumes.
    const pageshow = new Event("pageshow") as Event & { persisted: boolean };
    Object.defineProperty(pageshow, "persisted", { value: true });
    window.dispatchEvent(pageshow);
    await flush();
    expect(server.of("poll").length).toBeGreaterThan(pollsBefore);
    await worker.stop();
  });

  it("releases on visibilitychange→hidden and resumes when visible", async () => {
    const server = fakeServer();
    server.enqueue(task());
    const { worker } = makeWorker(server);
    worker.register("confirm", () => new Promise(() => {}));
    await worker.start();
    await flush();

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(server.of("release")).toHaveLength(1);
    expect(server.of("release")[0].keepalive).toBe(true);
    const pollsBefore = server.of("poll").length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.of("poll")).toHaveLength(pollsBefore);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(server.of("poll").length).toBeGreaterThan(pollsBefore);
    await worker.stop();
  });

  it("honours releaseOn: ['pagehide'] by ignoring visibility changes", async () => {
    const server = fakeServer();
    server.enqueue(task());
    const { worker } = makeWorker(server, { releaseOn: ["pagehide"] });
    worker.register("confirm", () => new Promise(() => {}));
    await worker.start();
    await flush();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(server.of("release")).toHaveLength(0);
    await worker.stop();
  });

  it("releases claims the page never started with started=false when paused mid-poll", async () => {
    const server = fakeServer();
    let resolvePoll!: (reply: { status: number; body: unknown }) => void;
    server.routes.poll = () => new Promise((resolve) => { resolvePoll = resolve; });
    const handler = vi.fn(async () => ({}));
    const { worker } = makeWorker(server);
    worker.register("confirm", handler);
    await worker.start();
    await flush();

    void worker.release("hidden");
    resolvePoll({ status: 200, body: { tasks: [task()] } });
    await flush();
    expect(handler).not.toHaveBeenCalled();
    expect(server.of("release")[0].body).toEqual({ worker_id: "tab-1", claim_epoch: 7, started: false });
    await worker.stop();
  });

  it("refreshes the token before expiry and uses the new one", async () => {
    const server = fakeServer();
    let n = 0;
    const getToken = vi.fn(async () => {
      n += 1;
      return { token: `tok-${n}`, expires_at: new Date(Date.now() + 120_000).toISOString(), runtime_id: "tab-1" };
    });
    const { worker, events } = makeWorker(server, { getToken, pollIntervalMs: 5_000 });
    worker.register("confirm", async () => ({}));
    await worker.start();
    await flush();
    expect(getToken).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(getToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === "token_refreshed")).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.calls.at(-1)!.headers["x-api-key"]).toBe("tok-2");
    // Still running after the first token's expiry.
    await vi.advanceTimersByTimeAsync(70_000);
    expect(worker.running).toBe(true);
    await worker.stop();
  });

  it("stops when the token expires without a successful refresh", async () => {
    const server = fakeServer();
    server.enqueue(task());
    let calls = 0;
    const getToken = vi.fn(async () => {
      calls += 1;
      if (calls > 1) throw new Error("backend unavailable");
      return { token: "tok-1", expiresAt: Date.now() + 120_000, runtimeId: "tab-1" };
    });
    const { worker, events } = makeWorker(server, { getToken });
    let aborted: unknown;
    worker.register("confirm", (_input, ctx) => new Promise(() => {
      ctx.signal.addEventListener("abort", () => { aborted = ctx.signal.reason; });
    }));
    await worker.start();
    await flush();

    await vi.advanceTimersByTimeAsync(121_000);
    await flush();
    expect(getToken.mock.calls.length).toBeGreaterThan(1);
    expect(worker.running).toBe(false);
    expect(events).toContainEqual({ type: "stopped", reason: "token_expired" });
    expect(aborted).toBeDefined();
    const count = server.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.calls).toHaveLength(count);
  });

  it("asks for a new token when a poll is unauthorized", async () => {
    const server = fakeServer();
    let first = true;
    server.routes.poll = () => {
      if (first) { first = false; return { status: 401, body: { error: "token revoked" } }; }
      return { status: 200, body: { tasks: [] } };
    };
    const { worker, getToken } = makeWorker(server);
    worker.register("confirm", async () => ({}));
    await worker.start();
    await flush();
    expect(getToken).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it("backs off exponentially on poll failures and recovers", async () => {
    const server = fakeServer();
    let failing = true;
    server.routes.poll = () => (failing ? { status: 503 } : { status: 200, body: { tasks: [] } });
    const { worker } = makeWorker(server, { pollIntervalMs: 1_000, maxBackoffMs: 8_000 });
    worker.register("confirm", async () => ({}));
    await worker.start();
    await flush();
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 8_000);
    const times = server.of("poll").map((p) => p.at);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(gaps).toEqual([2_000, 4_000, 8_000, 8_000]);

    failing = false;
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(3_000);
    const after = server.of("poll").map((p) => p.at);
    expect(after.at(-1)! - after.at(-2)!).toBe(1_000);
    await worker.stop();
  });

  it("rejects oversized output with a clear, non-retryable failure", async () => {
    const server = fakeServer();
    server.enqueue(task());
    const { worker, events } = makeWorker(server);
    worker.register("confirm", async () => ({ html: "x".repeat(1024 * 1024) }));
    await worker.start();
    await flush();
    expect(server.of("complete")).toHaveLength(0);
    const [fail] = server.of("fail");
    expect(fail.body.retryable).toBe(false);
    expect(fail.body.message).toMatch(/exceeds the 1048576-byte limit/);
    expect(events).toContainEqual({ type: "task_failed", taskId: "task-1", retryable: false });
    await worker.stop();
  });

  it("honours a custom maxOutputBytes", async () => {
    const server = fakeServer();
    server.enqueue(task());
    const { worker } = makeWorker(server, { maxOutputBytes: 16 });
    worker.register("confirm", async () => ({ text: "more than sixteen bytes" }));
    await worker.start();
    await flush();
    expect(server.of("fail")[0].body.message).toMatch(/exceeds the 16-byte limit/);
    await worker.stop();
  });

  it("fails a timed-out task as retryable and aborts its signal", async () => {
    const server = fakeServer();
    server.enqueue(task({ timeout_ms: 5_000 }));
    const { worker } = makeWorker(server);
    let aborted = false;
    worker.register("confirm", (_i, ctx) => new Promise(() => {
      ctx.signal.addEventListener("abort", () => { aborted = true; });
    }));
    await worker.start();
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(aborted).toBe(true);
    expect(server.of("fail")[0].body).toMatchObject({ message: "task timed out", retryable: true });
    await worker.stop();
  });

  it("stop() releases in-flight work and detaches listeners", async () => {
    const server = fakeServer();
    server.enqueue(task());
    const { worker, events } = makeWorker(server);
    worker.register("confirm", () => new Promise(() => {}));
    await worker.start();
    await flush();
    await worker.stop();
    expect(server.of("release")[0].body).toMatchObject({ started: true });
    expect(events.at(-1)).toEqual({ type: "stopped", reason: "stopped" });
    const count = server.calls.length;
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.calls).toHaveLength(count);
  });

  it("never exposes task input or output in events", async () => {
    const server = fakeServer();
    server.enqueue(task());
    const { worker, events } = makeWorker(server);
    worker.register("confirm", async () => ({ secretish: "OUTPUT-FROM-PAGE" }));
    await worker.start();
    await flush();
    await worker.stop();
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("PAGE-SECRET-NOTE");
    expect(serialized).not.toContain("OUTPUT-FROM-PAGE");
    expect(serialized).not.toContain("tok-1");
  });

  it("validates configuration and token shape", async () => {
    expect(() => new BrowserWorker({ baseUrl: "", getToken: async () => ({ token: "t", expiresAt: 1, runtimeId: "r" }) })).toThrow(/baseUrl/);
    const server = fakeServer();
    const { worker } = makeWorker(server, { getToken: async () => ({ token: "", expiresAt: Date.now() + 1000, runtimeId: "r" }) });
    await expect(worker.start()).rejects.toThrow(/register at least one handler/);
    worker.register("confirm", async () => ({}));
    await expect(worker.start()).rejects.toThrow(/no token/);
    expect(worker.running).toBe(false);
  });
});
