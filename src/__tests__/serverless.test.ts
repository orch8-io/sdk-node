import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { Orch8Client } from "../client.js";
import {
  createCloudflareExecutor,
  createLambdaExecutor,
  drainOnce,
  type ServerlessTaskContext,
} from "../serverless/index.js";
import type { WorkerTask } from "../types.js";

// Mock engine for the worker lease API: pending tasks per handler, claimed on
// poll, and a log of every lease call the executor makes.

const T0 = new Date("2026-09-28T12:00:00Z").getTime();

function task(id: string, extra: Partial<WorkerTask> = {}): WorkerTask {
  return {
    id,
    instance_id: `i-${id}`,
    block_id: "b-1",
    handler_name: "scan",
    queue_name: null,
    params: { id },
    context: {},
    attempt: 1,
    timeout_ms: null,
    state: "pending",
    worker_id: null,
    claimed_at: null,
    heartbeat_at: null,
    completed_at: null,
    output: null,
    error_message: null,
    error_retryable: null,
    created_at: "2026-01-01T00:00:00Z",
    checkpoint_seq: 0,
    ...extra,
  };
}

interface Call {
  path: string;
  body: Record<string, any>;
  at: number;
}

class MockEngine {
  pending: WorkerTask[] = [];
  calls: Call[] = [];
  leaseSecs = 30;
  pollFails = false;
  /** Task ids whose heartbeat answers 409. */
  lostLeases = new Set<string>();
  private epoch = 0;

