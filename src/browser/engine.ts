/**
 * The browser lease engine: poll(claim) -> heartbeat* -> complete | fail,
 * with token refresh scheduling and exponential backoff.
 *
 * The same code runs in two places: directly on the main thread (fallback
 * mode) and inside the dedicated Web Worker, whose source is pre-bundled
 * into `lease-worker-source.ts` by `npm run generate:lease-worker`. Rerun
 * that script after changing this file; a test fails when it is stale.
 * Consumer bundlers only ever see the worker as an opaque string, so their
 * transforms (minification, keep-names helpers, down-levelling) cannot
 * break it.
 */
import type { EngineCommand, EngineConfig, EngineController, EngineEvent, EngineHost } from "./protocol.js";
import type { WorkerTask } from "../types.js";

export function leaseEngine(host: EngineHost): EngineController {
  type Timer = ReturnType<typeof setTimeout>;
  interface Entry {
    task: WorkerTask;
    workerId: string;
    hbMs: number;
    hbTimer: Timer | null;
    acking: boolean;
  }
  interface HttpResult {
    status: number;
    body: unknown;
  }

  let cfg: EngineConfig | null = null;
  let token: { token: string; expiresAt: number; runtimeId: string } | null = null;
  let running = false;
  let paused = false;
  let stopped = false;
  const pollTimers = new Map<string, Timer>();
  const pollInFlight = new Map<string, boolean>();
  const failures = new Map<string, number>();
  const hints = new Map<string, number>();
  const tasks = new Map<string, Entry>();
  let refreshTimer: Timer | null = null;
  let expiryTimer: Timer | null = null;
  let tokenRetryTimer: Timer | null = null;
  let tokenRequested = false;
  let tokenFailures = 0;

  function now(): number {
    return host.now ? host.now() : Date.now();
  }

  function emit(event: EngineEvent): void {
    try {
      host.emit(event);
    } catch (_err) {
      // Observers must never break the lease loop.
    }
  }

  function log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, string | number | boolean | null>,
  ): void {
    emit({ type: "log", level, message, fields: fields || {} });
  }

  function tokenValid(): boolean {
    return token !== null && token.expiresAt > now();
  }

  function post(path: string, body: unknown, keepalive?: boolean): Promise<HttpResult> {
    if (!cfg || !token) return Promise.reject(new Error("engine has no credential"));
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-api-key": token.token,
      },
      body: JSON.stringify(body),
    };
    if (keepalive) init.keepalive = true;
    let timer: Timer | null = null;
    if (typeof AbortController === "function" && !keepalive) {
      const controller = new AbortController();
      init.signal = controller.signal;
      timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
    }
    return host
      .fetch(cfg.baseUrl + path, init)
      .then((res) => {
        if (res.status === 204) return { status: 204, body: null };
        return res.text().then(
          (text) => {
            let parsed: unknown = null;
            if (text) {
              try {
                parsed = JSON.parse(text);
              } catch (_err) {
                parsed = null;
              }
            }
            return { status: res.status, body: parsed };
          },
          () => ({ status: res.status, body: null }),
        );
      })
      .then(
        (result) => {
          if (timer) clearTimeout(timer);
          return result;
        },
        (err) => {
          if (timer) clearTimeout(timer);
          throw err;
        },
      );
  }

  function ok(status: number): boolean {
    return status >= 200 && status < 300;
  }

  function taskPath(id: string, action: string): string {
    return "/workers/tasks/" + encodeURIComponent(id) + "/" + action;
  }

  // ---------------------------------------------------------------------------
  // Token lifecycle
  // ---------------------------------------------------------------------------

  function requestToken(): void {
    if (stopped || tokenRequested) return;
    tokenRequested = true;
    emit({ type: "needToken" });
  }

  function clearTokenTimers(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    if (expiryTimer) clearTimeout(expiryTimer);
    if (tokenRetryTimer) clearTimeout(tokenRetryTimer);
    refreshTimer = null;
    expiryTimer = null;
    tokenRetryTimer = null;
  }

  function onToken(command: { token: string; expiresAt: number; runtimeId: string }): void {
    if (stopped) return;
    tokenRequested = false;
    tokenFailures = 0;
    clearTokenTimers();
    token = { token: command.token, expiresAt: command.expiresAt, runtimeId: command.runtimeId };
    const remaining = token.expiresAt - now();
    if (remaining <= 0) {
      expire();
      return;
    }
    const margin = Math.min(cfg ? cfg.refreshMarginMs : 60000, remaining / 2);
    refreshTimer = setTimeout(requestToken, Math.max(0, remaining - margin));
    expiryTimer = setTimeout(expire, remaining);
    ensurePolling();
  }

  function onTokenError(message: string): void {
    if (stopped) return;
    tokenRequested = false;
    tokenFailures += 1;
    log("warn", "token refresh failed", { failures: tokenFailures, error: message.slice(0, 200) });
    const delay = Math.min(1000 * Math.pow(2, tokenFailures - 1), 30000);
    if (tokenRetryTimer) clearTimeout(tokenRetryTimer);
    tokenRetryTimer = setTimeout(() => {
      tokenRetryTimer = null;
      requestToken();
    }, delay);
  }

  function expire(): void {
    if (tokenValid()) return;
    stop("token_expired");
  }

  function onAuthError(): void {
    // The token may have been revoked or rotated; ask for a new one.
    requestToken();
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  function canPoll(): boolean {
    return running && !paused && !stopped && tokenValid();
  }

  function ensurePolling(): void {
    if (!cfg || !canPoll()) return;
    cfg.handlers.forEach((handler) => {
      if (!pollTimers.has(handler) && !pollInFlight.get(handler)) schedulePoll(handler, 0);
    });
  }

  function schedulePoll(handler: string, delay: number): void {
    const existing = pollTimers.get(handler);
    if (existing) clearTimeout(existing);
    pollTimers.delete(handler);
    if (!canPoll()) return;
    pollTimers.set(
      handler,
      setTimeout(() => {
        pollTimers.delete(handler);
        pollOnce(handler);
      }, delay),
    );
  }

  function nextDelay(handler: string): number {
    const c = cfg as EngineConfig;
    const failed = failures.get(handler) || 0;
    if (failed > 0) {
      const base = Math.min(c.pollIntervalMs * Math.pow(2, failed), c.maxBackoffMs);
      // Equal jitter: spread reconnect storms without shrinking below half.
      return Math.round(base / 2 + (Math.random() * base) / 2);
    }
    return Math.max(c.pollIntervalMs, hints.get(handler) || 0);
  }

  function capabilities(runtimeId: string): Record<string, unknown> {
    const c = cfg as EngineConfig;
    const observed = now();
    const expires = Math.min(observed + c.capabilityTtlSecs * 1000, (token as { expiresAt: number }).expiresAt);
    const caps: Record<string, unknown> = {
      runtime_id: runtimeId,
      kind: "browser",
      trust: c.trust,
      handlers: c.handlers.slice(),
      offline_capable: false,
      observed_at: new Date(observed).toISOString(),
      expires_at: new Date(expires).toISOString(),
    };
    if (c.connectivity) caps.connectivity = c.connectivity;
    return caps;
  }

  function pollOnce(handler: string): void {
    if (!canPoll() || !cfg || !token) return;
    const c = cfg;
    const slots = c.maxConcurrent - tasks.size;
    if (slots <= 0) {
      schedulePoll(handler, c.pollIntervalMs);
      return;
    }
    const workerId = token.runtimeId;
    const body: Record<string, unknown> = {
      handler_name: handler,
      worker_id: workerId,
      limit: slots,
      capabilities: capabilities(workerId),
    };
    if (c.version) body.version = c.version;
    pollInFlight.set(handler, true);
    post("/workers/tasks/poll", body)
      .then(
        (res) => {
          if (res.status === 401 || res.status === 403) {
            failures.set(handler, (failures.get(handler) || 0) + 1);
            log("warn", "poll unauthorized", { handler, status: res.status });
            onAuthError();
            return;
          }
          if (!ok(res.status)) {
            failures.set(handler, (failures.get(handler) || 0) + 1);
            log("warn", "poll failed", { handler, status: res.status });
            return;
          }
          failures.set(handler, 0);
          const payload = res.body as
            | WorkerTask[]
            | { tasks?: WorkerTask[]; lease_secs?: number; heartbeat_interval_secs?: number; poll_after_ms?: number }
            | null;
          let list: WorkerTask[] = [];
          let leaseSecs: number | null = null;
          let heartbeatSecs: number | null = null;
          if (Array.isArray(payload)) {
            list = payload;
          } else if (payload && typeof payload === "object") {
            list = Array.isArray(payload.tasks) ? payload.tasks : [];
            if (typeof payload.lease_secs === "number") leaseSecs = payload.lease_secs;
            if (typeof payload.heartbeat_interval_secs === "number") heartbeatSecs = payload.heartbeat_interval_secs;
            hints.set(handler, typeof payload.poll_after_ms === "number" ? payload.poll_after_ms : 0);
          }
          list.forEach((task) => claimed(task, workerId, leaseSecs, heartbeatSecs));
        },
        (err) => {
          failures.set(handler, (failures.get(handler) || 0) + 1);
          log("warn", "poll error", { handler, error: String(err && err.name ? err.name : "network") });
        },
      )
      .then(() => {
        pollInFlight.set(handler, false);
        if (canPoll()) schedulePoll(handler, nextDelay(handler));
      });
  }

  function claimed(task: WorkerTask, workerId: string, leaseSecs: number | null, heartbeatSecs: number | null): void {
    if (!task || typeof task.id !== "string" || tasks.has(task.id)) return;
    const c = cfg as EngineConfig;
    if (!canPoll()) {
      // Paused or stopped while the poll was in flight: hand the claim back untouched.
      releaseUnstarted(task, workerId);
      return;
    }
    const lease =
      typeof task.lease_secs === "number" && task.lease_secs > 0
        ? task.lease_secs
        : leaseSecs !== null && leaseSecs > 0
          ? leaseSecs
          : c.defaultLeaseSecs;
    let hbMs = Math.max(1000, Math.floor((lease * 1000) / 3));
    if (heartbeatSecs !== null && heartbeatSecs > 0) hbMs = Math.max(1000, Math.min(hbMs, heartbeatSecs * 1000));
    const entry: Entry = { task, workerId, hbMs, hbTimer: null, acking: false };
    tasks.set(task.id, entry);
    scheduleHeartbeat(entry);
    log("debug", "task claimed", { taskId: task.id, handler: task.handler_name, leaseSecs: lease });
    emit({ type: "task", task, workerId, leaseSecs: lease });
  }

  function releaseUnstarted(task: WorkerTask, workerId: string): void {
    if (!token) return;
    post(
      taskPath(task.id, "release"),
      { worker_id: workerId, claim_epoch: task.claim_epoch, started: false },
      true,
    ).then(
      (res) => log("debug", "unstarted claim released", { taskId: task.id, status: res.status }),
      () => log("warn", "release failed", { taskId: task.id }),
    );
  }

  // ---------------------------------------------------------------------------
  // Heartbeats
  // ---------------------------------------------------------------------------

  function scheduleHeartbeat(entry: Entry): void {
    if (entry.hbTimer) clearTimeout(entry.hbTimer);
    entry.hbTimer = setTimeout(() => {
      entry.hbTimer = null;
      heartbeat(entry.task.id, null);
    }, entry.hbMs);
  }

  function lose(id: string, reason: string): void {
    const entry = tasks.get(id);
    if (!entry) return;
    if (entry.hbTimer) clearTimeout(entry.hbTimer);
    tasks.delete(id);
    log("info", "lease lost", { taskId: id, reason });
    emit({ type: "abort", taskId: id, reason });
  }

  function heartbeat(id: string, requestId: number | null): void {
    const reply = (success: boolean, error?: string) => {
      if (requestId !== null) {
        emit({ type: "heartbeatResult", taskId: id, requestId, ok: success, error });
      }
    };
    const entry = tasks.get(id);
    if (!entry || entry.acking) {
      reply(false, entry ? "acknowledging" : "lease_lost");
      return;
    }
    if (!tokenValid()) {
      reply(false, "token_expired");
      return;
    }
    if (entry.hbTimer) clearTimeout(entry.hbTimer);
    entry.hbTimer = null;
    post(taskPath(id, "heartbeat"), { worker_id: entry.workerId, claim_epoch: entry.task.claim_epoch }).then(
      (res) => {
        if (tasks.get(id) !== entry) {
          reply(false, "lease_lost");
          return;
        }
        if (res.status === 404 || res.status === 409 || res.status === 410) {
          lose(id, "lease_lost");
          reply(false, "lease_lost");
          return;
        }
        if (!entry.acking) scheduleHeartbeat(entry);
        if (res.status === 401 || res.status === 403) {
          onAuthError();
          reply(false, "unauthorized");
          return;
        }
        if (!ok(res.status)) {
          log("warn", "heartbeat failed", { taskId: id, status: res.status });
          reply(false, "http_" + res.status);
          return;
        }
        reply(true);
      },
      () => {
        if (tasks.get(id) === entry && !entry.acking) scheduleHeartbeat(entry);
        log("warn", "heartbeat error", { taskId: id });
        reply(false, "network");
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Acknowledgement
  // ---------------------------------------------------------------------------

  function acknowledge(command: Extract<EngineCommand, { type: "result" }>): void {
    const entry = tasks.get(command.taskId);
    if (!entry || entry.acking) {
      emit({ type: "settled", taskId: command.taskId, outcome: "dropped" });
      return;
    }
    entry.acking = true;
    if (entry.hbTimer) clearTimeout(entry.hbTimer);
    entry.hbTimer = null;
    const body: Record<string, unknown> = command.ok
      ? { worker_id: entry.workerId, claim_epoch: entry.task.claim_epoch, output: command.output === undefined ? {} : command.output }
      : { worker_id: entry.workerId, claim_epoch: entry.task.claim_epoch, message: command.message, retryable: command.retryable };
    const path = taskPath(command.taskId, command.ok ? "complete" : "fail");
    const outcome = command.ok ? "completed" : "failed";
    const attempt = (n: number): void => {
      if (tasks.get(command.taskId) !== entry) return;
      if (!tokenValid()) {
        finish("error");
        return;
      }
      post(path, body).then(
        (res) => {
          if (ok(res.status)) finish(outcome, res.status);
          else if (res.status === 404 || res.status === 409 || res.status === 410) finish("lost", res.status);
          else if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
            if (res.status === 401 || res.status === 403) onAuthError();
            retry(n, res.status);
          } else finish("error", res.status);
        },
        () => retry(n),
      );
    };
    const retry = (n: number, status?: number): void => {
      if (n >= 3) {
        finish("error", status);
        return;
      }
      setTimeout(() => attempt(n + 1), 1000 * Math.pow(2, n));
    };
    const finish = (result: "completed" | "failed" | "lost" | "error", status?: number): void => {
      if (tasks.get(command.taskId) === entry) tasks.delete(command.taskId);
      log(result === "error" ? "warn" : "debug", "task settled", { taskId: command.taskId, outcome: result, status: status === undefined ? null : status });
      emit({ type: "settled", taskId: command.taskId, outcome: result, status });
    };
    attempt(0);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function clearPollTimers(): void {
    pollTimers.forEach((timer) => clearTimeout(timer));
    pollTimers.clear();
  }

  function release(taskIds: string[], pause: boolean): void {
    taskIds.forEach((id) => {
      const entry = tasks.get(id);
      if (!entry) return;
      if (entry.hbTimer) clearTimeout(entry.hbTimer);
      tasks.delete(id);
    });
    if (pause) {
      paused = true;
      clearPollTimers();
      // Claims the facade never saw were never started: give them back.
      tasks.forEach((entry, id) => {
        if (entry.acking) return;
        if (entry.hbTimer) clearTimeout(entry.hbTimer);
        tasks.delete(id);
        emit({ type: "abort", taskId: id, reason: "released" });
        releaseUnstarted(entry.task, entry.workerId);
      });
    }
  }

  function stop(reason: string): void {
    if (stopped) return;
    stopped = true;
    running = false;
    clearPollTimers();
    clearTokenTimers();
    tasks.forEach((entry, id) => {
      if (entry.hbTimer) clearTimeout(entry.hbTimer);
      emit({ type: "abort", taskId: id, reason });
    });
    tasks.clear();
    log("info", "engine stopped", { reason });
    emit({ type: "stopped", reason });
  }

  function handle(command: EngineCommand): void {
    if (!command || typeof command !== "object") return;
    switch (command.type) {
      case "start":
        if (running || stopped) return;
        cfg = command.config;
        running = true;
        paused = false;
        if (tokenValid()) ensurePolling();
        else requestToken();
        return;
      case "token":
        onToken(command);
        return;
      case "tokenError":
        onTokenError(command.message);
        return;
      case "result":
        acknowledge(command);
        return;
      case "heartbeat":
        heartbeat(command.taskId, command.requestId);
        return;
      case "release":
        release(command.taskIds, command.pause);
        return;
      case "resume":
        if (!running || stopped) return;
        paused = false;
        if (tokenValid()) ensurePolling();
        else requestToken();
        return;
      case "stop":
        stop(command.reason);
        return;
      default:
        return;
    }
  }

  return { handle };
}

/**
 * Entry point evaluated inside the dedicated Web Worker. Bridges
 * `postMessage` to the engine. Must stay self-contained (see file header).
 */
export function leaseWorkerBootstrap(
  scope: {
    postMessage(message: unknown): void;
    addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
    fetch(input: string, init: RequestInit): Promise<Response>;
  },
  engineFactory: typeof leaseEngine,
): void {
  const engine = engineFactory({
    emit: (event) => scope.postMessage(event),
    fetch: (input, init) => scope.fetch(input, init),
  });
  scope.addEventListener("message", (event) => engine.handle(event.data as EngineCommand));
  scope.postMessage({ type: "ready" });
}
