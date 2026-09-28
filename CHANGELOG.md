# Changelog

## Unreleased

### Added

- `Orch8Worker` `capabilities` option: advertises `RuntimeCapabilities` (kind,
  trust, hardware, regions, plugins, ...) with every poll, bound to the worker
  id with a fresh five-minute window, so the worker can claim tasks that carry
  `$runtime` placement requirements.
- Worker handlers receive a second argument, `WorkerTaskContext`
  (`effectId`, `leaseSecs`, `continuityEpoch`, `workerId`); also exported as
  `workerTaskContext(task, workerId)`. The push task runner passes it too.
- `Orch8Worker` releases tasks it claimed but will not start (batch arrived
  after `stop()`, or beyond free capacity) with `started: false`; previously
  over-capacity claims were dropped until their lease expired. Heartbeats run
  at half of the shortest in-flight task `lease_secs`.
- `@orch8.io/sdk/browser`: a browser-safe entry point (no Node built-ins in its
  module graph; exported with a `browser` condition). CI bundles it with esbuild
  for `platform: "browser"` and fails on any `node:` reference.
- `BrowserWorker`: runs step handlers in a web page with a short-lived,
  browser-scoped session token. Polls with `kind: "browser"` capabilities,
  heartbeats per `lease_secs`, completes/fails with `claim_epoch`, releases
  in-flight tasks with keepalive fetch on `pagehide` / hidden tabs, refreshes
  the token before expiry and stops when it lapses, and backs off exponentially.
  The lease loop runs in a dedicated Web Worker (main-thread fallback) while
  handlers run on the main thread; `ctx` exposes `effectId`, an `AbortSignal`
  and `heartbeat()`.
- Page-data helpers: `readForm`, `readSelection`, `querySelectorText`,
  `querySelectorAllText`, and a 1 MiB output guard (`assertOutputSize`,
  `OutputTooLargeError`).
- `Orch8Client.createBrowserSession()` for the customer backend
  (`POST /runtimes/browser-sessions`) and `Orch8Client.releaseTask()`
  (`POST /workers/tasks/{id}/release`).
- Builder `runtime` step option (emitted as `params.$runtime`) and
  `withPlacement()`; `RuntimePlacement`, `RuntimeCapabilities`, `RuntimeKind`
  types; optional `effect_id`, `continuity_epoch`, `lease_secs`,
  `target_runtime_id` and `runtime_kinds` on `WorkerTask`.

### Changed

- `Orch8Worker` timer fields use `ReturnType<typeof setTimeout>` instead of
  `NodeJS.Timeout`.

### Fixed

- `BrowserWorker` no longer runs a handler whose task was released (tab
  hidden/closed, `stop()`) before the handler was invoked, and reports such a
  release with `started: false`, so the engine returns the task to `pending`
  immediately instead of treating it as a possibly-started effect.
- `BrowserWorker` turns a `413` from `complete` (output over the engine's
  `ORCH8_BROWSER_OUTPUT_MAX_BYTES`) into a non-retryable `fail` instead of
  holding the claim until the lease expires.
- `npm run test:e2e:browser`: end-to-end suite for `BrowserWorker` against a
  real engine (`ORCH8_E2E_URL`, `ORCH8_E2E_ADMIN_KEY`).
