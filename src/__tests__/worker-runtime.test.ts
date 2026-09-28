import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Orch8Worker, workerTaskContext, type WorkerTaskContext } from "../worker.js";
import type { WorkerTask } from "../types.js";

// Capability advertisement, lease context and release-on-shutdown for the
// Node worker (distributed-execution contract v1).

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

function task(id: string, extra: Partial<WorkerTask> = {}): WorkerTask {
  return {
    id,
    instance_id: "i-1",
    block_id: "b-1",
    handler_name: "scan",
    queue_name: null,
    params: {},
    context: {},
    attempt: 1,
    timeout_ms: null,
    state: "claimed",
    worker_id: "w-1",
    claimed_at: null,
    heartbeat_at: null,
    completed_at: null,
    output: null,
    error_message: null,
    error_retryable: null,
    created_at: "2026-01-01T00:00:00Z",
    claim_epoch: 4,
    checkpoint_seq: 0,
    ...extra,
  };
}

interface Call {
  url: string;
  body: Record<string, any>;
}

/** Route requests by path; `polls` are served in order, then empty batches. */
function route(polls: unknown[]): Call[] {
  const calls: Call[] = [];
  mockFetch.mockImplementation(async (url: string, init: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    if (url.endsWith("/workers/tasks/poll")) return json(polls.shift() ?? { tasks: [] });
    return json({});
  });
  return calls;
}

