import type { WorkerTask } from "../types.js";
import { leaseEngine } from "./engine.js";
import { LEASE_WORKER_SOURCE } from "./lease-worker-source.js";
import type { EngineCommand, EngineConfig, EngineEvent } from "./protocol.js";
import { MAX_OUTPUT_BYTES, OutputTooLargeError, jsonByteLength } from "./page-data.js";

/** What `getToken` resolves to. Snake-case fields from the raw session response are accepted too. */
export interface BrowserToken {
  token: string;
  /** Expiry as an RFC 3339 string, a `Date`, or epoch milliseconds. */
  expiresAt: string | number | Date;
  runtimeId: string;
}

type RawToken =
  | BrowserToken
  | { token: string; expires_at: string | number; runtime_id: string; [key: string]: unknown };

export interface BrowserTaskContext {
  taskId: string;
  instanceId: string;
  blockId: string;
  handlerName: string;
  attempt: number;
  /** Deterministic idempotency key for the step's effect; pass it to downstream APIs. `null` on older servers. */
  effectId: string | null;
  /** Filtered instance context (the server never sends credentials to browser runtimes). */
  context: unknown;
  /** Aborted on lease loss, release (tab hidden/closed), timeout, or `stop()`. */
  signal: AbortSignal;
  /** Extend the lease now. Rejects with `LeaseLostError` if the lease is gone. */
  heartbeat(): Promise<void>;
}

export type BrowserHandler<I = unknown, O = unknown> = (input: I, ctx: BrowserTaskContext) => O | Promise<O>;

export type ReleaseTrigger = "pagehide" | "hidden";

export type BrowserWorkerMode = "auto" | "worker" | "main";

/** Lifecycle events. They carry ids and counts only, never task input or output. */
export type BrowserWorkerEvent =
  | { type: "started"; runtimeId: string; mode: "worker" | "main" }
  | { type: "task_started"; taskId: string; handler: string }
  | { type: "task_completed"; taskId: string }
  | { type: "task_failed"; taskId: string; retryable: boolean }
  | { type: "task_aborted"; taskId: string; reason: string }
  | { type: "ack_failed"; taskId: string; outcome: "lost" | "error" }
  | { type: "released"; taskIds: string[]; reason: string }
  | { type: "token_refreshed"; expiresAt: number }
  | { type: "error"; message: string }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; fields: Record<string, string | number | boolean | null> }
  | { type: "stopped"; reason: string };

export interface BrowserWorkerOptions {
  /** Base URL of the Orch8 engine API; must allow this origin via `ORCH8_CORS_ORIGINS`. */
  baseUrl: string;
  /**
   * Fetch a browser session token from YOUR backend, which mints it with
   * `client.createBrowserSession()`. Called on start and before expiry.
   */
  getToken: () => Promise<RawToken>;
  /** `auto` (default) runs the lease loop in a dedicated Web Worker when possible, else on the main thread. */
  mode?: BrowserWorkerMode;
  /** Page lifecycle events that release in-flight tasks and pause polling. Default: both. */
  releaseOn?: ReleaseTrigger[];
  /** Concurrent tasks. Default: 1 (browser steps usually involve the user). */
  maxConcurrent?: number;
  /** Idle poll interval (ms). Default: 1000. */
  pollIntervalMs?: number;
  /** Upper bound of the exponential poll backoff (ms). Default: 30000. */
  maxBackoffMs?: number;
  /** Maximum JSON size of a handler's output. Default: 1 MiB (the server default). */
  maxOutputBytes?: number;
  /** Refresh the token this many seconds before it expires. Default: 60. */
  refreshMarginSecs?: number;
  /** Lifetime of the capability advertisement sent with each poll, 1..300 s. Default: 240. */
  capabilityTtlSecs?: number;
  /** Lease assumed when the server does not advertise `lease_secs`. Default: 30. */
  defaultLeaseSecs?: number;
  /** Per-request timeout (ms). Default: 30000. */
  requestTimeoutMs?: number;
  /** Advertised connectivity; derived from `navigator.connection` when omitted. */
  connectivity?: "metered" | "wifi" | "ethernet";
  /** Advertised trust; the token binds the identity, so `registered` is the default. */
  trust?: "unverified" | "registered";
  /** App build version recorded in the worker registry. */
  version?: string;
  /** Lifecycle observer; receives ids only, never payloads. */
  onEvent?: (event: BrowserWorkerEvent) => void;
  /** Fetch override (main-thread engine and release requests). */
  fetch?: typeof fetch;
}

