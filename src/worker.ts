import type {
  RuntimeCapabilities,
  RuntimeConnectivity,
  RuntimeKind,
  RuntimeTrustLevel,
  WorkerTask,
} from "./types.js";
import { Orch8Client, Orch8Error } from "./client.js";
import { workerTaskContext, type WorkerTaskContext } from "./internal/task-context.js";

export { workerTaskContext, type WorkerTaskContext };

export type HandlerFn = (task: WorkerTask, context: WorkerTaskContext) => Promise<unknown>;

/**
 * Capabilities advertised with every poll so the worker can claim tasks whose
 * `params.$runtime` placement requires them. `runtime_id` is always the
 * worker id, `handlers` defaults to the configured handler names, and the
 * observation window is refreshed on each poll.
 */
export interface WorkerCapabilities {
  /** Default: `server`. */
  kind?: RuntimeKind;
  /** Default: `registered` (the most a self-advertised runtime may claim). */
  trust?: RuntimeTrustLevel;
  handlers?: string[];
  plugins?: string[];
  /** Credential binding references only, never secret material. */
  credentials?: string[];
  regions?: string[];
  hardware?: string[];
  offline_capable?: boolean;
  connectivity?: RuntimeConnectivity;
  battery_percent?: number;
  estimated_cost_microunits?: number;
  estimated_latency_ms?: number;
  capsule_signing_public_key?: string;
  /** Advertisement lifetime, capped at 300 (the server maximum). Default: 300. */
  ttlSecs?: number;
}

export interface WorkerRuntimeStats {
  running: boolean;
  inFlight: number;
  availableSlots: number;
  handlers: string[];
}

export interface WorkerConfig {
  /** Base URL of the Orch8 engine API (e.g. "http://localhost:8080"). */
  engineUrl?: string;
  /** Unique identifier for this worker instance. */
  workerId: string;
  /** Map of handler names to async handler functions. */
  handlers: Record<string, HandlerFn>;
  /** How often to poll for new tasks (ms). Default: 1000. */
  pollIntervalMs?: number;
  /** How often to send heartbeats for in-flight tasks (ms). Default: 15000. */
  heartbeatIntervalMs?: number;
  /** Maximum concurrent tasks per handler. Default: 10. */
  maxConcurrent?: number;
  /**
   * When enabled, the worker checks the circuit breaker state for each handler
   * before polling and skips polling if the circuit is open. Default: false.
   */
  circuitBreakerCheck?: boolean;
  /** Called after a task completes successfully. */
  onTaskComplete?: (task: WorkerTask, output: unknown) => void;
  /** Called after a task fails. */
  onTaskFail?: (task: WorkerTask, error: string) => void;
  /**
   * Optional Orch8Client to use for API calls. When provided, the worker
   * delegates all HTTP operations to the client instead of using raw fetch.
   * This ensures consistent auth, headers, and base URL handling.
   */
  client?: Orch8Client;
  /**
   * Advertise runtime capabilities with each poll. Without them the worker
   * only claims tasks that carry no `$runtime` requirements.
   */
  capabilities?: WorkerCapabilities;
}

const MAX_CAPABILITY_TTL_SECS = 300;

export class Orch8Worker {
  private readonly config: Required<
    Pick<
      WorkerConfig,
      | "workerId"
      | "pollIntervalMs"
      | "heartbeatIntervalMs"
      | "maxConcurrent"
      | "circuitBreakerCheck"
    >
  > & {
    engineUrl: string;
    handlers: Record<string, HandlerFn>;
    onTaskComplete?: (task: WorkerTask, output: unknown) => void;
    onTaskFail?: (task: WorkerTask, error: string) => void;
    capabilities?: WorkerCapabilities;
  };

  private readonly client: Orch8Client;
  private stopping = false;
  private pollHints = new Map<string, number>();
  private heartbeatIntervals = new Map<string, number>();
  /** Claims whose lease was lost (heartbeat 404/409); never acknowledged. */
  private lostTasks = new Set<string>();
  private running = false;
  private pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlightTasks = new Map<string, WorkerTask>();
  private executingPromises = new Set<Promise<void>>();
  private concurrencySemaphore: number;

  /** Tracks consecutive poll failures per handler for exponential backoff. */
  private consecutiveFailures = new Map<string, number>();
  private static readonly MAX_BACKOFF_MS = 30_000;

