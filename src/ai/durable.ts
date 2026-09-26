import type { Orch8Client } from "../client.js";
import type { EnqueueJobOptions, JobRetryPolicy, JobStatus, WaitForJobOptions } from "../jobs.js";
import type { WorkerTask } from "../types.js";
import { sha256Hex, stableStringify } from "../internal/webcrypto.js";

/** Payload of the job created for one durable tool call (`task.params` on the worker). */
export interface DurableToolCallPayload<Args = unknown> {
  tool: string;
  tool_call_id: string;
  args: Args;
}

export interface DurableToolOptions {
  client: Orch8Client;
  /**
   * Idempotency scope, typically the conversation, run, or Orch8 instance id.
   * The job key is `${scope}:${tool}:${callId}`, so a replayed turn with the
   * same call id returns the recorded result instead of re-running the tool.
   */
  scope?: string;
  /** Worker handler name for a tool. Default: `ai-tool.<toolName>`. */
  handlerName?: (toolName: string) => string;
  queue?: string;
  retry?: JobRetryPolicy;
  /** Wait settings for the job result. Default timeout: 5 minutes. */
  wait?: WaitForJobOptions;
}

export const defaultToolHandlerName = (toolName: string): string => `ai-tool.${toolName}`;

/** Thrown into the agent loop when a durable tool call ends without output. */
export class DurableToolError extends Error {
  constructor(
    readonly toolName: string,
    readonly toolCallId: string,
    readonly jobId: string,
    readonly status: JobStatus,
    readonly detail: unknown,
  ) {
    super(`tool ${toolName} (call ${toolCallId}) ended ${status}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
    this.name = "DurableToolError";
  }
}

/**
 * Derive the call id used for idempotency. Frameworks supply one per tool
 * call; when absent, fall back to a content hash of tool name + arguments so
 * identical replays still dedupe.
 */
export async function resolveCallId(toolName: string, args: unknown, callId: string | undefined): Promise<string> {
  if (callId) return callId;
  return `sha256-${(await sha256Hex(`${toolName}\n${stableStringify(args)}`)).slice(0, 32)}`;
}

export function idempotencyKey(scope: string | undefined, toolName: string, callId: string): string {
  return `${scope ?? "ai"}:${toolName}:${callId}`;
}

/** Enqueue one tool call as an idempotent Orch8 job and wait for its output. */
export async function runToolCallAsJob(
  options: DurableToolOptions,
  toolName: string,
  callId: string | undefined,
  args: unknown,
): Promise<unknown> {
  const id = await resolveCallId(toolName, args, callId);
  const enqueue: EnqueueJobOptions = { idempotencyKey: idempotencyKey(options.scope, toolName, id) };
  if (options.queue) enqueue.queue = options.queue;
  if (options.retry) enqueue.retry = options.retry;
  const payload: DurableToolCallPayload = { tool: toolName, tool_call_id: id, args };
  const handler = (options.handlerName ?? defaultToolHandlerName)(toolName);
  const job = await options.client.jobs.enqueue(handler, payload, enqueue);
  const done = await options.client.jobs.waitFor(job.id, options.wait);
  if (done.status === "completed") return done.output;
  throw new DurableToolError(toolName, id, job.id, done.status, done.error);
}

/** Read the durable tool-call payload from a worker task. */
export function toolCallFromTask<Args = unknown>(task: WorkerTask): DurableToolCallPayload<Args> {
  const params = task.params as Partial<DurableToolCallPayload<Args>> | null;
  if (!params || typeof params.tool !== "string" || typeof params.tool_call_id !== "string") {
    throw Object.assign(new Error("task params are not a durable tool call"), { retryable: false });
  }
  return params as DurableToolCallPayload<Args>;
}

export interface TurnCheckpointerOptions {
  client: Orch8Client;
  /** The task currently executing the agent turn(s). */
  task: WorkerTask;
  /** The worker id that claimed `task`. */
  workerId: string;
}

/**
 * Turn-boundary checkpoints for an agent loop running inside a worker task.
 * `checkpoint(state)` stores state via the heartbeat checkpoint API (compare-
 * and-swap on `checkpoint_seq`, max 256 KiB); after a crash or lease loss the
 * retried task exposes it through `resume()`.
 */
export class TurnCheckpointer<State = unknown> {
  private seq: number;
  private last: { state: State } | undefined;
  private readonly client: Orch8Client;
  private readonly task: WorkerTask;
  private readonly workerId: string;

  constructor(options: TurnCheckpointerOptions) {
    this.client = options.client;
    this.task = options.task;
    this.workerId = options.workerId;
    this.seq = options.task.checkpoint_seq ?? 0;
  }

  /** State from the last checkpoint of a previous attempt, if any. */
  resume(): State | undefined {
    return (this.task.resume_checkpoint ?? undefined) as State | undefined;
  }

  /** The most recent state checkpointed by this attempt, else {@link resume}. */
  latest(): State | undefined {
    return this.last ? this.last.state : this.resume();
  }

  async checkpoint(state: State): Promise<void> {
    const res = await this.client.heartbeatTask(this.task.id, {
      worker_id: this.workerId,
      claim_epoch: this.task.claim_epoch,
      checkpoint: state,
      checkpoint_seq: this.seq,
    });
    this.seq = res.checkpoint_seq;
    this.last = { state };
  }
}
