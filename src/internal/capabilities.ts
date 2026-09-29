import type { RuntimeCapabilities, RuntimeKind } from "../types.js";
import type { WorkerCapabilities } from "../worker.js";

/** Server maximum lifetime of a capability advertisement, in seconds. */
export const MAX_CAPABILITY_TTL_SECS = 300;

/**
 * Fresh capability advertisement for one poll: bound to `runtimeId` (the
 * poll's `worker_id`), `handlers` defaulting to the registered handler names,
 * and an observation window of at most five minutes starting now.
 */
export function buildAdvertisement(
  caps: WorkerCapabilities,
  runtimeId: string,
  handlerNames: string[],
  nowMs: number,
  defaultKind: RuntimeKind = "server",
): RuntimeCapabilities {
  const { ttlSecs, kind, trust, handlers, ...facts } = caps;
  const ttl = Math.min(Math.max(ttlSecs ?? MAX_CAPABILITY_TTL_SECS, 1), MAX_CAPABILITY_TTL_SECS);
  return {
    ...facts,
    runtime_id: runtimeId,
    kind: kind ?? defaultKind,
    trust: trust ?? "registered",
    handlers: handlers ?? handlerNames,
    observed_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + ttl * 1000).toISOString(),
  };
}
