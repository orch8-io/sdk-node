# Browser executor: run steps in the user's tab

Some steps belong in the browser: a human confirms or edits data, the step
reads the page the user is on, or it uses data the page already fetched. The
browser executor (`BrowserWorker` from `@orch8.io/sdk/browser`) turns an open
tab into a short-lived Orch8 runtime that claims those steps, and only those.

This guide is the end-to-end path. The API reference is the
[Browser worker section of the README](../README.md#browser-worker-orch8iosdkbrowser);
a runnable example is in [`examples/browser-worker/`](../examples/browser-worker/).

## The three pieces

| Where | What | Code |
|---|---|---|
| Your backend | Mints a browser session token with its operator key. The key never reaches the page. | `client.createBrowserSession({ runtimeId, handlers, ttlSecs })` |
| Your page | Registers handlers, then polls for its steps with that token. | `new BrowserWorker({ baseUrl, getToken }).register(...).start()` |
| Your workflow | Places the step on a browser runtime. | step option `runtime: { runtime_kinds: ["browser"] }` or `runtime_id: "browser-<user>"` |

Also add the page's origin to the engine's `ORCH8_CORS_ORIGINS`.

## Targeting: any tab or this user's tab

- `runtime: { runtime_kinds: ["browser"], requires_human_ui: true }` — any
  connected browser session whose handler allowlist includes the handler.
- `runtime: { runtime_id: "browser-u1" }` — only the session minted with
  `runtimeId: "browser-u1"`. A stable per-user id makes the step wait in that
  user's "mailbox" until they open the app, even across reloads and devices.

## Lifecycle guarantees

| Situation | What happens |
|---|---|
| Tab open and visible | Polls every handler with `capabilities { kind: "browser", runtime_id, handlers }`, heartbeats every `lease_secs / 3`, completes or fails echoing `claim_epoch`. |
| Tab hidden (`visibilitychange`) or closed/navigated (`pagehide`) | In-flight tasks are released at once with a `keepalive` fetch (`started: true`), `ctx.signal` aborts with `TaskReleasedError`, and polling pauses until the page is visible again. Use `releaseOn: ["pagehide"]` to keep long interactive steps while the tab is in the background. |
| Lease lost (heartbeat 404/409) | `ctx.signal` aborts with `LeaseLostError`; the result is never acknowledged. |
| Token about to expire | `getToken` is called again `refreshMarginSecs` (60 s) before expiry and on any 401/403; if it lapses, the worker stops with `reason: "token_expired"`. |
| Background throttling | The lease loop runs in a dedicated Web Worker; without Worker support (or under a strict CSP) it falls back to the main thread. |

Released steps return to `pending` and are dispatched again (to another tab
of the same runtime id, or any browser runtime), so make handlers idempotent
and use `ctx.effectId` as the idempotency key for any external call.

## Security model

- The page holds only a browser session token: scoped to `kind=browser`, one
  runtime id and a handler allowlist, valid on the worker task endpoints only,
  900 s by default (3600 s max).
- The engine never dispatches credential-bearing steps to browser runtimes and
  filters the instance context it sends them.
- Output is page data (DOM, form values, user input) capped at 1 MiB of JSON;
  treat it as untrusted input in later steps. `readForm` never reads password
  or file inputs.

## Checklist

1. Backend route that authenticates the user and returns
   `createBrowserSession({ runtimeId: \`browser-${user.id}\`, handlers: [...] })`.
2. `ORCH8_CORS_ORIGINS` includes the page origin.
3. Page registers every handler named in the session allowlist before `start()`.
4. Workflow step has a `runtime` placement and a `timeout` long enough for a human.
5. Handlers honour `ctx.signal` and return idempotent results.
