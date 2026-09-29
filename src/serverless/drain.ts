/**
 * `drainOnce` — claim, run and acknowledge a bounded batch of worker tasks
 * inside a fixed time budget, then return. The building block for executors
 * that live for one invocation (AWS Lambda, Cloudflare Workers, cron jobs).
 *
 * It speaks the same lease protocol as `Orch8Worker` through the SDK client
 * (`poll` → `heartbeat`* → `complete` | `fail`, echoing `claim_epoch`) and
 * adds one rule: nothing may still hold a lease when the budget ends. Tasks
 * that are still running at `deadlineMs - releaseMarginMs` are released with
 * `started: true` (the engine marks a side-effecting step's receipt Unknown
 * and re-dispatches), and claims that cannot fit the remaining budget are
 * released with `started: false` so another executor picks them up at once.
 *
 * This module graph is free of Node built-ins: it only needs `fetch` (via the
 * client), timers and `AbortController`.
 */
import type { Orch8Client } from "../client.js";
import type { RuntimeKind, WorkerPollResponse, WorkerTask } from "../types.js";
import type { WorkerCapabilities } from "../worker.js";
import { buildAdvertisement } from "../internal/capabilities.js";
import { workerTaskContext, type WorkerTaskContext } from "../internal/task-context.js";

/** The subset of `Orch8Client` the drain loop uses (the worker lease API). */
export type LeaseClient = Pick<
  Orch8Client,
  "pollTaskBatch" | "pollTaskBatchFromQueue" | "heartbeatTask" | "completeTask" | "failTask" | "releaseTask"
>;

/** Handler context: the worker lease facts plus the invocation budget. */
export interface ServerlessTaskContext extends WorkerTaskContext {
  /** Aborted when the budget ends (the task is then released) or the lease is lost. */
  signal: AbortSignal;
  /** Epoch ms by which the handler must have returned (release point). */
  deadlineMs: number;
  /** Milliseconds left until {@link deadlineMs}, never negative. */
  remainingMs(): number;
  /** Extend the lease now (the drain loop also heartbeats on its own). */
  heartbeat(): Promise<void>;
}

/**
 * A step handler. Plain `Orch8Worker` handlers (`HandlerFn`) are accepted
 * unchanged; they simply ignore the extra context fields.
 */
export type ServerlessHandler = (task: WorkerTask, context: ServerlessTaskContext) => Promise<unknown>;

export interface DrainOptions {
  /** SDK client (`Orch8Client`) whose credentials may poll and acknowledge worker tasks. */
  client: LeaseClient;
  /** Handler map keyed by the step's handler name; each name is polled. */
  handlers: Record<string, ServerlessHandler>;
  /**
   * Absolute deadline (epoch milliseconds) by which every lease taken by this
   * drain must be settled — completed, failed or released. Adapters derive it
   * from the platform's remaining time minus a safety margin.
   */
  deadlineMs: number;
  /** Lease `worker_id`. Default: `serverless-<random>`. */
  workerId?: string;
  /** Maximum tasks claimed by this drain (N). Default: 10. */
  maxTasks?: number;
  /** Time reserved before `deadlineMs` for release calls. Default: 1000 ms. */
  releaseMarginMs?: number;
  /** Do not claim new work when less than this remains before the release point. Default: 1000 ms. */
  minTaskBudgetMs?: number;
  /** Upper bound on the heartbeat interval; lease hints shorten it. Default: 15000 ms. */
  heartbeatIntervalMs?: number;
  /** Claim from this queue (`POST /workers/tasks/poll/queue`) instead of by handler. */
  queueName?: string;
  /** Advertise runtime capabilities so `$runtime`-placed tasks can be claimed. */
  capabilities?: WorkerCapabilities;
  /** `kind` used when `capabilities.kind` is unset. Default: `server`. */
  defaultKind?: RuntimeKind;
  /** Clock override (epoch ms) for tests. */
  now?: () => number;
}

