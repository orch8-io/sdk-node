import { drainOnce, serverlessWorkerId, type DrainOptions, type DrainResult } from "./drain.js";

/** The part of the AWS Lambda context object the executor needs. */
export interface LambdaContextLike {
  getRemainingTimeInMillis(): number;
  awsRequestId?: string;
  functionName?: string;
}

export interface LambdaExecutorOptions extends Omit<DrainOptions, "deadlineMs"> {
  /**
   * Time kept free before Lambda's own timeout, on top of `releaseMarginMs`
   * (response serialisation, cold-start jitter, clock skew). Default: 3000 ms.
   */
  safetyMarginMs?: number;
}

/**
 * AWS Lambda executor. Wire it to an EventBridge schedule (or any trigger —
 * the event is ignored): each invocation claims up to `maxTasks` tasks for
 * the configured handlers, runs them inside
 * `context.getRemainingTimeInMillis() - safetyMarginMs`, heartbeats, and
 * releases whatever is still running before the function times out.
 *
 * ```ts
 * export const handler = createLambdaExecutor({
 *   client: new Orch8Client({ baseUrl: process.env.ORCH8_URL!, headers: { "x-api-key": process.env.ORCH8_API_KEY! } }),
 *   handlers: { "resize-image": async (task, ctx) => resize(task.params, { signal: ctx.signal }) },
 *   maxTasks: 5,
 * });
 * ```
 *
 * `options` may be a factory; it is called once per container, on the first
 * invocation. The worker id is stable per container (`lambda-<random>`)
 * unless `workerId` is set.
 */
export function createLambdaExecutor(
  options: LambdaExecutorOptions | (() => LambdaExecutorOptions),
): (event: unknown, context: LambdaContextLike) => Promise<DrainResult> {
  let resolved: LambdaExecutorOptions | undefined;
  let workerId: string | undefined;
  return async (_event, context) => {
    resolved ??= typeof options === "function" ? options() : options;
    workerId ??= resolved.workerId ?? serverlessWorkerId("lambda");
    if (!context || typeof context.getRemainingTimeInMillis !== "function") {
      throw new TypeError("createLambdaExecutor needs the Lambda context (getRemainingTimeInMillis)");
    }
    const { safetyMarginMs = 3_000, ...drain } = resolved;
    const now = drain.now ?? Date.now;
    const deadlineMs = now() + context.getRemainingTimeInMillis() - Math.max(0, safetyMarginMs);
    return drainOnce({ ...drain, workerId, deadlineMs });
  };
}
