# Changelog

## Unreleased

### Added

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