  readonly fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname.replace(/^\/api\/v1/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    this.calls.push({ path, body, at: Date.now() });
    if (path === "/workers/tasks/poll" || path === "/workers/tasks/poll/queue") {
      if (this.pollFails) return this.json(503, { error: "unavailable" });
      const matching = this.pending.filter((t) => t.handler_name === body.handler_name);
      const claimed = matching.slice(0, body.limit ?? 1);
      this.pending = this.pending.filter((t) => !claimed.includes(t));
      return this.json(200, {
        tasks: claimed.map((t) => ({ ...t, state: "claimed", worker_id: body.worker_id, claim_epoch: ++this.epoch })),
        lease_secs: this.leaseSecs,
      });
    }
    const m = path.match(/^\/workers\/tasks\/([^/]+)\/(heartbeat|complete|fail|release)$/);
    if (m) {
      if (m[2] === "heartbeat" && this.lostLeases.has(decodeURIComponent(m[1]))) {
        return this.json(409, { error: "claim_epoch_mismatch" });
      }
      return m[2] === "heartbeat" ? this.json(200, { checkpoint_seq: 0 }) : this.json(204);
    }
    return this.json(404, { error: "not_found" });
  });

  json(status: number, body?: unknown): Response {
    return new Response(status === 204 || body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  client(): Orch8Client {
    return new Orch8Client({ baseUrl: "https://engine.test", fetch: this.fetch as unknown as typeof fetch, retry: false });
  }

  of(action: string): Call[] {
    return this.calls.filter((c) => c.path.endsWith(`/${action}`));
  }
}

let engine: MockEngine;

beforeEach(() => {
  engine = new MockEngine();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("drainOnce", () => {
  it("claims up to maxTasks, runs them and completes with the claim epoch", async () => {
    engine.pending = [task("a"), task("b"), task("c")];
    const seen: string[] = [];
    const result = await drainOnce({
      client: engine.client(),
      workerId: "w-1",
      handlers: { scan: async (t) => { seen.push(t.id); return { ok: t.id }; } },
      maxTasks: 2,
      deadlineMs: T0 + 30_000,
    });

    expect(seen).toEqual(["a", "b"]);
    expect(result).toMatchObject({ claimed: 2, completed: 2, stoppedBy: "max_tasks", workerId: "w-1" });
    const poll = engine.of("poll")[0];
    expect(poll.body).toMatchObject({ handler_name: "scan", worker_id: "w-1", limit: 2 });
    expect(poll.body.capabilities).toBeUndefined();
    const completes = engine.of("complete");
    expect(completes.map((c) => c.body)).toEqual([
      { worker_id: "w-1", claim_epoch: 1, output: { ok: "a" } },
      { worker_id: "w-1", claim_epoch: 2, output: { ok: "b" } },
    ]);
    expect(engine.pending.map((t) => t.id)).toEqual(["c"]);
  });

  it("keeps polling in rounds until the queue is empty", async () => {
    engine.pending = [task("a")];
    let calls = 0;
    const result = await drainOnce({
      client: engine.client(),
      handlers: {
        scan: async () => {
          calls += 1;
          if (calls === 1) engine.pending.push(task("b"));
          return {};
        },
      },
      deadlineMs: T0 + 30_000,
    });
    expect(result).toMatchObject({ claimed: 2, completed: 2, stoppedBy: "empty" });
    expect(engine.of("poll")).toHaveLength(3);
  });

  it("polls every handler and advertises capabilities with the default kind", async () => {
    engine.pending = [task("a", { handler_name: "resize" })];
    const result = await drainOnce({
      client: engine.client(),
      workerId: "w-2",
      handlers: { scan: async () => ({}), resize: async () => ({ resized: true }) },
      capabilities: { regions: ["eu-west-1"] },
      defaultKind: "edge",
      deadlineMs: T0 + 30_000,
    });
    expect(result.completed).toBe(1);
    const [first] = engine.of("poll");
    expect(first.body.capabilities).toMatchObject({
      runtime_id: "w-2",
      kind: "edge",
      trust: "registered",
      regions: ["eu-west-1"],
      handlers: ["scan", "resize"],
    });
    expect(new Set(engine.of("poll").map((c) => c.body.handler_name))).toEqual(new Set(["scan", "resize"]));
  });

  it("releases a still-running task with started: true before the deadline and never acknowledges it", async () => {
    engine.pending = [task("slow")];
    let signal: AbortSignal | undefined;
    let finish: (() => void) | undefined;
    const running = drainOnce({
      client: engine.client(),
      workerId: "w-3",
      handlers: {
        scan: (_t, ctx: ServerlessTaskContext) => {
          signal = ctx.signal;
          return new Promise((resolve) => { finish = () => resolve({ late: true }); });
        },
      },
      deadlineMs: T0 + 10_000,
      releaseMarginMs: 1_500,
    });

    await vi.advanceTimersByTimeAsync(8_400);
    expect(engine.of("release")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    const result = await running;

    const [release] = engine.of("release");
    expect(release.body).toEqual({ worker_id: "w-3", claim_epoch: 1, started: true });
    expect(release.at).toBeLessThanOrEqual(T0 + 10_000 - 1_500);
    expect(signal?.aborted).toBe(true);
    expect(result).toMatchObject({ claimed: 1, released: 1, completed: 0, stoppedBy: "deadline" });
    expect(result.tasks[0]).toMatchObject({ task_id: "slow", outcome: "released" });

    finish?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.of("complete")).toHaveLength(0);
    expect(engine.of("fail")).toHaveLength(0);
  });

  it("releases unstarted a claim whose timeout cannot fit the remaining budget", async () => {
    engine.pending = [task("long", { timeout_ms: 60_000 })];
    const handler = vi.fn(async () => ({}));
    const result = await drainOnce({
      client: engine.client(),
      workerId: "w-4",
      handlers: { scan: handler },
      deadlineMs: T0 + 20_000,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(engine.of("release")[0].body).toEqual({ worker_id: "w-4", claim_epoch: 1, started: false });
    expect(result).toMatchObject({ released: 1, stoppedBy: "deadline" });
    expect(engine.of("poll")).toHaveLength(1);
  });

  it("does not claim when the budget is already below minTaskBudgetMs", async () => {
    engine.pending = [task("a")];
    const result = await drainOnce({
      client: engine.client(),
      handlers: { scan: async () => ({}) },
      deadlineMs: T0 + 1_500,
      releaseMarginMs: 1_000,
      minTaskBudgetMs: 1_000,
    });
    expect(result).toMatchObject({ claimed: 0, stoppedBy: "deadline" });
    expect(engine.calls).toHaveLength(0);
  });

  it("heartbeats at half the lease while a task runs", async () => {
    engine.pending = [task("hb")];
    engine.leaseSecs = 4;
    let finish: (() => void) | undefined;
    const running = drainOnce({
      client: engine.client(),
      workerId: "w-5",
      handlers: { scan: () => new Promise((resolve) => { finish = () => resolve({}); }) },
      deadlineMs: T0 + 60_000,
    });
    await vi.advanceTimersByTimeAsync(6_100);
    const beats = engine.of("heartbeat");
    expect(beats).toHaveLength(3);
    expect(beats[0].body).toEqual({ worker_id: "w-5", claim_epoch: 1 });
    finish?.();
    const result = await running;
    expect(result.completed).toBe(1);
  });

  it("stops and never acknowledges a task whose lease was lost", async () => {
    engine.pending = [task("gone")];
    engine.leaseSecs = 2;
    engine.lostLeases.add("gone");
    let signal: AbortSignal | undefined;
    const running = drainOnce({
      client: engine.client(),
      handlers: {
        scan: (_t, ctx) => {
          signal = ctx.signal;
          return new Promise(() => undefined);
        },
      },
      deadlineMs: T0 + 60_000,
    });
    await vi.advanceTimersByTimeAsync(1_100);
    const result = await running;
    expect(signal?.aborted).toBe(true);
    expect(result).toMatchObject({ leaseLost: 1, completed: 0, failed: 0, released: 0 });
    expect(engine.of("complete")).toHaveLength(0);
    expect(engine.of("release")).toHaveLength(0);
  });

  it("reports handler errors with the retryable flag", async () => {
    engine.pending = [task("x"), task("y")];
    const result = await drainOnce({
      client: engine.client(),
      handlers: {
        scan: async (t) => {
          if (t.id === "x") throw new Error("boom");
          throw Object.assign(new Error("bad input"), { retryable: false });
        },
      },
      deadlineMs: T0 + 30_000,
    });
    expect(result.failed).toBe(2);
    expect(engine.of("fail").map((c) => [c.body.message, c.body.retryable])).toEqual([
      ["boom", true],
      ["bad input", false],
    ]);
  });

  it("fails a task that exceeds its own timeout_ms", async () => {
    engine.pending = [task("t", { timeout_ms: 2_000 })];
    const running = drainOnce({
      client: engine.client(),
      handlers: { scan: () => new Promise(() => undefined) },
      deadlineMs: T0 + 30_000,
    });
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await running;
    expect(result.failed).toBe(1);
    expect(engine.of("fail")[0].body).toMatchObject({ message: "task timed out", retryable: true });
  });

  it("claims through the queue endpoint when queueName is set", async () => {
    engine.pending = [task("q")];
    await drainOnce({
      client: engine.client(),
      handlers: { scan: async () => ({}) },
      queueName: "edge",
      deadlineMs: T0 + 30_000,
    });
    expect(engine.of("queue")[0].body).toMatchObject({ queue_name: "edge", handler_name: "scan" });
  });

  it("returns poll_error instead of throwing when every poll fails", async () => {
    engine.pollFails = true;
    const result = await drainOnce({
      client: engine.client(),
      handlers: { scan: async () => ({}) },
      deadlineMs: T0 + 30_000,
    });
    expect(result.stoppedBy).toBe("poll_error");
    expect(result.pollErrors[0]).toMatch(/^scan: Orch8 API error 503/);
  });
});

describe("createLambdaExecutor", () => {
  it("derives the budget from the remaining invocation time minus the safety margin", async () => {
    engine.pending = [task("l")];
    const handler = createLambdaExecutor({
      client: engine.client(),
      handlers: { scan: () => new Promise(() => undefined) },
      safetyMarginMs: 3_000,
      releaseMarginMs: 1_000,
    });
    const running = handler({ source: "aws.events" }, { getRemainingTimeInMillis: () => 10_000 });
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await running;
    expect(result.workerId).toMatch(/^lambda-/);
    const [release] = engine.of("release");
    expect(release.body).toMatchObject({ started: true });
    expect(release.at - T0).toBe(6_000);
    expect(release.at - T0).toBeLessThan(10_000);
  });

  it("keeps one worker id per container and builds options lazily once", async () => {
    const factory = vi.fn(() => ({ client: engine.client(), handlers: { scan: async () => ({}) } }));
    const handler = createLambdaExecutor(factory);
    const ctx = { getRemainingTimeInMillis: () => 30_000 };
    const a = await handler({}, ctx);
    const b = await handler({}, ctx);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(a.workerId).toBe(b.workerId);
  });
});

describe("createCloudflareExecutor", () => {
  interface Env { SECRET?: string }
  const make = (secret?: string) =>
    createCloudflareExecutor((env: Env) => ({
      client: engine.client(),
      handlers: { scan: async () => ({ done: true }) },
      capabilities: {},
      triggerSecret: env.SECRET ?? secret,
      budgetMs: 20_000,
    }));

  it("disables the fetch trigger without a secret", async () => {
    const res = await make().fetch(new Request("https://w.test/", { method: "POST" }), {});
    expect(res.status).toBe(404);
    expect(engine.calls).toHaveLength(0);
  });

  it("rejects wrong methods and credentials", async () => {
    const exec = make("s3cret");
    expect((await exec.fetch(new Request("https://w.test/"), {})).status).toBe(405);
    const bad = await exec.fetch(
      new Request("https://w.test/", { method: "POST", headers: { authorization: "Bearer nope" } }),
      {},
    );
    expect(bad.status).toBe(401);
    expect(engine.calls).toHaveLength(0);
  });

  it("drains on an authorised fetch and advertises kind edge", async () => {
    engine.pending = [task("cf")];
    const res = await make("s3cret").fetch(
      new Request("https://w.test/", { method: "POST", headers: { authorization: "Bearer s3cret" } }),
      {},
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ claimed: 1, completed: 1, stoppedBy: "empty" });
    expect(engine.of("poll")[0].body.capabilities).toMatchObject({ kind: "edge" });
    expect(body.workerId).toMatch(/^cf-/);
  });

  it("runs the scheduled trigger under waitUntil", async () => {
    engine.pending = [task("cron")];
    const waitUntil = vi.fn();
    await make().scheduled({ cron: "*/1 * * * *" }, {}, { waitUntil });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(engine.of("complete")).toHaveLength(1);
  });

  it("releases before the configured budget ends", async () => {
    engine.pending = [task("slow")];
    const exec = createCloudflareExecutor({
      client: engine.client(),
      handlers: { scan: () => new Promise(() => undefined) },
      budgetMs: 5_000,
      releaseMarginMs: 500,
    });
    const run = exec.drain({});
    await vi.advanceTimersByTimeAsync(4_500);
    const result = await run;
    expect(result.released).toBe(1);
    expect(engine.of("release")[0].at - T0).toBe(4_500);
  });
});

describe("serverless entry", () => {
  it("bundles for an edge runtime without Node built-ins", async () => {
    vi.useRealTimers();
    const out = await build({
      entryPoints: [resolve(process.cwd(), "src/serverless/index.ts")],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      logLevel: "silent",
    });
    const code = out.outputFiles[0].text;
    expect(code).not.toMatch(/from\s*["']node:/);
    expect(code).not.toMatch(/import\(["']node:/);
  });
});
