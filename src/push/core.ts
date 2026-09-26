import type { Orch8Client } from "../client.js";
import type { WorkerTask } from "../types.js";
import type { HandlerFn } from "../worker.js";
import { subtle, toHex } from "../internal/webcrypto.js";

/**
 * Body the engine POSTs to a push-mode queue's `push_url` (see
 * `orch8-engine/src/push.rs`). The task is still `pending` in the engine: the
 * envelope is a wake-up, not a lease, so it carries no `claim_epoch`.
 */
export interface PushEnvelope {
  task_id: string;
  instance_id: string;
  block_id: string;
  handler_name: string;
  queue_name: string | null;
  params: unknown;
  context: unknown;
  attempt: number;
  timeout_ms: number | null;
}

export type HeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>
  | Iterable<[string, string]>;

export interface PushHandlerOptions {
  /** Handler map, keyed by the step's `handler` name. */
  handlers: Record<string, HandlerFn>;
  /**
   * Engine client used to claim and acknowledge the task. Its credentials must
   * be allowed to poll and complete worker tasks for the tenant.
   */
  client: Orch8Client;
  /** Queue dispatch `secret`. Required unless `allowUnsigned` is set. */
  secret?: string;
  /** Accept unsigned envelopes (queue configured without a secret). Not recommended. */
  allowUnsigned?: boolean;
  /** Maximum clock skew for `X-Orch8-Timestamp`, in seconds. Default: 300. */
  toleranceSeconds?: number;
  /** Worker id reported to the engine. Default: `push-<random>`. */
  workerId?: string;
  /** Tasks claimed per push delivery. Default: 1. */
  claimLimit?: number;
  /** Clock override (ms since epoch) for tests. */
  now?: () => number;
}

export interface PushRequest {
  method?: string;
  headers: HeaderSource;
  /** Raw, unparsed request body — required for signature verification. */
  body: string | Uint8Array | ArrayBuffer;
}

export interface PushTaskResult {
  task_id: string;
  handler_name: string;
  outcome: "completed" | "failed" | "ack_rejected";
  error?: string;
}

export interface PushResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export const SIGNATURE_HEADER = "x-orch8-signature";
export const TIMESTAMP_HEADER = "x-orch8-timestamp";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBytes(body: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(body);
}

/** Case-insensitive single-value header lookup over the common header shapes. */
export function readHeader(headers: HeaderSource | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(wanted) ?? undefined;
  }
  if (Symbol.iterator in (headers as object) && !isPlainRecord(headers)) {
    for (const [k, v] of headers as Iterable<[string, string]>) {
      if (k.toLowerCase() === wanted) return v;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() === wanted) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function isPlainRecord(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Constant-time comparison of two ASCII strings. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Hex HMAC-SHA256 over `"{timestamp}.{body}"`, the engine's signing scheme. */
export async function signPushPayload(
  secret: string,
  timestamp: string | number,
  body: string | Uint8Array | ArrayBuffer,
): Promise<string> {
  const s = await subtle();
  const key = await s.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = encoder.encode(`${timestamp}.`);
  const payload = toBytes(body);
  const message = new Uint8Array(prefix.length + payload.length);
  message.set(prefix, 0);
  message.set(payload, prefix.length);
  return toHex(await s.sign("HMAC", key, message));
}

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "bad_timestamp" | "stale_timestamp" | "bad_signature" };

/**
 * Verify `X-Orch8-Signature: sha256=<hex>` and `X-Orch8-Timestamp` exactly as
 * the engine produces them (HMAC-SHA256(secret, "{ts}.{raw body}")). The
 * comparison is constant time and the timestamp must be within the tolerance.
 */
export async function verifyPushSignature(
  body: string | Uint8Array | ArrayBuffer,
  headers: HeaderSource,
  secret: string,
  options: { toleranceSeconds?: number; now?: () => number } = {},
): Promise<SignatureCheck> {
  const signature = readHeader(headers, SIGNATURE_HEADER);
  const timestamp = readHeader(headers, TIMESTAMP_HEADER);
  if (!signature || !timestamp) return { ok: false, reason: "missing_headers" };
  if (!/^-?\d{1,15}$/.test(timestamp.trim())) return { ok: false, reason: "bad_timestamp" };
  const ts = Number(timestamp.trim());
  const nowSecs = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (Math.abs(nowSecs - ts) > (options.toleranceSeconds ?? 300)) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const provided = signature.trim().replace(/^sha256=/i, "").toLowerCase();
  const expected = await signPushPayload(secret, timestamp.trim(), body);
  return timingSafeEqualString(provided, expected) ? { ok: true } : { ok: false, reason: "bad_signature" };
}

function reply(status: number, payload: unknown): PushResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function parseEnvelope(raw: string): PushEnvelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const env = value as Partial<PushEnvelope>;
  if (typeof env.task_id !== "string" || typeof env.handler_name !== "string") return undefined;
  return env as PushEnvelope;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | null): Promise<T> {
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

/**
 * Run one claimed task and acknowledge it with the task's `claim_epoch`,
 * following the same rules as `Orch8Worker`: handler errors become `fail`
 * (retryable only when the error says so); a rejected acknowledgement is
 * reported, never converted into a contradictory failure.
 */
export async function runClaimedTask(
  client: Orch8Client,
  workerId: string,
  handlers: Record<string, HandlerFn>,
  task: WorkerTask,
): Promise<PushTaskResult> {
  const base = { task_id: task.id, handler_name: task.handler_name };
  const handler = handlers[task.handler_name];
  let output: unknown;
  try {
    if (!handler) throw new Error(`no handler registered for "${task.handler_name}"`);
    output = await withTimeout(handler(task), task.timeout_ms);
  } catch (err) {
    const message = errorMessage(err);
    const retryable = handler !== undefined && err instanceof Error && "retryable" in err
      ? Boolean((err as { retryable?: unknown }).retryable)
      : false;
    try {
      await client.failTask(task.id, {
        worker_id: workerId,
        claim_epoch: task.claim_epoch,
        message,
        retryable,
      });
      return { ...base, outcome: "failed", error: message };
    } catch (ackErr) {
      return { ...base, outcome: "ack_rejected", error: errorMessage(ackErr) };
    }
  }
  try {
    await client.completeTask(task.id, {
      worker_id: workerId,
      claim_epoch: task.claim_epoch,
      output: output ?? {},
    });
    return { ...base, outcome: "completed" };
  } catch (ackErr) {
    return { ...base, outcome: "ack_rejected", error: errorMessage(ackErr) };
  }
}

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().slice(0, 8);
  return Math.random().toString(16).slice(2, 10);
}

