import { Orch8Client } from "../client.js";
import type { Orch8ClientConfig, WorkerTask } from "../types.js";
import type { HandlerFn } from "../worker.js";
import type { Job, JobDetail, JobRetryPolicy, JobStatus } from "../jobs.js";
import { runClaimedTask, type PushTaskResult } from "../push/core.js";

type TaskState = WorkerTask["state"];

/** Internal record for a fake worker task. */
export interface FakeTask extends WorkerTask {
  /** Virtual time (ms) at which the task becomes pollable. */
  available_at: number;
  /** Maximum attempts before the task is terminally failed. Default: 1. */
  max_attempts: number;
  retry?: JobRetryPolicy;
  job_id?: string;
}

export interface EnqueueTaskInput {
  handler_name: string;
  params?: unknown;
  context?: unknown;
  queue_name?: string | null;
  instance_id?: string;
  block_id?: string;
  timeout_ms?: number | null;
  /** Delay (virtual ms) before the task can be claimed. */
  delayMs?: number;
  /** Attempts allowed for retryable failures. Default: 1. */
  maxAttempts?: number;
  retry?: JobRetryPolicy;
}

export interface FakeInstance {
  id: string;
  tenant_id: string;
  namespace: string;
  sequence_id?: string;
  state: string;
  context: Record<string, unknown>;
  signals: Array<{ id: string; signal_type?: unknown; payload?: unknown }>;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface FakeServerOptions {
  /** Initial virtual time (ms since epoch). Default: 2026-01-01T00:00:00Z. */
  startTime?: number;
  /** Lease advertised to workers, in seconds. Default: 60. */
  leaseSecs?: number;
  /** Heartbeat interval advertised to workers, in seconds. Default: 15. */
  heartbeatIntervalSecs?: number;
}

export interface RunUntilIdleOptions {
  workerId?: string;
  /**
   * Skip virtual time forward to the next delayed task whenever nothing is
   * runnable, until no work remains. Default: true.
   */
  skipTime?: boolean;
  /** Safety bound on poll rounds. Default: 1000. */
  maxRounds?: number;
}

const TERMINAL: TaskState[] = ["completed", "failed"];

interface Route {
  method: string;
  pattern: RegExp;
  handle: (match: RegExpMatchArray, body: any, url: URL) => Response | Promise<Response>;
}

function json(body: unknown, status = 200): Response {
  if (body === undefined || status === 204) return new Response(null, { status: status === 200 ? 204 : status });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function error(status: number, message: string): Response {
  return json({ error: message }, status);
}

/**
 * In-memory Orch8 engine double for unit tests. It implements the worker
 * protocol (poll, queue poll, complete, fail, heartbeat/checkpoint with claim
 * epochs and leases), instance CRUD, signals and outputs, and the jobs API,
 * on a virtual clock you advance explicitly — no server, no sleeps.
 *
 * ```ts
 * const engine = new FakeOrch8Server();
 * const client = engine.client();
 * const job = await client.jobs.enqueue("send-email", { to: "a@b.c" }, { delayMs: 60_000 });
 * await engine.runUntilIdle({ "send-email": async (t) => ({ sent: true }) }); // skips 60 s
 * expect((await client.jobs.get(job.id)).status).toBe("completed");
 * ```
 */
export class FakeOrch8Server {
  private nowMs: number;
  private seq = 0;
  private readonly leaseSecs: number;
  private readonly heartbeatIntervalSecs: number;
  readonly tasks = new Map<string, FakeTask>();
  readonly instances = new Map<string, FakeInstance>();
  readonly jobs = new Map<string, { job: Job; task_id: string; metadata?: unknown; payload: unknown }>();
  private readonly jobKeys = new Map<string, string>();
  /** Every request received, for assertions. */
  readonly requests: Array<{ method: string; path: string; body: unknown }> = [];
  private readonly routes: Route[];

  constructor(options: FakeServerOptions = {}) {
    this.nowMs = options.startTime ?? Date.UTC(2026, 0, 1);
    this.leaseSecs = options.leaseSecs ?? 60;
    this.heartbeatIntervalSecs = options.heartbeatIntervalSecs ?? 15;
    this.routes = this.buildRoutes();
  }

  // ---------------------------------------------------------------------------
  // Clock
  // ---------------------------------------------------------------------------

  /** Current virtual time (ms since epoch). */
  now(): number {
    return this.nowMs;
  }

  /** Move virtual time forward, expiring leases whose heartbeat lapsed. */
  advanceTime(ms: number): void {
    if (ms < 0) throw new RangeError("cannot move time backwards");
    this.nowMs += ms;
    this.expireLeases();
  }

  private iso(ms = this.nowMs): string {
    return new Date(ms).toISOString();
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(6, "0")}`;
  }

  // ---------------------------------------------------------------------------
  // Direct (test-side) API
  // ---------------------------------------------------------------------------

  /** An `Orch8Client` wired to this fake (no network). */
  client(config: Partial<Orch8ClientConfig> = {}): Orch8Client {
    return new Orch8Client({
      baseUrl: "http://orch8.test/api/v1",
      tenantId: "test",
      retry: false,
      ...config,
      fetch: this.fetch,
    });
  }

  /** Put a task on the fake queue, as the engine does when a step dispatches. */
  enqueueTask(input: EnqueueTaskInput): FakeTask {
    const id = this.id("task");
    const task: FakeTask = {
      id,
      instance_id: input.instance_id ?? this.id("inst"),
      block_id: input.block_id ?? input.handler_name,
      handler_name: input.handler_name,
      queue_name: input.queue_name ?? null,
      params: input.params ?? {},
      context: input.context ?? {},
      attempt: 0,
      timeout_ms: input.timeout_ms ?? null,
      state: "pending",
      worker_id: null,
      claimed_at: null,
      heartbeat_at: null,
      completed_at: null,
      output: null,
      error_message: null,
      error_retryable: null,
      created_at: this.iso(),
      claim_epoch: 0,
      checkpoint_seq: 0,
      available_at: this.nowMs + Math.max(0, input.delayMs ?? 0),
      max_attempts: Math.max(1, input.retry?.max_attempts ?? input.maxAttempts ?? 1),
      retry: input.retry,
    };
    this.tasks.set(id, task);
    return task;
  }

  task(id: string): FakeTask | undefined {
    return this.tasks.get(id);
  }

  /** Tasks for a handler, optionally filtered by state. */
  tasksFor(handlerName: string, state?: TaskState): FakeTask[] {
    return [...this.tasks.values()].filter(
      (t) => t.handler_name === handlerName && (state === undefined || t.state === state),
    );
  }

  /**
   * Run every runnable task through `handlers` using the real worker protocol
   * (poll → handler → complete/fail with claim epoch), skipping virtual time
   * to delayed tasks and retry backoffs. Returns the per-task results.
   */
  async runUntilIdle(
    handlers: Record<string, HandlerFn>,
    options: RunUntilIdleOptions = {},
  ): Promise<PushTaskResult[]> {
    const client = this.client();
    const workerId = options.workerId ?? "fake-worker";
    const skipTime = options.skipTime ?? true;
    const maxRounds = options.maxRounds ?? 1000;
    const results: PushTaskResult[] = [];
    for (let round = 0; round < maxRounds; round += 1) {
      let ran = 0;
      for (const handlerName of Object.keys(handlers)) {
        const batch = await client.pollTaskBatch({ handler_name: handlerName, worker_id: workerId, limit: 100 });
        for (const task of batch.tasks) {
          results.push(await runClaimedTask(client, workerId, handlers, task));
          ran += 1;
        }
      }
      if (ran > 0) continue;
      if (!skipTime) return results;
      const next = this.nextAvailableAt(Object.keys(handlers));
      if (next === undefined) return results;
      this.advanceTime(next - this.nowMs);
    }
    throw new Error(`runUntilIdle did not settle within ${maxRounds} rounds`);
  }

  /**
   * Resolve once a task reaches `completed` or `failed` (for tests that drive a
   * real `Orch8Worker` with its own timers).
   */
  async waitForTask(id: string, options: { timeoutMs?: number } = {}): Promise<FakeTask> {
    const deadline = Date.now() + (options.timeoutMs ?? 5_000);
    for (;;) {
      const task = this.tasks.get(id);
      if (!task) throw new Error(`unknown task ${id}`);
      if (TERMINAL.includes(task.state)) return task;
      if (Date.now() > deadline) throw new Error(`task ${id} still ${task.state}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private nextAvailableAt(handlerNames: string[]): number | undefined {
    let next: number | undefined;
    for (const t of this.tasks.values()) {
      if (t.state !== "pending" || !handlerNames.includes(t.handler_name)) continue;
      if (t.available_at > this.nowMs && (next === undefined || t.available_at < next)) next = t.available_at;
    }
    return next;
  }

  private expireLeases(): void {
    for (const t of this.tasks.values()) {
      if (t.state !== "claimed" || !t.heartbeat_at) continue;
      if (Date.parse(t.heartbeat_at) + this.leaseSecs * 1000 <= this.nowMs) {
        t.state = "pending";
        t.worker_id = null;
        t.claimed_at = null;
        t.heartbeat_at = null;
        this.syncJob(t);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP surface
  // ---------------------------------------------------------------------------

  /** A `fetch`-compatible function that serves the fake API. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v1(?=\/)/, "");
    const text = await request.text();
    let body: unknown;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return error(400, "invalid JSON");
      }
    }
    this.requests.push({ method: request.method, path: path + url.search, body });
    for (const route of this.routes) {
      if (route.method !== request.method) continue;
      const match = path.match(route.pattern);
      if (match) return route.handle(match, body, url);
    }
    return error(404, `no fake route for ${request.method} ${path}`);
  };

  /**
   * Serve the fake over real HTTP on 127.0.0.1 (Node only), for code that
   * cannot take an injected client.
   */
  async listen(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
    const http = await import("node:http");
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const response = await this.fetch(`http://127.0.0.1${req.url ?? "/"}`, {
        method: req.method,
        body: body.length > 0 ? body : undefined,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const address = server.address();
    const actual = typeof address === "object" && address ? address.port : port;
    return {
      url: `http://127.0.0.1:${actual}`,
      close: () => new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        // Node 18 keeps idle keep-alive sockets open, so close() would wait
        // for their timeout; Node 19+ drops them on its own.
        server.closeAllConnections?.();
      }),
    };
  }

  private buildRoutes(): Route[] {
    const r = (method: string, pattern: string, handle: Route["handle"]): Route => ({
      method,
      pattern: new RegExp(`^${pattern.replace(/\{[a-z_]+\}/g, "([^/]+)")}$`),
      handle,
    });
    return [
      r("POST", "/workers/tasks/poll", (_m, b) => this.poll(b, false)),
      r("POST", "/workers/tasks/poll/queue", (_m, b) => this.poll(b, true)),
      r("POST", "/workers/tasks/{id}/complete", (m, b) => this.complete(decodeURIComponent(m[1]), b)),
      r("POST", "/workers/tasks/{id}/fail", (m, b) => this.fail(decodeURIComponent(m[1]), b)),
      r("POST", "/workers/tasks/{id}/heartbeat", (m, b) => this.heartbeat(decodeURIComponent(m[1]), b)),
      r("GET", "/workers/tasks", () => json([...this.tasks.values()].map(publicTask))),
      r("POST", "/instances", (_m, b) => this.createInstance(b)),
      r("GET", "/instances", () => json([...this.instances.values()])),
      r("GET", "/instances/{id}", (m) => this.withInstance(m[1], (i) => json(i))),
      r("PATCH", "/instances/{id}/state", (m, b) =>
        this.withInstance(m[1], (i) => {
          i.state = String(b?.state ?? i.state);
          i.updated_at = this.iso();
          return json(undefined);
        })),
      r("PATCH", "/instances/{id}/context", (m, b) =>
        this.withInstance(m[1], (i) => {
          i.context = { ...i.context, ...(b?.context ?? b ?? {}) };
          i.updated_at = this.iso();
          return json(undefined);
        })),
      r("POST", "/instances/{id}/signals", (m, b) =>
        this.withInstance(m[1], (i) => {
          const signal_id = this.id("sig");
          i.signals.push({ id: signal_id, signal_type: b?.signal_type, payload: b?.payload });
          return json({ signal_id }, 201);
        })),
      r("GET", "/instances/{id}/outputs", (m) => this.outputs(decodeURIComponent(m[1]))),
      r("POST", "/jobs", (_m, b) => this.enqueueJob(b)),
      r("GET", "/jobs", (_m, _b, url) => this.listJobs(url)),
      r("GET", "/jobs/{id}", (m) => this.getJob(decodeURIComponent(m[1]))),
      r("DELETE", "/jobs/{id}", (m) => this.cancelJob(decodeURIComponent(m[1]))),
    ];
  }

  private poll(body: any, byQueue: boolean): Response {
    if (!body?.handler_name || !body?.worker_id) return error(400, "handler_name and worker_id are required");
    if (byQueue && !body.queue_name) return error(400, "queue_name is required");
    this.expireLeases();
    const limit = Math.max(1, Number(body.limit ?? 1));
    const claimed: WorkerTask[] = [];
    for (const t of this.tasks.values()) {
      if (claimed.length >= limit) break;
      if (t.state !== "pending" || t.handler_name !== body.handler_name || t.available_at > this.nowMs) continue;
      if (byQueue && t.queue_name !== body.queue_name) continue;
      t.state = "claimed";
      t.worker_id = body.worker_id;
      t.claim_epoch = (t.claim_epoch ?? 0) + 1;
      t.claimed_at = this.iso();
      t.heartbeat_at = this.iso();
      this.syncJob(t);
      claimed.push(publicTask(t));
    }
    return json({
      tasks: claimed,
      lease_secs: this.leaseSecs,
      heartbeat_interval_secs: this.heartbeatIntervalSecs,
      poll_after_ms: 0,
    });
  }

  private owned(id: string, body: any): FakeTask | Response {
    const t = this.tasks.get(id);
    if (!t) return error(404, `worker_task ${id} not found`);
    if (typeof body?.worker_id !== "string" || typeof body?.claim_epoch !== "number") {
      return error(400, "worker_id and claim_epoch are required");
    }
    if (t.state !== "claimed" || t.worker_id !== body.worker_id || t.claim_epoch !== body.claim_epoch) {
      return error(409, "worker task lease changed");
    }
    return t;
  }

  private complete(id: string, body: any): Response {
    const t = this.owned(id, body);
    if (t instanceof Response) return t;
    if (!("output" in (body ?? {}))) return error(400, "output is required");
    t.state = "completed";
    t.output = body.output;
    t.completed_at = this.iso();
    this.syncJob(t);
    return json({ ok: true });
  }

  private fail(id: string, body: any): Response {
    const t = this.owned(id, body);
    if (t instanceof Response) return t;
    t.attempt += 1;
    t.error_message = String(body.message ?? body.error ?? "failed");
    t.error_retryable = Boolean(body.retryable);
    t.worker_id = null;
    if (body.retryable && t.attempt < t.max_attempts) {
      const initial = t.retry?.initial_backoff_ms ?? 0;
      const backoff = Math.min(initial * 2 ** (t.attempt - 1), t.retry?.max_backoff_ms ?? Infinity);
      t.state = "pending";
      t.available_at = this.nowMs + backoff;
    } else {
      t.state = "failed";
      t.completed_at = this.iso();
    }
    this.syncJob(t);
    return json({ ok: true });
  }

  private heartbeat(id: string, body: any): Response {
    const t = this.owned(id, body);
    if (t instanceof Response) return t;
    t.heartbeat_at = this.iso();
    if (body.checkpoint !== undefined) {
      if (body.checkpoint_seq === undefined) return error(400, "checkpoint_seq is required with checkpoint");
      if (body.checkpoint_seq !== t.checkpoint_seq) {
        return error(409, "worker task ownership or checkpoint sequence changed");
      }
      t.resume_checkpoint = body.checkpoint;
      t.checkpoint_seq += 1;
    }
    return json({ checkpoint_seq: t.checkpoint_seq });
  }

  private createInstance(body: any): Response {
    if (!body?.tenant_id) return error(400, "tenant_id is required");
    const id = typeof body.id === "string" ? body.id : this.id("inst");
    const instance: FakeInstance = {
      ...body,
      id,
      tenant_id: body.tenant_id,
      namespace: body.namespace ?? "default",
      sequence_id: body.sequence_id,
      state: "scheduled",
      context: body.context ?? {},
      signals: [],
      created_at: this.iso(),
      updated_at: this.iso(),
    };
    this.instances.set(id, instance);
    return json(instance, 201);
  }

  private withInstance(rawId: string, fn: (instance: FakeInstance) => Response): Response {
    const instance = this.instances.get(decodeURIComponent(rawId));
    return instance ? fn(instance) : error(404, `instance ${rawId} not found`);
  }

  private outputs(instanceId: string): Response {
    const outputs = [...this.tasks.values()]
      .filter((t) => t.instance_id === instanceId && t.state === "completed")
      .map((t) => ({
        id: `${t.id}-out`,
        instance_id: t.instance_id,
        block_id: t.block_id,
        output: t.output,
        created_at: t.completed_at,
      }));
    return json(outputs);
  }

  // Jobs --------------------------------------------------------------------

  private enqueueJob(body: any): Response {
    if (!body?.handler) return error(400, "handler is required");
    if (body.idempotency_key && this.jobKeys.has(body.idempotency_key)) {
      const existing = this.jobs.get(this.jobKeys.get(body.idempotency_key)!)!;
      return json(existing.job, 200);
    }
    let delayMs = Number(body.delay_ms ?? 0);
    if (body.run_at) {
      const at = Date.parse(body.run_at);
      if (Number.isNaN(at)) return error(400, "run_at must be RFC 3339");
      delayMs = Math.max(0, at - this.nowMs);
    }
    const jobId = this.id("job");
    const task = this.enqueueTask({
      handler_name: body.handler,
      params: body.payload,
      queue_name: body.queue ?? null,
      delayMs,
      retry: body.retry,
      block_id: "job",
    });
    task.job_id = jobId;
    const job: Job = {
      id: jobId,
      instance_id: task.instance_id,
      handler: body.handler,
      status: "scheduled",
      created_at: this.iso(),
      run_at: this.iso(task.available_at),
    };
    this.jobs.set(jobId, { job, task_id: task.id, metadata: body.metadata, payload: body.payload });
    if (body.idempotency_key) this.jobKeys.set(body.idempotency_key, jobId);
    return json(job, 201);
  }

  private syncJob(t: FakeTask): void {
    if (!t.job_id) return;
    const entry = this.jobs.get(t.job_id);
    if (!entry || entry.job.status === "cancelled") return;
    const status: JobStatus =
      t.state === "completed" ? "completed"
      : t.state === "failed" ? (t.error_retryable ? "dead_lettered" : "failed")
      : t.state === "claimed" ? "running"
      : "scheduled";
    entry.job.status = status;
    entry.job.run_at = this.iso(t.available_at);
  }

  private jobDetail(jobId: string): JobDetail | undefined {
    const entry = this.jobs.get(jobId);
    if (!entry) return undefined;
    const t = this.tasks.get(entry.task_id)!;
    return {
      ...entry.job,
      attempts: t.attempt,
      ...(t.state === "completed" ? { output: t.output } : {}),
      ...(t.error_message ? { error: t.error_message } : {}),
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
    };
  }

  private getJob(id: string): Response {
    const detail = this.jobDetail(id);
    return detail ? json(detail) : error(404, `job ${id} not found`);
  }

  private listJobs(url: URL): Response {
    const handler = url.searchParams.get("handler");
    const status = url.searchParams.get("status");
    const limit = Math.max(1, Number(url.searchParams.get("limit") ?? 50));
    const start = Number(url.searchParams.get("cursor") ?? 0);
    const all = [...this.jobs.values()]
      .map((e) => e.job)
      .filter((j) => (!handler || j.handler === handler) && (!status || j.status === status));
    const items = all.slice(start, start + limit);
    const next = start + limit < all.length ? String(start + limit) : null;
    return json({ items, next_cursor: next });
  }

  private cancelJob(id: string): Response {
    const entry = this.jobs.get(id);
    if (!entry) return error(404, `job ${id} not found`);
    const t = this.tasks.get(entry.task_id)!;
    if (TERMINAL.includes(t.state)) return error(409, "job already finished");
    t.state = "failed";
    t.error_message = "cancelled";
    entry.job.status = "cancelled";
    return json(undefined, 204);
  }
}

function publicTask(t: FakeTask): WorkerTask {
  const { available_at: _a, max_attempts: _m, retry: _r, job_id: _j, ...task } = t;
  return { ...task };
}