  constructor(config: WorkerConfig) {
    if (!config.client && !config.engineUrl) {
      throw new Error("WorkerConfig must provide either client or engineUrl");
    }
    this.config = {
      engineUrl: config.engineUrl?.replace(/\/$/, "") ?? "",
      workerId: config.workerId,
      handlers: config.handlers,
      pollIntervalMs: config.pollIntervalMs ?? 1000,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 15000,
      maxConcurrent: config.maxConcurrent ?? 10,
      circuitBreakerCheck: config.circuitBreakerCheck ?? false,
      onTaskComplete: config.onTaskComplete,
      onTaskFail: config.onTaskFail,
      capabilities: config.capabilities,
    };
    this.client = config.client ?? new Orch8Client({ baseUrl: this.config.engineUrl, retry: false });
    this.concurrencySemaphore = this.config.maxConcurrent;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;

    // Start a poll loop per handler using dynamic scheduling for backoff.
    for (const handlerName of Object.keys(this.config.handlers)) {
      this.consecutiveFailures.set(handlerName, 0);
      this.schedulePoll(handlerName, 0);
    }

    // Start heartbeat loop.
    this.resetHeartbeatTimer();
  }

  private schedulePoll(handlerName: string, delayMs: number): void {
    // Clear any existing timer for this handler to prevent memory leak.
    const existing = this.pollTimers.get(handlerName);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      if (!this.running) return;
      void this.poll(handlerName).finally(() => {
        if (!this.running) return;
        const failures = this.consecutiveFailures.get(handlerName) ?? 0;
        const nextDelay =
          failures > 0
            ? Math.min(
                this.config.pollIntervalMs * Math.pow(2, failures),
                Orch8Worker.MAX_BACKOFF_MS,
              )
            : Math.max(this.config.pollIntervalMs, this.pollHints.get(handlerName) ?? 0);
        this.schedulePoll(handlerName, nextDelay);
      });
    }, delayMs);
    this.pollTimers.set(handlerName, timer);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    for (const timer of this.pollTimers.values()) clearTimeout(timer);
    this.pollTimers.clear();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // Drain in-flight tasks with a hard timeout.
    const drainTimeoutMs = 30_000;
    const drain = Promise.allSettled(Array.from(this.executingPromises));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, drainTimeoutMs); });
    try {
      await Promise.race([drain, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  stats(): WorkerRuntimeStats {
    return {
      running: this.running,
      inFlight: this.inFlightTasks.size,
      availableSlots: this.concurrencySemaphore,
      handlers: Object.keys(this.config.handlers),
    };
  }

  /** Fresh capability advertisement for one poll, or undefined when none is configured. */
  private advertisement(): RuntimeCapabilities | undefined {
    const caps = this.config.capabilities;
    if (!caps) return undefined;
    const { ttlSecs, kind, trust, handlers, ...facts } = caps;
    const ttl = Math.min(Math.max(ttlSecs ?? MAX_CAPABILITY_TTL_SECS, 1), MAX_CAPABILITY_TTL_SECS);
    const now = Date.now();
    return {
      ...facts,
      runtime_id: this.config.workerId,
      kind: kind ?? "server",
      trust: trust ?? "registered",
      handlers: handlers ?? Object.keys(this.config.handlers),
      observed_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttl * 1000).toISOString(),
    };
  }

  /**
   * Give claimed-but-unstarted tasks back (`started: false`) so they return to
   * `pending` at once instead of waiting for lease expiry. Servers without
   * `/release` answer 404/405; the lease then expires as before.
   */
  private async releaseUnstarted(tasks: WorkerTask[]): Promise<void> {
    await Promise.allSettled(
      tasks.map((task) =>
        this.client.releaseTask(task.id, {
          worker_id: this.config.workerId,
          claim_epoch: task.claim_epoch,
          started: false,
        }),
      ),
    );
  }

  private async poll(handlerName: string): Promise<void> {
    if (!this.running || this.concurrencySemaphore <= 0) return;

    // Circuit breaker check: skip polling if the handler's circuit is open.
    if (this.config.circuitBreakerCheck) {
      try {
        const cb = await this.client.getCircuitBreaker(handlerName);
        if (cb.state === "open") return;
      } catch {
        // If the check fails, proceed with polling anyway.
      }
    }

    try {
      const limit = Math.min(this.concurrencySemaphore, this.config.maxConcurrent);

      const capabilities = this.advertisement();
      const batch = await this.client.pollTaskBatch({
        handler_name: handlerName,
        worker_id: this.config.workerId,
        limit,
        ...(capabilities ? { capabilities } : {}),
      });
      const tasks = batch.tasks;
      this.pollHints.set(handlerName, batch.poll_after_ms ?? 0);
      const heartbeatMs = Math.min(
        this.config.heartbeatIntervalMs,
        (batch.heartbeat_interval_secs ?? Infinity) * 1000,
        (batch.lease_secs ?? Infinity) * 500,
      );
      this.heartbeatIntervals.set(handlerName, heartbeatMs);

      // Reset backoff on successful poll.
      this.consecutiveFailures.set(handlerName, 0);

      const unstarted: WorkerTask[] = [];
      for (const task of tasks) {
        // Claimed while shutting down, or beyond free capacity: never started.
        if (!this.running || this.stopping || this.concurrencySemaphore <= 0) {
          unstarted.push(task);
          continue;
        }
        this.concurrencySemaphore--;
        this.inFlightTasks.set(task.id, task);
        const p = this.executeTask(task);
        this.executingPromises.add(p);
        p.finally(() => this.executingPromises.delete(p));
      }
      if (this.running) this.resetHeartbeatTimer();
      if (unstarted.length > 0) {
        const released = this.releaseUnstarted(unstarted);
        this.executingPromises.add(released);
        void released.finally(() => this.executingPromises.delete(released));
      }
    } catch {
      // Network error — increment failures for backoff.
      this.consecutiveFailures.set(
        handlerName,
        (this.consecutiveFailures.get(handlerName) ?? 0) + 1,
      );
    }
  }

  private async executeTask(task: WorkerTask): Promise<void> {
    const handler = this.config.handlers[task.handler_name];
    if (!handler) {
      await this.failTask(task, `no handler registered for "${task.handler_name}"`, false).catch(() => {});
      this.inFlightTasks.delete(task.id);
      this.concurrencySemaphore++;
      return;
    }

    try {
      let output: unknown;
      try {
        output = await this.withTimeout(handler(task, workerTaskContext(task, this.config.workerId)), task.timeout_ms);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Uncaught errors are transient unless explicitly flagged otherwise.
        const retryable = err instanceof Error && "retryable" in err
          ? Boolean(err.retryable) : true;
        if (this.lostTasks.has(task.id)) return;
        await this.failTask(task, message, retryable);
        this.notify(() => this.config.onTaskFail?.(task, message));
        return;
      }
      // A lost lease cannot be acknowledged; the engine already reclaimed it.
      if (this.lostTasks.has(task.id)) return;
      // A rejected or ambiguous acknowledgement is not a handler failure.
      await this.completeTask(task, output);
      this.notify(() => this.config.onTaskComplete?.(task, output));
    } catch {
      // Leave unacknowledged work for lease recovery; never report success.
    } finally {
      this.inFlightTasks.delete(task.id);
      this.lostTasks.delete(task.id);
      this.concurrencySemaphore++;
    }
  }

  private notify(callback: () => void): void {
    try {
      callback();
    } catch {
      // Lifecycle observers must not alter task acknowledgement semantics.
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number | null): Promise<T> {
    if (!timeoutMs) return promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("task timed out")), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private completeTask(task: WorkerTask, output: unknown): Promise<void> {
    return this.client.completeTask(task.id, {
      worker_id: this.config.workerId,
      claim_epoch: task.claim_epoch,
      output: output ?? {},
    });
  }

  private failTask(task: WorkerTask, message: string, retryable: boolean): Promise<void> {
    return this.client.failTask(task.id, {
      worker_id: this.config.workerId,
      claim_epoch: task.claim_epoch,
      message,
      retryable,
    });
  }

  private heartbeatDelayMs = 0;

  private resetHeartbeatTimer(): void {
    // Heartbeat at half of the shortest lease in play: the poll-level hint and
    // each in-flight task's own `lease_secs` (mobile/browser leases differ).
    const taskLeaseMs = Array.from(this.inFlightTasks.values(), (t) =>
      typeof t.lease_secs === "number" && t.lease_secs > 0 ? t.lease_secs * 500 : Infinity,
    );
    const delay = Math.max(
      250,
      Math.min(this.config.heartbeatIntervalMs, ...this.heartbeatIntervals.values(), ...taskLeaseMs),
    );
    if (this.heartbeatTimer && delay === this.heartbeatDelayMs) return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatDelayMs = delay;
    this.heartbeatTimer = setInterval(() => { void this.sendHeartbeats(); }, delay);
  }

  private async sendHeartbeats(): Promise<void> {
    const live = Array.from(this.inFlightTasks.values()).filter((t) => !this.lostTasks.has(t.id));
    await Promise.allSettled(
      live.map((task) => this.client.heartbeatTask(task.id, {
        worker_id: this.config.workerId,
        claim_epoch: task.claim_epoch,
      }).catch((err: unknown) => {
        // 404/409: the lease is gone. Stop heartbeating and never ack this claim.
        if (err instanceof Orch8Error && (err.status === 404 || err.status === 409)) {
          this.lostTasks.add(task.id);
        }
        throw err;
      })),
    );
  }
}
