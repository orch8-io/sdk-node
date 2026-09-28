/**
 * `@orch8.io/sdk/browser` — browser-safe entry point.
 *
 * Nothing in this module graph imports Node built-ins; `npm run check:browser`
 * bundles it with esbuild for `platform: "browser"` and fails on any `node:`
 * reference. Keep server-only code (API-key clients, webhook verification)
 * out of this entry.
 */
export {
  BrowserWorker,
  LeaseLostError,
  TaskReleasedError,
  TaskTimeoutError,
  type BrowserHandler,
  type BrowserTaskContext,
  type BrowserToken,
  type BrowserWorkerEvent,
  type BrowserWorkerMode,
  type BrowserWorkerOptions,
  type ReleaseTrigger,
} from "./worker.js";
export {
  MAX_OUTPUT_BYTES,
  OutputTooLargeError,
  assertOutputSize,
  jsonByteLength,
  readForm,
  readSelection,
  querySelectorText,
  querySelectorAllText,
  type FormValues,
  type ReadFormOptions,
} from "./page-data.js";
/** @internal Source of the dedicated lease worker; exported for the bundle self-test. */
export { LEASE_WORKER_SOURCE as __leaseWorkerSource } from "./lease-worker-source.js";
export type {
  WorkerTask,
  RuntimeKind,
  RuntimePlacement,
  RuntimeCapabilities,
  RuntimeTrustLevel,
  RuntimeConnectivity,
  BrowserSession,
} from "../types.js";
