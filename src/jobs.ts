import type { Orch8Client } from "./client.js";
import type { Page } from "./types.js";

/** Lifecycle states reported by the engine's background-jobs API. */
export type JobStatus =
  | "scheduled"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "dead_lettered";

/** Statuses after which a job never changes again. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "dead_lettered",
];

export interface JobRetryPolicy {
  max_attempts: number;
  initial_backoff_ms: number;
  max_backoff_ms?: number;
}

export interface EnqueueJobOptions {
  /** Worker queue the job's task is routed to. */
  queue?: string;
  priority?: number;
  retry?: JobRetryPolicy;
  /** Run no earlier than `delay_ms` from now. Mutually exclusive with `runAt`. */
  delayMs?: number;
  /** Run no earlier than this instant (`Date` or RFC 3339 string). */
  runAt?: Date | string;
  /**
   * Deduplication key. Enqueuing the same key twice returns the existing job
   * instead of creating a second one, so retrying an enqueue is safe.
   */
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

/** Wire body for `POST /jobs`. */
export interface EnqueueJobRequest<P = unknown> {
  handler: string;
  payload: P;
  queue?: string;
  priority?: number;
  retry?: JobRetryPolicy;
  delay_ms?: number;
  run_at?: string;
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
}

/** Response of `POST /jobs` and the summary shape returned by `GET /jobs`. */
export interface Job {
  id: string;
  instance_id: string;
  handler: string;
  status: JobStatus;
  created_at: string;
  run_at: string;
  [key: string]: unknown;
}

/** `GET /jobs/{id}` detail. */
export interface JobDetail<O = unknown> extends Job {
  attempts?: number | unknown[];
  output?: O;
  error?: unknown;
}

export interface ListJobsFilter {
  handler?: string;
  status?: JobStatus;
  /** Page size requested from the server. */
  limit?: number;
  /** Resume from a cursor returned by a previous page. */
  cursor?: string;
}

export interface WaitForJobOptions {
  /** Give up after this long. Default: 5 minutes. */
  timeoutMs?: number;
  /** Delay between polls. Default: 500 ms. */
  pollIntervalMs?: number;
  /** Abort the wait early. */
  signal?: AbortSignal;
}

/** Thrown by {@link JobsClient.waitFor} when the job does not settle in time. */
export class JobWaitTimeoutError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly lastStatus: JobStatus | undefined,
  ) {
    super(`job ${jobId} did not reach a terminal status (last: ${lastStatus ?? "unknown"})`);
    this.name = "JobWaitTimeoutError";
  }
}

export function isTerminalJobStatus(status: string): status is JobStatus {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}

/**
 * Client for the engine's background-jobs API.
 *
 * A job is a one-step durable run: the engine creates an instance whose single
 * step dispatches to the worker handler named `handler`. Workers need nothing
 * job-specific — register `handler` on an ordinary `Orch8Worker`.
 */
export class JobsClient {
  constructor(private readonly client: Orch8Client) {}

  /** Enqueue a job for `handler`. */
  enqueue<P = unknown>(handler: string, payload: P, options: EnqueueJobOptions = {}): Promise<Job> {
    if (!handler) return Promise.reject(new TypeError("handler is required"));
    if (options.delayMs !== undefined && options.runAt !== undefined) {
      return Promise.reject(new TypeError("delayMs and runAt are mutually exclusive"));
    }
    const body: EnqueueJobRequest<P> = { handler, payload };
    if (options.queue !== undefined) body.queue = options.queue;
    if (options.priority !== undefined) body.priority = options.priority;
    if (options.retry !== undefined) body.retry = options.retry;
    if (options.delayMs !== undefined) body.delay_ms = options.delayMs;
    if (options.runAt !== undefined) {
      body.run_at = options.runAt instanceof Date ? options.runAt.toISOString() : options.runAt;
    }
    if (options.idempotencyKey !== undefined) body.idempotency_key = options.idempotencyKey;
    if (options.metadata !== undefined) body.metadata = options.metadata;
    return this.client.request<Job>("POST", "/jobs", body);
  }

  get<O = unknown>(id: string): Promise<JobDetail<O>> {
    return this.client.request<JobDetail<O>>("GET", `/jobs/${encodeURIComponent(id)}`);
  }

  /** Fetch a single page of jobs. */
  listPage(filter: ListJobsFilter = {}): Promise<Page<Job>> {
    const query: Record<string, string> = {};
    if (filter.handler) query.handler = filter.handler;
    if (filter.status) query.status = filter.status;
    if (filter.limit !== undefined) query.limit = String(filter.limit);
    if (filter.cursor) query.cursor = filter.cursor;
    return this.client.requestPage<Job>("/jobs", query);
  }

  /**
   * Iterate over pages of jobs, following `next_cursor` until exhausted.
   *
   * ```ts
   * for await (const page of client.jobs.list({ status: "failed" })) {
   *   for (const job of page.items) console.log(job.id);
   * }
   * ```
   */
  async *list(filter: ListJobsFilter = {}): AsyncGenerator<Page<Job>, void, undefined> {
    let cursor = filter.cursor;
    const seen = new Set<string>();
    for (;;) {
      const page = await this.listPage({ ...filter, cursor });
      yield page;
      if (!page.next_cursor || seen.has(page.next_cursor)) return;
      seen.add(page.next_cursor);
      cursor = page.next_cursor;
    }
  }

  /** Iterate over individual jobs across all pages. */
  async *listAll(filter: ListJobsFilter = {}): AsyncGenerator<Job, void, undefined> {
    for await (const page of this.list(filter)) yield* page.items;
  }

  /** Cancel a job that has not finished yet. */
  cancel(id: string): Promise<void> {
    return this.client.request<void>("DELETE", `/jobs/${encodeURIComponent(id)}`);
  }

  /**
   * Poll `GET /jobs/{id}` until the job reaches a terminal status and return
   * the final detail. Does not throw for `failed`/`dead_lettered` — inspect
   * `status` and `error`. Throws {@link JobWaitTimeoutError} on timeout.
   */
  async waitFor<O = unknown>(id: string, options: WaitForJobOptions = {}): Promise<JobDetail<O>> {
    const timeoutMs = options.timeoutMs ?? 5 * 60_000;
    const pollMs = Math.max(10, options.pollIntervalMs ?? 500);
    const deadline = Date.now() + timeoutMs;
    let last: JobStatus | undefined;
    for (;;) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
      const job = await this.get<O>(id);
      last = job.status;
      if (isTerminalJobStatus(job.status)) return job;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new JobWaitTimeoutError(id, last);
      await sleep(Math.min(pollMs, remaining), options.signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