/**
 * Framework-neutral push receiver. Adapters translate their request type into
 * a {@link PushRequest} and the returned {@link PushResponse} back out.
 *
 * Flow: verify signature → parse envelope → claim from the envelope's queue
 * (`POST /workers/tasks/poll/queue`) → run handler → complete/fail with the
 * claim epoch. The claimed task can differ from `task_id` when several tasks
 * are pending on the queue; each push still drains at least one task.
 *
 * Status codes: 2xx = delivery handled (including handler failures, which are
 * reported to the engine via `fail`); 401 bad signature; 400 malformed
 * envelope; 404 unregistered handler; 502 the claim poll failed, so the engine
 * retries the push.
 */
export function createPushHandler(options: PushHandlerOptions): (req: PushRequest) => Promise<PushResponse> {
  if (!options.secret && !options.allowUnsigned) {
    throw new TypeError("push handler requires `secret` (or explicitly set allowUnsigned: true)");
  }
  if (!options.client) throw new TypeError("push handler requires an Orch8Client to claim tasks");
  const workerId = options.workerId ?? `push-${randomId()}`;
  const limit = Math.max(1, options.claimLimit ?? 1);

  return async (req) => {
    if (req.method && req.method.toUpperCase() !== "POST") {
      return { ...reply(405, { error: "method_not_allowed" }), headers: { "content-type": "application/json", allow: "POST" } };
    }
    if (options.secret) {
      const check = await verifyPushSignature(req.body, req.headers, options.secret, {
        toleranceSeconds: options.toleranceSeconds,
        now: options.now,
      });
      if (!check.ok) return reply(401, { error: "invalid_signature", reason: check.reason });
    }
    const raw = typeof req.body === "string" ? req.body : decoder.decode(toBytes(req.body));
    const envelope = parseEnvelope(raw);
    if (!envelope) return reply(400, { error: "invalid_envelope" });
    if (!options.handlers[envelope.handler_name]) {
      return reply(404, { error: "unknown_handler", handler_name: envelope.handler_name });
    }

    let tasks: WorkerTask[];
    try {
      const body = { handler_name: envelope.handler_name, worker_id: workerId, limit };
      const batch = envelope.queue_name
        ? await options.client.pollTaskBatchFromQueue({ ...body, queue_name: envelope.queue_name })
        : await options.client.pollTaskBatch(body);
      tasks = batch.tasks;
    } catch (err) {
      return reply(502, { error: "claim_failed", message: errorMessage(err) });
    }

    const results = await Promise.all(
      tasks.map((task) => runClaimedTask(options.client, workerId, options.handlers, task)),
    );
    return reply(200, { claimed: tasks.length, results });
  };
}
