import type { WorkerTask } from "../types.js";

/** Lease facts for the task being handled (all `null` against older servers). */
export interface WorkerTaskContext {
  /**
   * Deterministic idempotency key of the step's effect receipt. Send it to
   * downstream APIs (for example as `Idempotency-Key`) so a retry cannot
   * duplicate the side effect.
   */
  effectId: string | null;
  /** Lease the server expects between heartbeats, in seconds. */
  leaseSecs: number | null;
  /** Continuity owner epoch at dispatch. */
  continuityEpoch: number | null;
  /** This worker's id (the lease `worker_id`). */
  workerId: string;
}

/** Build the handler context for a claimed task. */
export function workerTaskContext(task: WorkerTask, workerId: string): WorkerTaskContext {
  return {
    effectId: typeof task.effect_id === "string" ? task.effect_id : null,
    leaseSecs: typeof task.lease_secs === "number" ? task.lease_secs : null,
    continuityEpoch: typeof task.continuity_epoch === "number" ? task.continuity_epoch : null,
    workerId,
  };
}