export type DrainTaskOutcome =
  /** Handler returned and the completion was acknowledged. */
  | "completed"
  /** Handler threw (or timed out / had no handler) and the failure was acknowledged. */
  | "failed"
  /** Still running at the release point; released with `started: true`. */
  | "released"
  /** Claimed but not started because it could not fit the budget; released with `started: false`. */
  | "released_unstarted"
  /** A heartbeat answered 404/409: the engine reclaimed it; never acknowledged. */
  | "lease_lost"
  /** The engine rejected the completion/failure/release request. */
  | "ack_rejected";

export interface DrainTaskResult {
  task_id: string;
  handler_name: string;
  outcome: DrainTaskOutcome;
  error?: string;
}

export type DrainStopReason =
  /** No handler had pending work. */
  | "empty"
  /** The budget ran out (or the remaining work could not fit it). */
  | "deadline"
  /** `maxTasks` were claimed. */
  | "max_tasks"
  /** Every poll failed. */
  | "poll_error";

export interface DrainResult {
  workerId: string;
  claimed: number;
  completed: number;
  failed: number;
  /** Released with either `started` value. */
  released: number;
  leaseLost: number;
  ackRejected: number;
  stoppedBy: DrainStopReason;
  tasks: DrainTaskResult[];
  pollErrors: string[];
}

const DEFAULT_MAX_TASKS = 10;
const DEFAULT_RELEASE_MARGIN_MS = 1_000;
const DEFAULT_MIN_TASK_BUDGET_MS = 1_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const MIN_HEARTBEAT_MS = 250;

type Timer = ReturnType<typeof setTimeout>;

interface InFlight {
  task: WorkerTask;
  lost: boolean;
  onLost: () => void;
}

type Settled =
  | { kind: "ok"; value: unknown }
  | { kind: "error"; error: unknown }
  | { kind: "deadline" }
  | { kind: "timeout" }
  | { kind: "lost" };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function randomSuffix(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID().slice(0, 8);
  return Math.random().toString(16).slice(2, 10);
}

/** Default worker id for a serverless executor: `<prefix>-<random>`. */
export function serverlessWorkerId(prefix = "serverless"): string {
  return `${prefix}-${randomSuffix()}`;
}

function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: Timer | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms));
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Claim up to `maxTasks` tasks for the configured handlers, run them within
 * the budget, heartbeat while they run, acknowledge results, and release any
 * lease still held at `deadlineMs - releaseMarginMs`. Never throws for
 * engine or handler errors; the outcome of every claimed task is reported.
 */