describe("Orch8Worker runtime node support", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function stop(worker: Orch8Worker): Promise<void> {
    const stopping = worker.stop();
    await vi.advanceTimersByTimeAsync(35_000);
    await stopping;
  }

  it("sends a fresh capability advertisement bound to the worker id", async () => {
    const calls = route([{ tasks: [] }]);
    const worker = new Orch8Worker({
      engineUrl: "http://engine",
      workerId: "w-1",
      handlers: { scan: vi.fn(), ocr: vi.fn() },
      capabilities: { kind: "desktop", hardware: ["gpu"], regions: ["norway"], ttlSecs: 900 },
    });
    await worker.start();
    await vi.advanceTimersByTimeAsync(0);

    const poll = calls.find((c) => c.url.endsWith("/workers/tasks/poll"))!;
    expect(poll.body.worker_id).toBe("w-1");
    expect(poll.body.capabilities).toEqual({
      runtime_id: "w-1",
      kind: "desktop",
      trust: "registered",
      handlers: ["scan", "ocr"],
      hardware: ["gpu"],
      regions: ["norway"],
      observed_at: "2026-09-28T12:00:00.000Z",
      // ttlSecs is capped at the server's five-minute maximum.
      expires_at: "2026-09-28T12:05:00.000Z",
    });
    await stop(worker);
  });

  it("omits capabilities when none are configured", async () => {
    const calls = route([]);
    const worker = new Orch8Worker({ engineUrl: "http://engine", workerId: "w-1", handlers: { scan: vi.fn() } });
    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]!.body).not.toHaveProperty("capabilities");
    await stop(worker);
  });

  it("passes effect_id, lease_secs and continuity_epoch to the handler", async () => {
    const seen: WorkerTaskContext[] = [];
    const calls = route([
      { tasks: [task("t-1", { effect_id: "eff-1", lease_secs: 120, continuity_epoch: 3 }), task("t-2")] },
    ]);
    const worker = new Orch8Worker({
      engineUrl: "http://engine",
      workerId: "w-1",
      handlers: {
        scan: async (_task, ctx) => {
          seen.push(ctx);
          return { ok: true };
        },
      },
    });
    await worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([
      { effectId: "eff-1", leaseSecs: 120, continuityEpoch: 3, workerId: "w-1" },
      { effectId: null, leaseSecs: null, continuityEpoch: null, workerId: "w-1" },
    ]);
    expect(calls.filter((c) => c.url.endsWith("/complete")).map((c) => c.url)).toEqual([
      "http://engine/workers/tasks/t-1/complete",
      "http://engine/workers/tasks/t-2/complete",
    ]);
    await stop(worker);
  });

  it("heartbeats within half of a task's lease", async () => {
    let finish!: () => void;
    const calls = route([{ tasks: [task("t-1", { lease_secs: 4 })] }]);
    const worker = new Orch8Worker({
      engineUrl: "http://engine",
      workerId: "w-1",
      heartbeatIntervalMs: 15_000,
      handlers: { scan: () => new Promise<void>((resolve) => (finish = resolve)) },
    });
    await worker.start();
    await vi.advanceTimersByTimeAsync(2_100);
    const beats = calls.filter((c) => c.url.endsWith("/t-1/heartbeat"));
    expect(beats.length).toBeGreaterThanOrEqual(1);
    expect(beats[0]!.body).toEqual({ worker_id: "w-1", claim_epoch: 4 });
    finish();
    await stop(worker);
  });

  it("releases tasks claimed beyond free capacity instead of orphaning them", async () => {
    const calls = route([{ tasks: [task("t-1"), task("t-2"), task("t-3")] }]);
    const handler = vi.fn(() => new Promise(() => {}));
    const worker = new Orch8Worker({
      engineUrl: "http://engine",
      workerId: "w-1",
      maxConcurrent: 1,
      handlers: { scan: handler },
    });
    await worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledTimes(1);
    const releases = calls.filter((c) => c.url.endsWith("/release"));
    expect(releases.map((c) => c.url)).toEqual([
      "http://engine/workers/tasks/t-2/release",
      "http://engine/workers/tasks/t-3/release",
    ]);
    expect(releases[0]!.body).toEqual({ worker_id: "w-1", claim_epoch: 4, started: false });
    // Do not wait for the never-settling handler; drop timers instead.
    vi.clearAllTimers();
  });

  it("releases a batch that arrives after stop() without running it", async () => {
    let answerPoll!: (r: Response) => void;
    const calls: Call[] = [];
    mockFetch.mockImplementation((url: string, init: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.endsWith("/workers/tasks/poll") && calls.length === 1) {
        return new Promise<Response>((resolve) => (answerPoll = resolve));
      }
      return Promise.resolve(json({}));
    });
    const handler = vi.fn(async () => ({}));
    const worker = new Orch8Worker({ engineUrl: "http://engine", workerId: "w-1", handlers: { scan: handler } });
    await worker.start();
    await vi.advanceTimersByTimeAsync(0);

    const stopping = worker.stop();
    answerPoll(json({ tasks: [task("t-9", { claim_epoch: 7 })] }));
    await vi.advanceTimersByTimeAsync(35_000);
    await stopping;

    expect(handler).not.toHaveBeenCalled();
    const release = calls.find((c) => c.url.endsWith("/t-9/release"));
    expect(release?.body).toEqual({ worker_id: "w-1", claim_epoch: 7, started: false });
  });

  it("tolerates servers without /release", async () => {
    const calls: Call[] = [];
    let polled = false;
    mockFetch.mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.endsWith("/workers/tasks/poll")) {
        if (polled) return json({ tasks: [] });
        polled = true;
        return json({ tasks: [task("t-1"), task("t-2")] });
      }
      if (url.endsWith("/release")) return json({ error: "not found" }, 404);
      return json({});
    });
    const worker = new Orch8Worker({
      engineUrl: "http://engine",
      workerId: "w-1",
      maxConcurrent: 1,
      handlers: { scan: async () => ({}) },
    });
    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.some((c) => c.url.endsWith("/t-2/release"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/t-1/complete"))).toBe(true);
    await stop(worker);
  });

  it("workerTaskContext ignores malformed fields", () => {
    expect(
      workerTaskContext(task("t", { effect_id: 5 as unknown as string, lease_secs: "x" as unknown as number }), "w"),
    ).toEqual({ effectId: null, leaseSecs: null, continuityEpoch: null, workerId: "w" });
  });
});
