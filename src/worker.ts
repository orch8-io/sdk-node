import type { WorkerTask } from "./types.js";
import type { Orch8Client } from "./client.js";

export type HandlerFn = (task: WorkerTask) => Promise<unknown>;

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
}

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
    client?: Orch8Client;
  };

  private running = false;
  private pollTimers = new Map<string, NodeJS.Timeout>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
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
      client: config.client,
    };
    this.concurrencySemaphore = this.config.maxConcurrent;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Start a poll loop per handler using dynamic scheduling for backoff.
    for (const handlerName of Object.keys(this.config.handlers)) {
      this.consecutiveFailures.set(handlerName, 0);
      this.schedulePoll(handlerName, 0);
    }

    // Start heartbeat loop.
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeats();
    }, this.config.heartbeatIntervalMs);
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
            : this.config.pollIntervalMs;
        this.schedulePoll(handlerName, nextDelay);
      });
    }, delayMs);
    this.pollTimers.set(handlerName, timer);
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.pollTimers.values()) clearTimeout(timer);
    this.pollTimers.clear();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // Drain in-flight tasks with a hard timeout.
    const drainTimeoutMs = 30_000;
    const drain = Promise.allSettled(Array.from(this.executingPromises));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, drainTimeoutMs));
    await Promise.race([drain, timeout]);
  }

  private async poll(handlerName: string): Promise<void> {
    if (!this.running || this.concurrencySemaphore <= 0) return;

    // Circuit breaker check: skip polling if the handler's circuit is open.
    if (this.config.circuitBreakerCheck) {
      try {
        if (this.config.client) {
          const cb = await this.config.client.getCircuitBreaker(handlerName);
          if (cb.state === "open") return;
        } else {
          const cbRes = await fetch(
            `${this.config.engineUrl}/circuit-breakers/${handlerName}`,
            { method: "GET", headers: { "Content-Type": "application/json" } },
          );
          if (cbRes.ok) {
            const cb = (await cbRes.json()) as { state: string };
            if (cb.state === "open") return;
          }
        }
      } catch {
        // If the check fails, proceed with polling anyway.
      }
    }

    try {
      const limit = Math.min(this.concurrencySemaphore, this.config.maxConcurrent);

      let tasks: WorkerTask[];
      if (this.config.client) {
        tasks = await this.config.client.pollTasks({
          handler_name: handlerName,
          worker_id: this.config.workerId,
          limit,
        });
      } else {
        const res = await fetch(`${this.config.engineUrl}/workers/tasks/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            handler_name: handlerName,
            worker_id: this.config.workerId,
            limit,
          }),
        });

        if (!res.ok) {
          this.consecutiveFailures.set(
            handlerName,
            (this.consecutiveFailures.get(handlerName) ?? 0) + 1,
          );
          return;
        }
        tasks = (await res.json()) as WorkerTask[];
      }

      // Reset backoff on successful poll.
      this.consecutiveFailures.set(handlerName, 0);

      for (const task of tasks) {
        if (this.concurrencySemaphore <= 0) break;
        this.concurrencySemaphore--;
        this.inFlightTasks.set(task.id, task);
        const p = this.executeTask(task);
        this.executingPromises.add(p);
        p.finally(() => this.executingPromises.delete(p));
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
      await this.failTask(task.id, `no handler registered for "${task.handler_name}"`, false);
      return;
    }

    try {
      const output = await this.withTimeout(handler(task), task.timeout_ms);
      await this.completeTask(task.id, output);
      this.config.onTaskComplete?.(task, output);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Handler exceptions are non-retryable by default — matches engine
      // FailRequest default and conservative behavior across SDKs. Users who
      // want retry-on-throw can call client.failTask with retryable=true
      // directly from their handler.
      await this.failTask(task.id, message, false);
      this.config.onTaskFail?.(task, message);
    } finally {
      this.inFlightTasks.delete(task.id);
      this.concurrencySemaphore++;
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number | null): Promise<T> {
    if (!timeoutMs) return promise;
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("task timed out")), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private async completeTask(taskId: string, output: unknown): Promise<void> {
    try {
      if (this.config.client) {
        await this.config.client.completeTask(taskId, {
          worker_id: this.config.workerId,
          output: output ?? {},
        });
      } else {
        await fetch(`${this.config.engineUrl}/workers/tasks/${taskId}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            worker_id: this.config.workerId,
            output: output ?? {},
          }),
        });
      }
    } catch {
      // Will be reaped and retried.
    }
  }

  private async failTask(taskId: string, message: string, retryable: boolean): Promise<void> {
    try {
      if (this.config.client) {
        await this.config.client.failTask(taskId, {
          worker_id: this.config.workerId,
          message,
          retryable,
        });
      } else {
        await fetch(`${this.config.engineUrl}/workers/tasks/${taskId}/fail`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            worker_id: this.config.workerId,
            message,
            retryable,
          }),
        });
      }
    } catch {
      // Will be reaped and retried.
    }
  }

  private async sendHeartbeats(): Promise<void> {
    const ids = Array.from(this.inFlightTasks.keys());
    await Promise.allSettled(
      ids.map((taskId) => {
        if (this.config.client) {
          return this.config.client.heartbeatTask(taskId, {
            worker_id: this.config.workerId,
          });
        }
        return fetch(`${this.config.engineUrl}/workers/tasks/${taskId}/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ worker_id: this.config.workerId }),
        });
      }),
    );
  }
}