export async function drainOnce(options: DrainOptions): Promise<DrainResult> {
  const now = options.now ?? Date.now;
  const client = options.client;
  const handlers = options.handlers;
  const handlerNames = Object.keys(handlers);
  if (handlerNames.length === 0) throw new TypeError("drainOnce requires at least one handler");
  if (!Number.isFinite(options.deadlineMs)) throw new TypeError("drainOnce requires a finite deadlineMs");

  const workerId = options.workerId ?? serverlessWorkerId();
  const maxTasks = Math.max(1, Math.floor(options.maxTasks ?? DEFAULT_MAX_TASKS));
  const releaseMarginMs = Math.max(0, options.releaseMarginMs ?? DEFAULT_RELEASE_MARGIN_MS);
  const minTaskBudgetMs = Math.max(0, options.minTaskBudgetMs ?? DEFAULT_MIN_TASK_BUDGET_MS);
  const stopAt = options.deadlineMs - releaseMarginMs;
  const remaining = (): number => Math.max(0, stopAt - now());

  const result: DrainResult = {
    workerId,
    claimed: 0,
    completed: 0,
    failed: 0,
    released: 0,
    leaseLost: 0,
    ackRejected: 0,
    stoppedBy: "empty",
    tasks: [],
    pollErrors: [],
  };
  const inFlight = new Map<string, InFlight>();
  let heartbeatMs = Math.max(MIN_HEARTBEAT_MS, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS);

  const release = (task: WorkerTask, started: boolean): Promise<void> =>
    client.releaseTask(task.id, { worker_id: workerId, claim_epoch: task.claim_epoch, started });

  const heartbeatOne = async (entry: InFlight): Promise<void> => {
    if (entry.lost) throw new Error("lease lost");
    try {
      await client.heartbeatTask(entry.task.id, { worker_id: workerId, claim_epoch: entry.task.claim_epoch });
    } catch (err) {
      const status = statusOf(err);
      if (status === 404 || status === 409) entry.onLost();
      throw err;
    }
  };

  const poll = async (handlerName: string, limit: number): Promise<WorkerPollResponse> => {
    const capabilities = options.capabilities
      ? buildAdvertisement(options.capabilities, workerId, handlerNames, now(), options.defaultKind)
      : undefined;
    const body = {
      handler_name: handlerName,
      worker_id: workerId,
      limit,
      ...(capabilities ? { capabilities } : {}),
    };
    return options.queueName
      ? client.pollTaskBatchFromQueue({ ...body, queue_name: options.queueName })
      : client.pollTaskBatch(body);
  };

  /** Poll raced against the release point; claims that arrive late are handed back. */
  const pollInBudget = async (handlerName: string, limit: number): Promise<WorkerTask[] | "deadline"> => {
    const pending = poll(handlerName, limit);
    const timer = delay(remaining());
    const winner = await Promise.race([
      pending.then((batch) => ({ batch }) as const),
      timer.promise.then(() => "deadline" as const),
    ]).finally(timer.cancel);
    if (winner === "deadline") {
      void pending.then(
        (late) => Promise.allSettled(late.tasks.map((t) => release(t, false))),
        () => undefined,
      );
      return "deadline";
    }
    const batch = winner.batch;
    const hints = [heartbeatMs];
    if (typeof batch.heartbeat_interval_secs === "number") hints.push(batch.heartbeat_interval_secs * 1000);
    if (typeof batch.lease_secs === "number") hints.push(batch.lease_secs * 500);
    heartbeatMs = Math.max(MIN_HEARTBEAT_MS, Math.min(...hints));
    return batch.tasks;
  };

  const record = (task: WorkerTask, outcome: DrainTaskOutcome, error?: string): DrainTaskResult => {
    const entry: DrainTaskResult = { task_id: task.id, handler_name: task.handler_name, outcome };
    if (error !== undefined) entry.error = error;
    return entry;
  };

  const acknowledge = async (
    task: WorkerTask,
    outcome: "completed" | "failed" | "released" | "released_unstarted",
    send: () => Promise<unknown>,
    error?: string,
  ): Promise<DrainTaskResult> => {
    try {
      await send();
      return record(task, outcome, error);
    } catch (ackErr) {
      return record(task, "ack_rejected", errorMessage(ackErr));
    }
  };

  const fail = (task: WorkerTask, message: string, retryable: boolean): Promise<DrainTaskResult> =>
    acknowledge(
      task,
      "failed",
      () => client.failTask(task.id, { worker_id: workerId, claim_epoch: task.claim_epoch, message, retryable }),
      message,
    );

  const runTask = async (task: WorkerTask): Promise<DrainTaskResult> => {
    const handler = handlers[task.handler_name];
    if (!handler) return fail(task, `no handler registered for "${task.handler_name}"`, false);

    // The step's own timeout cannot fit what is left: give it back unstarted.
    if (typeof task.timeout_ms === "number" && task.timeout_ms > 0 && task.timeout_ms > remaining()) {
      return acknowledge(task, "released_unstarted", () => release(task, false));
    }
    if (remaining() <= 0) return acknowledge(task, "released_unstarted", () => release(task, false));

    const controller = new AbortController();
    let signalLost: () => void = () => undefined;
    const lost = new Promise<Settled>((resolve) => {
      signalLost = () => resolve({ kind: "lost" });
    });
    const entry: InFlight = {
      task,
      lost: false,
      onLost: () => {
        if (entry.lost) return;
        entry.lost = true;
        signalLost();
      },
    };
    inFlight.set(task.id, entry);

    const context: ServerlessTaskContext = {
      ...workerTaskContext(task, workerId),
      signal: controller.signal,
      deadlineMs: stopAt,
      remainingMs: remaining,
      heartbeat: () => heartbeatOne(entry),
    };
    const running = Promise.resolve()
      .then(() => handler(task, context))
      .then(
        (value): Settled => ({ kind: "ok", value }),
        (error): Settled => ({ kind: "error", error }),
      );
    const deadline = delay(remaining());
    const timeout =
      typeof task.timeout_ms === "number" && task.timeout_ms > 0 ? delay(task.timeout_ms) : undefined;
    const contenders: Promise<Settled>[] = [
      running,
      lost,
      deadline.promise.then((): Settled => ({ kind: "deadline" })),
    ];
    if (timeout) contenders.push(timeout.promise.then((): Settled => ({ kind: "timeout" })));

    let settled: Settled;
    try {
      settled = await Promise.race(contenders);
    } finally {
      deadline.cancel();
      timeout?.cancel();
    }

    try {
      switch (settled.kind) {
        case "deadline":
          controller.abort(new Error("serverless budget exhausted; task released"));
          return await acknowledge(task, "released", () => release(task, true));
        case "lost":
          controller.abort(new Error("lease lost"));
          return record(task, "lease_lost");
        case "timeout":
          controller.abort(new Error("task timed out"));
          if (entry.lost) return record(task, "lease_lost");
          return await fail(task, "task timed out", true);
        case "error": {
          if (entry.lost) return record(task, "lease_lost");
          const err = settled.error;
          const retryable = err instanceof Error && "retryable" in err
            ? Boolean((err as { retryable?: unknown }).retryable)
            : true;
          return await fail(task, errorMessage(err), retryable);
        }
        case "ok":
          if (entry.lost) return record(task, "lease_lost");
          return await acknowledge(task, "completed", () =>
            client.completeTask(task.id, {
              worker_id: workerId,
              claim_epoch: task.claim_epoch,
              output: settled.value ?? {},
            }),
          );
      }
    } finally {
      inFlight.delete(task.id);
    }
  };

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const startHeartbeats = (): void => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      for (const entry of inFlight.values()) {
        if (!entry.lost) void heartbeatOne(entry).catch(() => undefined);
      }
    }, heartbeatMs);
  };

  try {
    for (;;) {
      if (result.claimed >= maxTasks) {
        result.stoppedBy = "max_tasks";
        break;
      }
      if (remaining() < Math.max(minTaskBudgetMs, 1)) {
        result.stoppedBy = "deadline";
        break;
      }

      const round: WorkerTask[] = [];
      let pollFailures = 0;
      let outOfTime = false;
      for (const handlerName of handlerNames) {
        const capacity = maxTasks - result.claimed - round.length;
        if (capacity <= 0) break;
        try {
          const tasks = await pollInBudget(handlerName, capacity);
          if (tasks === "deadline") {
            outOfTime = true;
            break;
          }
          round.push(...tasks.slice(0, capacity));
          // An over-delivering server: never hold more than `maxTasks` leases.
          for (const extra of tasks.slice(capacity)) {
            result.claimed += 1;
            result.tasks.push(await acknowledge(extra, "released_unstarted", () => release(extra, false)));
          }
        } catch (err) {
          pollFailures += 1;
          result.pollErrors.push(`${handlerName}: ${errorMessage(err)}`);
        }
        if (options.queueName) break; // one queue poll covers every handler
      }

      if (round.length === 0) {
        if (outOfTime) result.stoppedBy = "deadline";
        else if (pollFailures > 0) result.stoppedBy = "poll_error";
        else result.stoppedBy = "empty";
        break;
      }

      result.claimed += round.length;
      startHeartbeats();
      const outcomes = await Promise.all(round.map(runTask));
      result.tasks.push(...outcomes);
      if (outOfTime || outcomes.some((o) => o.outcome === "released" || o.outcome === "released_unstarted")) {
        result.stoppedBy = "deadline";
        break;
      }
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }

  for (const task of result.tasks) {
    if (task.outcome === "completed") result.completed += 1;
    else if (task.outcome === "failed") result.failed += 1;
    else if (task.outcome === "released" || task.outcome === "released_unstarted") result.released += 1;
    else if (task.outcome === "lease_lost") result.leaseLost += 1;
    else if (task.outcome === "ack_rejected") result.ackRejected += 1;
  }
  return result;
}
