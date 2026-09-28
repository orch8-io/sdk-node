/**
 * Message protocol between the `BrowserWorker` facade (main thread, runs
 * handlers with DOM access) and the lease engine (poll/heartbeat/ack loop,
 * running in a dedicated Web Worker or on the main thread as a fallback).
 *
 * Everything here crosses `postMessage`, so it must stay structured-clone safe.
 */
import type { WorkerTask } from "../types.js";

export interface EngineConfig {
  baseUrl: string;
  handlers: string[];
  maxConcurrent: number;
  pollIntervalMs: number;
  maxBackoffMs: number;
  /** Lifetime of each poll's capability advertisement (server max 300). */
  capabilityTtlSecs: number;
  trust: "unverified" | "registered";
  connectivity?: "offline" | "metered" | "wifi" | "ethernet";
  /** Refresh the token this long before it expires. */
  refreshMarginMs: number;
  /** Lease assumed when the server does not advertise one. */
  defaultLeaseSecs: number;
  requestTimeoutMs: number;
  version?: string;
}

export type EngineCommand =
  | { type: "start"; config: EngineConfig }
  | { type: "token"; token: string; expiresAt: number; runtimeId: string }
  | { type: "tokenError"; message: string }
  | { type: "result"; taskId: string; ok: true; output: unknown }
  | { type: "result"; taskId: string; ok: false; message: string; retryable: boolean }
  | { type: "heartbeat"; taskId: string; requestId: number }
  /**
   * The facade released `taskIds` itself (keepalive fetch). The engine
   * forgets them, releases any claim the facade never saw (`started: false`)
   * and, with `pause`, stops polling until `resume`.
   */
  | { type: "release"; taskIds: string[]; pause: boolean }
  | { type: "resume" }
  | { type: "stop"; reason: string };

export type EngineTaskOutcome = "completed" | "failed" | "lost" | "dropped" | "error";

export type EngineEvent =
  | { type: "ready" }
  | { type: "needToken" }
  | { type: "task"; task: WorkerTask; workerId: string; leaseSecs: number }
  | { type: "abort"; taskId: string; reason: string }
  | { type: "heartbeatResult"; taskId: string; requestId: number; ok: boolean; error?: string }
  | { type: "settled"; taskId: string; outcome: EngineTaskOutcome; status?: number }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; fields: Record<string, string | number | boolean | null> }
  | { type: "stopped"; reason: string };

export interface EngineHost {
  emit(event: EngineEvent): void;
  fetch(input: string, init: RequestInit): Promise<Response>;
  now?(): number;
}

export interface EngineController {
  handle(command: EngineCommand): void;
}