export class LeaseLostError extends Error {
  constructor(readonly reason: string) {
    super(`task lease is no longer held (${reason})`);
    this.name = "LeaseLostError";
  }
}

export class TaskReleasedError extends Error {
  constructor(readonly reason: string) {
    super(`task was released (${reason})`);
    this.name = "TaskReleasedError";
  }
}

export class TaskTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`task timed out after ${timeoutMs} ms`);
    this.name = "TaskTimeoutError";
  }
}

interface EngineLink {
  readonly mode: "worker" | "main";
  send(command: EngineCommand): void;
  close(): void;
}

interface InFlight {
  task: WorkerTask;
  workerId: string;
  controller: AbortController;
  started: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
}

type State = "idle" | "starting" | "running" | "stopped";

const WORKER_READY_TIMEOUT_MS = 3000;

function normalizeToken(raw: RawToken): { token: string; expiresAt: number; runtimeId: string } {
  const record = raw as Record<string, unknown>;
  const token = record.token;
  const runtimeId = record.runtimeId ?? record.runtime_id;
  const expires = record.expiresAt ?? record.expires_at;
  if (typeof token !== "string" || token.length === 0) throw new TypeError("getToken() returned no token");
  if (typeof runtimeId !== "string" || runtimeId.length === 0) throw new TypeError("getToken() returned no runtimeId");
  let expiresAt: number;
  if (expires instanceof Date) expiresAt = expires.getTime();
  else if (typeof expires === "number") expiresAt = expires < 1e12 ? expires * 1000 : expires;
  else if (typeof expires === "string") expiresAt = Date.parse(expires);
  else expiresAt = Number.NaN;
  if (!Number.isFinite(expiresAt)) throw new TypeError("getToken() returned an invalid expiresAt");
  return { token, expiresAt, runtimeId };
}

