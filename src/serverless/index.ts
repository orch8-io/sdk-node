/**
 * `@orch8.io/sdk/serverless` — run step handlers in functions that live for
 * one invocation (AWS Lambda, Cloudflare Workers, cron jobs). Each invocation
 * drains a bounded batch of worker tasks inside its time budget and releases
 * any lease it cannot finish, using the regular worker lease API.
 *
 * Edge-safe: nothing in this module graph imports Node built-ins, so the
 * Cloudflare adapter runs without `nodejs_compat`. `Orch8Client` is re-exported
 * so edge code never has to import the root entry (which carries Node-only
 * helpers such as webhook verification).
 */
export { Orch8Client, Orch8Error } from "../client.js";
export {
  drainOnce,
  serverlessWorkerId,
  type DrainOptions,
  type DrainResult,
  type DrainStopReason,
  type DrainTaskOutcome,
  type DrainTaskResult,
  type LeaseClient,
  type ServerlessHandler,
  type ServerlessTaskContext,
} from "./drain.js";
export { createLambdaExecutor, type LambdaContextLike, type LambdaExecutorOptions } from "./lambda.js";
export {
  createCloudflareExecutor,
  type CloudflareExecutionContext,
  type CloudflareExecutor,
  type CloudflareExecutorOptions,
  type CloudflareScheduledController,
} from "./cloudflare.js";
export type { WorkerCapabilities } from "../worker.js";
export type { WorkerTask, RuntimeKind } from "../types.js";
