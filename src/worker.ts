import type { WorkerTask } from "./types.js";

export type HandlerFn = (task: WorkerTask) => Promise<unknown>;

export interface WorkerConfig {
  /** Base URL of the Orch8 engine API (e.g. "http://localhost:8080"). */
  engineUrl: string;
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
}

export class Orch8Worker {
  private readonly config: Required<
    Pick<
      WorkerConfig,
      | "engineUrl"
      | "workerId"
      | "pollIntervalMs"
      | "heartbeatIntervalMs"
      | "maxConcurrent"
      | "circuitBreakerCheck"
    >
  > & {
    handlers: Record<string, HandlerFn>;
    onTaskComplete?: (task: WorkerTask, output: unknown) => void;
    onTaskFail?: (task: WorkerTask, error: string) => void;
  };

  private running = false;
  private pollTimers: NodeJS.Timeout[] = [];
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private inFlightTasks = new Map<string, WorkerTask>();
  private executingPromises = new Set<Promise<void>>();
  private concurrencySemaphore: number;

  /** Tracks consecutive poll failures per handler for exponential backoff. */
  private consecutiveFailures = new Map<string, number>();
  private static readonly MAX_BACKOFF_MS = 30_000;

  constructor(config: WorkerConfig) {
    this.config = {
      engineUrl: config.engineUrl.replace(/\/$/, ""),
      workerId: config.workerId,
      handlers: config.handlers,
      pollIntervalMs: config.pollIntervalMs ?? 1000,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 15000,
      maxConcurrent: config.maxConcurrent ?? 10,
      circuitBreakerCheck: config.circuitBreakerCheck ?? false,
      onTaskComplete: config.onTaskComplete,
      onTaskFail: config.onTaskFail,
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
    this.pollTimers.push(timer);
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.pollTimers) clearTimeout(timer);
    this.pollTimers = [];
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
        const cbRes = await fetch(
          `${this.config.engineUrl}/circuit-breakers/${handlerName}`,
          { method: "GET", headers: { "Content-Type": "application/json" } },
        );
        if (cbRes.ok) {
          const cb = (await cbRes.json()) as { state: string };
          if (cb.state === "open") return;
        }
      } catch {
        // If the check fails, proceed with polling anyway.
      }
    }

    try {
      const limit = Math.min(this.concurrencySemaphore, this.config.maxConcurrent);
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

      // Reset backoff on successful poll.
      this.consecutiveFailures.set(handlerName, 0);

      const tasks: WorkerTask[] = await res.json() as WorkerTask[];
      for (const task of tasks) {
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
      await fetch(`${this.config.engineUrl}/workers/tasks/${taskId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          worker_id: this.config.workerId,
          output: output ?? {},
        }),
      });
    } catch {
      // Will be reaped and retried.
    }
  }

  private async failTask(taskId: string, message: string, retryable: boolean): Promise<void> {
    try {
      await fetch(`${this.config.engineUrl}/workers/tasks/${taskId}/fail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          worker_id: this.config.workerId,
          message,
          retryable,
        }),
      });
    } catch {
      // Will be reaped and retried.
    }
  }

  private async sendHeartbeats(): Promise<void> {
    const ids = Array.from(this.inFlightTasks.keys());
    await Promise.allSettled(
      ids.map((taskId) =>
        fetch(`${this.config.engineUrl}/workers/tasks/${taskId}/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ worker_id: this.config.workerId }),
        }),
      ),
    );
  }
}