function detectConnectivity(): EngineConfig["connectivity"] {
  const nav = (globalThis as { navigator?: Navigator & { connection?: { type?: string; saveData?: boolean } } }).navigator;
  if (!nav) return undefined;
  if (nav.onLine === false) return "offline";
  const connection = nav.connection;
  if (connection?.type === "ethernet") return "ethernet";
  if (connection?.type === "cellular" || connection?.saveData) return "metered";
  // Browsers without the Network Information API: an online browser has a network path.
  return "wifi";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs Orch8 step handlers inside a web page. Handlers execute on the main
 * thread (they may read the DOM and ask the user), while polling,
 * heartbeating and acknowledgement run in a dedicated Web Worker whose timers
 * are throttled far less than a background tab's.
 *
 * The browser authenticates with a short-lived token minted by your backend,
 * never with an API key, and never receives secrets.
 */
export class BrowserWorker {
  private readonly handlers = new Map<string, BrowserHandler>();
  private readonly inflight = new Map<string, InFlight>();
  private readonly heartbeatWaiters = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();
  private readonly baseUrl: string;
  private readonly releaseOn: ReleaseTrigger[];
  private readonly maxOutputBytes: number;
  private link: EngineLink | null = null;
  private session: { token: string; expiresAt: number; runtimeId: string } | null = null;
  private state: State = "idle";
  private paused = false;
  private nextRequestId = 1;
  private tokenFetch: Promise<void> | null = null;
  private detach: (() => void) | null = null;

  constructor(private readonly options: BrowserWorkerOptions) {
    if (!options.baseUrl) throw new TypeError("BrowserWorker requires baseUrl");
    if (typeof options.getToken !== "function") throw new TypeError("BrowserWorker requires getToken");
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.releaseOn = options.releaseOn ?? ["pagehide", "hidden"];
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  }

  /** Register a handler. Call before `start()`; the handler list is advertised in capabilities. */
  register<I = unknown, O = unknown>(handlerName: string, handler: BrowserHandler<I, O>): this {
    if (this.state !== "idle" && this.state !== "stopped") {
      throw new Error("register() must be called before start()");
    }
    if (!handlerName) throw new TypeError("handler name is required");
    this.handlers.set(handlerName, handler as BrowserHandler);
    return this;
  }

  /** Current mode once started (`worker` or `main`), else `null`. */
  get mode(): "worker" | "main" | null {
    return this.link?.mode ?? null;
  }

  get running(): boolean {
    return this.state === "running";
  }

  /** Fetch the first token, start the lease loop and attach page lifecycle listeners. */
  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") return;
    if (this.handlers.size === 0) throw new Error("register at least one handler before start()");
    this.state = "starting";
    this.paused = false;
    try {
      this.session = normalizeToken(await this.options.getToken());
      this.link = await this.openLink(this.options.mode ?? "auto");
    } catch (err) {
      this.state = "idle";
      throw err;
    }
    this.state = "running";
    this.link.send({ type: "start", config: this.engineConfig() });
    this.link.send({ type: "token", ...this.session });
    this.attachLifecycle();
    this.notify({ type: "started", runtimeId: this.session.runtimeId, mode: this.link.mode });
  }

  /** Release in-flight tasks, stop polling and detach listeners. */
  async stop(reason = "stopped"): Promise<void> {
    if (this.state !== "running") return;
    const releasing = this.release(reason);
    this.shutdown(reason);
    await releasing;
  }

  /**
   * Give every in-flight task back to the engine (with `fetch(..., {keepalive: true})`,
   * so it survives page unload), abort the handlers' signals, and pause polling
   * until `resume()`. Called automatically on `pagehide` / `visibilitychange`.
   */
  release(reason = "manual"): Promise<void> {
    const session = this.session;
    const fetchImpl = this.fetchImpl();
    const pending: Promise<unknown>[] = [];
    const ids: string[] = [];
    for (const [id, entry] of this.inflight) {
      ids.push(id);
      if (session && fetchImpl) {
        pending.push(
          fetchImpl(`${this.baseUrl}/workers/tasks/${encodeURIComponent(id)}/release`, {
            method: "POST",
            keepalive: true,
            headers: { "Content-Type": "application/json", "x-api-key": session.token },
            body: JSON.stringify({ worker_id: entry.workerId, claim_epoch: entry.task.claim_epoch, started: entry.started }),
          }).catch(() => undefined),
        );
      }
      this.settle(id);
      entry.controller.abort(new TaskReleasedError(reason));
    }
    this.paused = true;
    this.link?.send({ type: "release", taskIds: ids, pause: true });
    if (ids.length > 0) this.notify({ type: "released", taskIds: ids, reason });
    return Promise.all(pending).then(() => undefined);
  }

  /** Resume polling after `release()` (done automatically when the page becomes visible again). */
  resume(): void {
    if (this.state !== "running" || !this.paused) return;
    this.paused = false;
    this.link?.send({ type: "resume" });
  }

  // ---------------------------------------------------------------------------

  private engineConfig(): EngineConfig {
    const o = this.options;
    const ttl = Math.min(Math.max(o.capabilityTtlSecs ?? 240, 1), 300);
    return {
      baseUrl: this.baseUrl,
      handlers: Array.from(this.handlers.keys()),
      maxConcurrent: Math.max(1, o.maxConcurrent ?? 1),
      pollIntervalMs: o.pollIntervalMs ?? 1000,
      maxBackoffMs: o.maxBackoffMs ?? 30_000,
      capabilityTtlSecs: ttl,
      trust: o.trust ?? "registered",
      connectivity: o.connectivity ?? detectConnectivity(),
      refreshMarginMs: (o.refreshMarginSecs ?? 60) * 1000,
      defaultLeaseSecs: o.defaultLeaseSecs ?? 30,
      requestTimeoutMs: o.requestTimeoutMs ?? 30_000,
      version: o.version,
    };
  }

  private fetchImpl(): typeof fetch | undefined {
    if (this.options.fetch) return this.options.fetch;
    return typeof fetch === "function" ? fetch.bind(globalThis) : undefined;
  }

  private async openLink(mode: BrowserWorkerMode): Promise<EngineLink> {
    if (mode !== "main") {
      const link = await this.openWorkerLink();
      if (link) return link;
      if (mode === "worker") throw new Error("dedicated Web Workers are unavailable (unsupported or blocked by CSP worker-src)");
    }
    return this.openMainLink();
  }

  private openMainLink(): EngineLink {
    const fetchImpl = this.fetchImpl();
    if (!fetchImpl) throw new Error("fetch is not available");
    let closed = false;
    const engine = leaseEngine({
      emit: (event) => {
        // Deliver asynchronously, like postMessage, so engine state settles first.
        void Promise.resolve().then(() => {
          if (!closed) this.onEngineEvent(event);
        });
      },
      fetch: (input, init) => fetchImpl(input, init),
    });
    return {
      mode: "main",
      send: (command) => {
        if (!closed) engine.handle(command);
      },
      close: () => {
        closed = true;
      },
    };
  }

  private openWorkerLink(): Promise<EngineLink | null> {
    const g = globalThis as { Worker?: typeof Worker; Blob?: typeof Blob; URL?: typeof URL };
    if (typeof g.Worker !== "function" || typeof g.Blob !== "function" || typeof g.URL?.createObjectURL !== "function") {
      return Promise.resolve(null);
    }
    let url: string;
    let worker: Worker;
    try {
      url = URL.createObjectURL(new Blob([LEASE_WORKER_SOURCE], { type: "text/javascript" }));
      worker = new Worker(url, { name: "orch8-lease" });
    } catch {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let ready = false;
      const cleanupUrl = () => URL.revokeObjectURL(url);
      const fail = () => {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        cleanupUrl();
        worker.terminate();
        resolve(null);
      };
      const timer = setTimeout(fail, WORKER_READY_TIMEOUT_MS);
      worker.addEventListener("error", (event) => {
        if (!ready) {
          event.preventDefault();
          fail();
          return;
        }
        // A crash after startup: release what the page holds and continue on the main thread.
        this.recoverFromWorkerCrash();
      });
      worker.addEventListener("message", (event: MessageEvent<EngineEvent>) => {
        if (!ready && event.data?.type === "ready") {
          ready = true;
          clearTimeout(timer);
          cleanupUrl();
          resolve({
            mode: "worker",
            send: (command) => worker.postMessage(command),
            close: () => worker.terminate(),
          });
          return;
        }
        if (ready && this.link?.mode === "worker") this.onEngineEvent(event.data);
      });
    });
  }

  private recoverFromWorkerCrash(): void {
    if (this.state !== "running" || this.link?.mode !== "worker") return;
    this.notify({ type: "error", message: "lease worker crashed; continuing on the main thread" });
    void this.release("engine_error");
    this.link.close();
    this.link = this.openMainLink();
    this.link.send({ type: "start", config: this.engineConfig() });
    if (this.session) this.link.send({ type: "token", ...this.session });
    this.paused = false;
    this.link.send({ type: "resume" });
  }

  private onEngineEvent(event: EngineEvent): void {
    switch (event.type) {
      case "needToken":
        this.refreshToken();
        return;
      case "task":
        this.runTask(event.task, event.workerId);
        return;
      case "abort": {
        const entry = this.inflight.get(event.taskId);
        if (entry) {
          this.settle(event.taskId);
          entry.controller.abort(new LeaseLostError(event.reason));
        }
        this.notify({ type: "task_aborted", taskId: event.taskId, reason: event.reason });
        return;
      }
      case "heartbeatResult": {
        const waiter = this.heartbeatWaiters.get(event.requestId);
        if (!waiter) return;
        this.heartbeatWaiters.delete(event.requestId);
        if (event.ok) waiter.resolve();
        else if (event.error === "lease_lost") waiter.reject(new LeaseLostError("lease_lost"));
        else waiter.reject(new Error(`heartbeat failed: ${event.error ?? "unknown"}`));
        return;
      }
      case "settled":
        if (event.outcome === "lost" || event.outcome === "error") {
          this.notify({ type: "ack_failed", taskId: event.taskId, outcome: event.outcome });
        }
        return;
      case "log":
        this.notify(event);
        return;
      case "stopped":
        this.shutdown(event.reason);
        return;
      default:
        return;
    }
  }

  private refreshToken(): void {
    if (this.tokenFetch || this.state !== "running") return;
    this.tokenFetch = Promise.resolve()
      .then(() => this.options.getToken())
      .then(
        (raw) => {
          const next = normalizeToken(raw);
          this.session = next;
          this.link?.send({ type: "token", ...next });
          this.notify({ type: "token_refreshed", expiresAt: next.expiresAt });
        },
        (err: unknown) => {
          const message = errorMessage(err);
          this.link?.send({ type: "tokenError", message });
          this.notify({ type: "error", message: `token refresh failed: ${message}` });
        },
      )
      .finally(() => {
        this.tokenFetch = null;
      });
  }

  private runTask(task: WorkerTask, workerId: string): void {
    const handler = this.handlers.get(task.handler_name);
    if (!handler) {
      this.link?.send({ type: "result", taskId: task.id, ok: false, message: `no handler registered for "${task.handler_name}"`, retryable: false });
      return;
    }
    const controller = new AbortController();
    const entry: InFlight = { task, workerId, controller, started: false, timeout: null };
    this.inflight.set(task.id, entry);
    if (task.timeout_ms && task.timeout_ms > 0) {
      const timeoutMs = task.timeout_ms;
      entry.timeout = setTimeout(() => {
        if (this.inflight.get(task.id) !== entry) return;
        this.settle(task.id);
        controller.abort(new TaskTimeoutError(timeoutMs));
        this.link?.send({ type: "result", taskId: task.id, ok: false, message: "task timed out", retryable: true });
        this.notify({ type: "task_failed", taskId: task.id, retryable: true });
      }, timeoutMs);
    }
    const ctx: BrowserTaskContext = {
      taskId: task.id,
      instanceId: task.instance_id,
      blockId: task.block_id,
      handlerName: task.handler_name,
      attempt: task.attempt,
      effectId: task.effect_id ?? null,
      context: task.context,
      signal: controller.signal,
      heartbeat: () => this.heartbeat(task.id),
    };
    entry.started = true;
    this.notify({ type: "task_started", taskId: task.id, handler: task.handler_name });
    Promise.resolve()
      .then(() => handler(task.params, ctx))
      .then(
        (output) => {
          if (this.inflight.get(task.id) !== entry) return;
          this.settle(task.id);
          let bytes: number;
          try {
            bytes = jsonByteLength(output);
          } catch (err) {
            this.fail(task.id, `step output is not JSON-serializable: ${errorMessage(err)}`, false);
            return;
          }
          if (bytes > this.maxOutputBytes) {
            this.fail(task.id, new OutputTooLargeError(bytes, this.maxOutputBytes).message, false);
            return;
          }
          this.link?.send({ type: "result", taskId: task.id, ok: true, output: output === undefined ? {} : output });
          this.notify({ type: "task_completed", taskId: task.id });
        },
        (err: unknown) => {
          if (this.inflight.get(task.id) !== entry) return;
          this.settle(task.id);
          const retryable = err instanceof Error && "retryable" in err ? Boolean((err as { retryable: unknown }).retryable) : true;
          this.fail(task.id, errorMessage(err), retryable);
        },
      );
  }

  private fail(taskId: string, message: string, retryable: boolean): void {
    this.link?.send({ type: "result", taskId, ok: false, message, retryable });
    this.notify({ type: "task_failed", taskId, retryable });
  }

  private settle(taskId: string): void {
    const entry = this.inflight.get(taskId);
    if (!entry) return;
    if (entry.timeout) clearTimeout(entry.timeout);
    this.inflight.delete(taskId);
  }

  private heartbeat(taskId: string): Promise<void> {
    if (!this.inflight.has(taskId) || !this.link) return Promise.reject(new LeaseLostError("lease_lost"));
    const requestId = this.nextRequestId++;
    return new Promise<void>((resolve, reject) => {
      this.heartbeatWaiters.set(requestId, { resolve, reject });
      this.link?.send({ type: "heartbeat", taskId, requestId });
    });
  }

  private shutdown(reason: string): void {
    if (this.state === "stopped" || this.state === "idle") return;
    this.state = "stopped";
    for (const [id, entry] of this.inflight) {
      this.settle(id);
      entry.controller.abort(new TaskReleasedError(reason));
    }
    for (const waiter of this.heartbeatWaiters.values()) waiter.reject(new LeaseLostError(reason));
    this.heartbeatWaiters.clear();
    this.link?.send({ type: "stop", reason });
    this.link?.close();
    this.link = null;
    this.detach?.();
    this.detach = null;
    this.notify({ type: "stopped", reason });
  }

  private attachLifecycle(): void {
    const w = globalThis as { addEventListener?: typeof addEventListener; removeEventListener?: typeof removeEventListener };
    const doc = (globalThis as { document?: Document }).document;
    if (typeof w.addEventListener !== "function") return;
    const listeners: Array<[EventTarget, string, EventListener]> = [];
    const on = (target: EventTarget, type: string, listener: EventListener) => {
      target.addEventListener(type, listener);
      listeners.push([target, type, listener]);
    };
    const target = globalThis as unknown as EventTarget;
    if (this.releaseOn.includes("pagehide")) {
      on(target, "pagehide", () => void this.release("pagehide"));
      // Restored from the back/forward cache.
      on(target, "pageshow", (event) => {
        if ((event as PageTransitionEvent).persisted) this.resume();
      });
    }
    if (this.releaseOn.includes("hidden") && doc) {
      on(doc, "visibilitychange", () => {
        if (doc.visibilityState === "hidden") void this.release("hidden");
        else if (doc.visibilityState === "visible") this.resume();
      });
    }
    this.detach = () => {
      for (const [t, type, listener] of listeners) t.removeEventListener(type, listener);
    };
  }

  private notify(event: BrowserWorkerEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // Observers must not affect task semantics.
    }
  }
}
