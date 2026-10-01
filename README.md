# @orch8.io/sdk

Node.js SDK for the [Orch8](https://orch8.io) workflow engine.

## Installation

```bash
npm install @orch8.io/sdk
```

Requires Node.js 18+.

SDK version 0.7.x targets the Orch8 engine 0.7.x API (`ORCH8_API_VERSION`
`1.0.0`) and sequence schema version 1, including sagas,
conditional steps, filtered retries, output schemas, local-time delays, and
bounded loop history. Portable continuity APIs are available under
`client.continuity`.

## Quick Start

```typescript
import { Orch8Client } from "@orch8.io/sdk";

const client = new Orch8Client({
  baseUrl: "https://api.orch8.io",
  tenantId: "my-tenant",
});

const seq = await client.createSequence({
  name: "my-sequence",
  namespace: "default",
  blocks: [],
});

const inst = await client.createInstance({
  sequence_id: seq.id,
  context: { user_id: "123" },
});
```

## Code-first workflow DSL

The exported `workflow()` builder covers every Orch8 block and validates the
result with the SDK's Zod contract before it is sent. Supply a handler map to
make handler parameters type-safe:

```typescript
import { workflow } from "@orch8.io/sdk";

type Handlers = {
  "send-email": { to: string; subject: string };
  charge: { customerId: string; cents: number };
};

const checkout = workflow<Handlers>("checkout")
  .step("charge", "charge", { customerId: "cus_123", cents: 2500 }, {
    retry: { max_attempts: 3, initial_backoff: 500, max_backoff: 10_000 },
  })
  .step("receipt", "send-email", { to: "buyer@example.com", subject: "Receipt" })
  .build();

await client.createSequence(checkout);
```

Nested callbacks retain the same handler map, so steps inside parallel,
router, loop, saga, and A/B blocks are checked too. Omit the generic when
integrating a dynamic handler registry.

Framework runners can be exposed as durable workers without adding the
framework as an SDK dependency: `durableAgentHandler(graph)` supports the
structural `ainvoke`/`invoke` (LangGraph), `kickoff` (CrewAI), and `run`
(AutoGen/custom) contracts and pins thread identity to the Orch8 instance.

Request observers and cursor-preserving pagination use the same transport:

```typescript
const client = new Orch8Client({
  baseUrl: "https://api.orch8.io",
  onResponse: ({ method, path, status, durationMs }) =>
    metrics.timing("orch8.request", durationMs, { method, path, status }),
});
const page = await client.requestPage<TaskInstance>("/instances", { limit: "50" });
```

Resource IDs are encoded as single path segments. Resumable SSE consumers can
retain event IDs and provide them on a later connection:

```typescript
for await (const event of client.streamInstanceEvents(instanceId, {
  lastEventId: savedCursor,
})) {
  savedCursor = event.id;
  consume(event.data);
}
```

`ORCH8_ROUTES` and `ORCH8_API_VERSION` are generated from the engine OpenAPI
contract. Worker defaults are aligned across Node, Python, and Go; use
`worker.stats()` for a portable capacity snapshot.

For newly introduced or experimental engine routes, use the authenticated
low-level client without losing tenant headers:

```typescript
const engineInfo = await client.request("GET", "/info");
```

Safe requests retry transient `408`, `425`, `429`, and `5xx` responses up to
three times and each attempt times out after 30 seconds. Refresh short-lived
credentials per attempt with `getHeaders`; use `retry: false` to opt out.

```typescript
const client = new Orch8Client({
  baseUrl: "https://api.orch8.io",
  getHeaders: async () => ({ Authorization: `Bearer ${await getToken()}` }),
  retry: { maxAttempts: 3, baseDelayMs: 250 },
  timeoutMs: 30_000,
});
```

## Background jobs

`client.jobs` wraps the engine's background-jobs API (`/jobs`). A job is a
single durable step dispatched to a worker handler, with retries, delays,
priorities, and idempotent enqueue:

```typescript
const job = await client.jobs.enqueue(
  "send-email",
  { to: "buyer@example.com", template: "welcome" },
  {
    queue: "emails",
    delayMs: 60_000,                 // or runAt: new Date(...)
    retry: { max_attempts: 5, initial_backoff_ms: 1_000, max_backoff_ms: 60_000 },
    idempotencyKey: `welcome:${userId}`, // re-enqueue returns the same job
  },
);

const done = await client.jobs.waitFor(job.id, { timeoutMs: 120_000 });
if (done.status !== "completed") console.error(done.error);

for await (const page of client.jobs.list({ status: "dead_lettered", limit: 100 })) {
  for (const j of page.items) await client.jobs.cancel(j.id);
}
```

`list()` yields pages and follows `next_cursor`; `listAll()` yields individual
jobs. `waitFor()` resolves on any terminal status (`completed`, `failed`,
`cancelled`, `dead_lettered`) and throws `JobWaitTimeoutError` on timeout.

Jobs need no special worker: the job's step is an ordinary worker task for
`handler`, so an existing `Orch8Worker` that registers `"send-email"` runs it,
receiving the job payload as `task.params`:

```typescript
new Orch8Worker({
  client,
  workerId: "emails-1",
  handlers: { "send-email": async (task) => sendEmail(task.params) },
});
```

> The `/jobs` routes require an engine release that ships the background-jobs
> API; older engines return 404.

## Worker

Run a polling worker using `x-api-key` and `x-tenant-id` authentication:

```typescript
import { Orch8Client, Orch8Worker } from "@orch8.io/sdk";

const client = new Orch8Client({
  baseUrl: process.env.ORCH8_ENGINE_URL ?? "http://localhost:8080",
  tenantId: process.env.ORCH8_TENANT_ID,
  headers: { "x-api-key": process.env.ORCH8_API_KEY ?? "" },
});

const worker = new Orch8Worker({
  client,
  workerId: "worker-1",
  handlers: {
    "inspect-document": async (task) => {
      // Replace with your bounded task implementation.
      return { inspected: true, input: task.params };
    },
  },
  maxConcurrent: 10,
});

await worker.start(); // Starts polling and returns immediately.
process.once("SIGTERM", () => { void worker.stop(); });
process.once("SIGINT", () => { void worker.stop(); });
```

The worker echoes each task's `claim_epoch` on heartbeat, completion, and failure.
It respects the server's minimum poll delay and uses a heartbeat interval no
longer than the advertised interval or half the lease duration. Completion
callbacks run only after a successful acknowledgement; rejected or ambiguous
acknowledgements are left for lease recovery, without sending a contradictory
failure request.

`client.pollTasks()` and `client.pollTasksFromQueue()` still return task arrays.
Use `client.pollTaskBatch()` or `client.pollTaskBatchFromQueue()` to access
`tasks`, `lease_secs`, `heartbeat_interval_secs`, and `poll_after_ms` when writing
your own loop. Legacy array responses are accepted at the client boundary, with
no timing hints. Epoch fields remain optional in the types for legacy servers;
always echo the epoch supplied by a current server in custom worker loops.

A lease does not authorize offline execution. Handlers are not forcibly cancelled
on lease loss or timeout; use bounded work and provider idempotency keys for
external effects. `stop()` waits up to 30 seconds for executing handlers.

Handlers receive a second argument with the task's lease facts. `effectId` is
the server's deterministic idempotency key for the step's effect; pass it to
downstream APIs. All three are `null` against servers that predate them:

```typescript
handlers: {
  "charge-card": async (task, { effectId, leaseSecs, continuityEpoch }) =>
    payments.charge(task.params, { idempotencyKey: effectId ?? task.id }),
},
```

Steps can require a runtime with `params.$runtime` (kinds, a specific
`runtime_id`, hardware, regions, plugins, trust). Such tasks are only handed
to workers that advertise matching capabilities, so pass `capabilities` to
claim them. The worker sends a fresh advertisement with every poll, bound to
its `workerId` and valid for at most five minutes:

```typescript
new Orch8Worker({
  client,
  workerId: "gpu-box-1",
  handlers,
  capabilities: { kind: "desktop", hardware: ["cuda"], regions: ["norway"] },
});
```

`kind` defaults to `server` and `trust` to `registered`; `handlers` defaults to
the configured handler names. Tasks claimed while `stop()` is in progress, or
beyond free capacity, are released at once (`POST /workers/tasks/{id}/release`
with `started: false`) instead of waiting for lease expiry; servers without
that endpoint fall back to lease expiry.

## Browser worker (`@orch8.io/sdk/browser`)

Run step handlers inside a web page — steps that need a human, the DOM, or data
the page already has. The browser entry has no Node built-ins (CI bundles it
with esbuild for `platform: "browser"` and fails on any `node:` import).

**The browser never holds an API key or receives secrets.** Your backend mints
a short-lived token scoped to `kind=browser`, one runtime id and a handler
allowlist; it only works on the worker task endpoints. The engine never
dispatches credential-bearing steps to browser runtimes and filters the
instance context it sends them. Handlers *may* return page data (DOM, form
values, user input, the page's own fetched resources) as step output; output
is capped at 1 MiB of JSON and treated as untrusted input downstream.

Backend (Node, operator/admin key):

```typescript
import { Orch8Client } from "@orch8.io/sdk";

const orch8 = new Orch8Client({ baseUrl, headers: { "x-api-key": process.env.ORCH8_API_KEY! } });

app.post("/api/orch8/browser-session", requireLogin, async (req, res) => {
  res.json(await orch8.createBrowserSession({
    runtimeId: `browser-${req.user.id}`, // stable id = per-user mailbox for targeted steps
    handlers: ["confirm_shipping"],
    ttlSecs: 900, // server default 900, max 3600
  }));
});
```

Page:

```typescript
import { BrowserWorker, readForm } from "@orch8.io/sdk/browser";

const worker = new BrowserWorker({
  baseUrl: "https://orch8.example.com", // add your origin to ORCH8_CORS_ORIGINS
  getToken: () => fetch("/api/orch8/browser-session", { method: "POST" }).then((r) => r.json()),
});

worker.register("confirm_shipping", async (input, ctx) => {
  const values = await askUser(input, { signal: ctx.signal }); // abort on lease loss / tab hidden
  return { shipping: values, idempotencyKey: ctx.effectId };
});

await worker.start();
```

Place the step on a browser in the workflow:

```typescript
workflow("fulfilment")
  .step("confirm", "confirm_shipping", { orderId: "o-1" }, {
    runtime: { runtime_kinds: ["browser"], requires_human_ui: true }, // or runtime_id: "browser-u1"
  });
```

How it behaves:

- **Lease protocol.** Polls each handler with `capabilities { kind: "browser", runtime_id, handlers, expires_at }`
  (≤ 5 minutes, never past the token expiry), heartbeats every `lease_secs / 3` (default lease 30 s),
  then completes or fails echoing `claim_epoch`. A 404/409 heartbeat aborts `ctx.signal` with
  `LeaseLostError` and the result is never acknowledged. `ctx.heartbeat()` extends the lease on demand.
- **Page lifecycle.** On `pagehide` and `visibilitychange → hidden` (configure with `releaseOn`) every
  in-flight task is released via `POST /workers/tasks/{id}/release` using `fetch(..., { keepalive: true })`
  with `started: true`, handlers see `TaskReleasedError` on `ctx.signal`, and polling pauses until the
  page is visible again (or restored from the back/forward cache). Claims the page never started are
  released with `started: false`. Long interactive steps may prefer `releaseOn: ["pagehide"]`.
- **Tokens.** `getToken` runs at start and `refreshMarginSecs` (60) before expiry, and again on a 401/403.
  If the token lapses without a successful refresh, the worker stops and emits `{ type: "stopped", reason: "token_expired" }`.
- **Background tabs.** The poll/heartbeat loop runs in a dedicated Web Worker (started from a Blob URL;
  worker timers are throttled far less than a hidden tab's), while handlers run on the main thread with DOM
  access, bridged by `postMessage`. Without Worker support, or under a CSP without `worker-src blob:`, it falls
  back to the main thread (`mode: "main"` forces that; `mode: "worker"` refuses to fall back).
- **Resilience and privacy.** Poll failures back off exponentially with jitter (`pollIntervalMs` 1 s up to
  `maxBackoffMs` 30 s). `onEvent` receives lifecycle events with ids only; task input and output are never logged.
- **Page-data helpers.** `readForm(selectorOrForm)` (never reads password or file inputs, and hidden inputs only
  with `includeHidden`), `readSelection()`, `querySelectorText()`, `querySelectorAllText()`, and
  `assertOutputSize()` / `OutputTooLargeError` for the 1 MiB output guard (`maxOutputBytes` to change it).

A complete example (HTML page, handler and backend) lives in
[`examples/browser-worker/`](examples/browser-worker/); the end-to-end guide to
running steps in a user's tab is [`docs/browser-executor.md`](docs/browser-executor.md).

## Phone runtime nodes (device sessions)

Mobile apps running the embedded Orch8 engine as a runtime node (Swift,
React Native, Expo, KMP, Flutter) must never ship an operator or any stored
API key — anyone can extract it from the app binary. Your backend holds the
operator key and mints a short-lived **device session** (`dst_…`) for one
device and the phone's persisted `nodeRuntimeId`; the app fetches it through
the mobile SDK's token provider, which calls again whenever the session
expires (on a `401`).

```typescript
import { Orch8Client } from "@orch8.io/sdk";

const orch8 = new Orch8Client({ baseUrl, headers: { "x-api-key": process.env.ORCH8_OPERATOR_KEY! } });

app.post("/api/orch8/device-session", requireLogin, async (req, res) => {
  // deviceId / nodeRuntimeId come from the app; authorize that this user owns the device.
  const session = await orch8.createDeviceSession({
    deviceId: req.body.deviceId,
    runtimeId: req.body.nodeRuntimeId,
    handlers: ["scan_document"], // what the phone may claim; [] = delegate only
    ttlSecs: 3600,               // default 3600, max 86400
  });
  res.json({ token: session.token }); // only the token goes to the app
});
```

The token reaches only the device's own mobile register / sync / runtime
routes, the lease protocol as its runtime (allowlisted handlers), and the
delegation calls for executions it owns; everything else is `403`.

## Typed step IO (`orch8-typegen`)

`orch8-typegen` turns a sequence file's JSON Schema contracts into TypeScript:
`<Name>Input` from `input_schema`, `<Name><Step>Output` for every step
`output_schema` (including steps nested in parallel, loop, router, saga, ...
blocks), a `<Name>StepOutputs` map, a `<Name>StepId` union, and a
`<Name>Handlers` map from handler name to step ids. Output is deterministic:
no timestamps, sorted keys, stable names, so it can be committed and checked in
CI.

```bash
npx orch8-typegen sequences/checkout.json --out src/generated/checkout.ts
npx orch8-typegen sequences/checkout.json --out src/generated/checkout.ts --check  # CI: exit 1 on drift
```

```typescript
import type { CheckoutFlowInput, CheckoutFlowChargeOutput } from "./generated/checkout.js";

const handlers = {
  "payments.charge": async (task): Promise<CheckoutFlowChargeOutput> => { /* ... */ },
};
await client.createInstance({ sequence_id, context: { data: input satisfies CheckoutFlowInput } });
```

With `--remote`, the engine's typed-dataflow compiler does the work instead
(`POST /sequences/dataflow` for a file, `GET /sequences/{id}/dataflow` with
`--id`). Findings are printed, the command exits 1 when any finding is an
error, and the engine's `orch8-dataflow-v2` TypeScript bindings are written.
It reads `ORCH8_URL`, `ORCH8_API_KEY`, and `ORCH8_TENANT_ID`. The same
functions are importable from `@orch8.io/sdk/typegen`.

## Push dispatch (serverless workers)

A queue switched to push mode (`POST /queues/dispatch` with
`{ tenant_id, queue_name, mode: "push", push_url, secret }`) makes the engine
POST a task envelope to `push_url` when a task is enqueued. The engine signs it
with `X-Orch8-Timestamp` and `X-Orch8-Signature: sha256=<hex HMAC-SHA256(secret,
"{ts}.{raw body}")>`, and retries the delivery up to three times on a non-2xx
response.

The envelope is a wake-up, not a lease: the task is still `pending` and has no
`claim_epoch`. The helpers in `@orch8.io/sdk/push` therefore:

1. verify the signature in constant time and reject timestamps more than 300 s
   off (`toleranceSeconds`) with `401`;
2. claim from the envelope's queue via `POST /workers/tasks/poll/queue`
   (`claimLimit`, default 1; the claimed task may be an older pending task on
   the same queue);
3. run your handler and `complete`/`fail` with the claim epoch, like
   `Orch8Worker` does.

Handler failures are reported to the engine and answered with `200`; a failed
claim poll answers `502` so the engine retries the push.

```typescript
// app/api/orch8/route.ts — Next.js App Router
import { Orch8Client } from "@orch8.io/sdk";
import { createNextPushRoute } from "@orch8.io/sdk/push";

const client = new Orch8Client({
  baseUrl: process.env.ORCH8_URL!,
  tenantId: process.env.ORCH8_TENANT_ID,
  headers: { "x-api-key": process.env.ORCH8_API_KEY! },
});

export const { POST } = createNextPushRoute({
  client,
  secret: process.env.ORCH8_PUSH_SECRET!,
  handlers: { "send-email": async (task) => sendEmail(task.params) },
});
```

Other runtimes use the same options:

```typescript
import {
  createWebPushHandler,        // (Request) => Promise<Response>: Vercel, Deno, Bun
  createLambdaPushHandler,     // API Gateway REST/HTTP API, Lambda Function URLs
  createCloudflarePushHandler, // { fetch(request, env) }, options may be built from env
} from "@orch8.io/sdk/push";

export const handler = createLambdaPushHandler({ client, secret, handlers });

export default createCloudflarePushHandler((env: Env) => ({
  client: new Orch8Client({ baseUrl: env.ORCH8_URL, headers: { "x-api-key": env.ORCH8_API_KEY } }),
  secret: env.ORCH8_PUSH_SECRET,
  handlers,
}));
```

`verifyPushSignature(rawBody, headers, secret)` is exported for custom
receivers. Signature checks need the raw body bytes; do not re-serialize parsed
JSON. Keep handlers well inside your platform's function timeout.

## Serverless executors (`@orch8.io/sdk/serverless`)

Push dispatch wakes a function per task. Serverless executors go the other
way: a scheduled or on-demand invocation **pulls** a bounded batch of tasks,
runs them inside the time it has left, and leaves no lease behind. They use
the regular worker lease API (`poll` → `heartbeat` → `complete` | `fail` |
`release`, echoing `claim_epoch`); no extra engine endpoints are involved.

```typescript
// AWS Lambda, triggered by an EventBridge schedule (the event is ignored)
import { Orch8Client, createLambdaExecutor } from "@orch8.io/sdk/serverless";

export const handler = createLambdaExecutor(() => ({
  client: new Orch8Client({ baseUrl: process.env.ORCH8_URL!, headers: { "x-api-key": process.env.ORCH8_API_KEY! } }),
  handlers: { "thumbnail.render": async (task, ctx) => render(task.params, { signal: ctx.signal }) },
  maxTasks: 5,          // N tasks claimed per invocation
  safetyMarginMs: 3000, // kept free before the Lambda timeout
}));
```

```typescript
// Cloudflare Workers: Cron Trigger + authenticated POST, fetch only (no nodejs_compat)
import { Orch8Client, createCloudflareExecutor } from "@orch8.io/sdk/serverless";

export default createCloudflareExecutor((env: Env) => ({
  client: new Orch8Client({ baseUrl: env.ORCH8_URL, headers: { "x-api-key": env.ORCH8_API_KEY } }),
  handlers: { "lead.enrich": async (task) => enrich(task.params) },
  budgetMs: 25_000,                       // Workers have no remaining-time API
  triggerSecret: env.ORCH8_TRIGGER_SECRET, // fetch trigger answers 404 without it
}));
```

Both adapters call `drainOnce({ client, handlers, deadlineMs, ... })`, which
you can use directly from any short-lived process (CronJob, CI, Vercel cron).
`deadlineMs` is an absolute epoch-ms deadline by which every lease must be
settled. Each drain:

1. polls every handler (or `queueName`) with `limit` up to `maxTasks`
   (default 10) and optional `capabilities` (Lambda advertises `kind: server`,
   Cloudflare `kind: edge` by default), in rounds until the queue is empty,
   `maxTasks` is reached, or less than `minTaskBudgetMs` remains;
2. runs claimed tasks concurrently, heartbeating at the shorter of
   `heartbeatIntervalMs` and half the lease;
3. completes or fails each one like `Orch8Worker` (thrown errors are retryable
   unless `err.retryable === false`; `timeout_ms` is enforced);
4. at `deadlineMs - releaseMarginMs` (default 1 s before), aborts `ctx.signal`
   and releases every still-running task with `started: true`, so the engine
   re-dispatches it (and marks a side-effecting step's receipt Unknown) instead
   of waiting for the lease to expire. A claim whose `timeout_ms` cannot fit
   the remaining budget is released with `started: false` without running.
   A result that arrives after its release is never acknowledged.

Handlers are plain `Orch8Worker` handlers; the context additionally has
`signal`, `deadlineMs`, `remainingMs()` and `heartbeat()`. The returned
`DrainResult` lists every task's outcome (`completed`, `failed`, `released`,
`released_unstarted`, `lease_lost`, `ack_rejected`) and why the drain stopped
(`empty`, `deadline`, `max_tasks`, `poll_error`); the Cloudflare fetch trigger
returns it as JSON (502 on `poll_error`).

The `@orch8.io/sdk/serverless` module graph has no Node built-ins and
re-exports `Orch8Client`; import from it (not the root entry) on edge runtimes.
Handlers still must be idempotent: a released task runs again elsewhere. Full
examples: [`examples/serverless-lambda/`](examples/serverless-lambda/) (with a
SAM template), [`examples/serverless-cloudflare/`](examples/serverless-cloudflare/)
(with `wrangler.toml`) and [`examples/serverless-drain/`](examples/serverless-drain/).

## Framework integrations

Each integration is a separate subpath with its framework as an optional peer
dependency, so unused integrations never load.

### Express (`@orch8.io/sdk/express`)

```typescript
import express from "express";
import { orch8Express, getOrch8 } from "@orch8.io/sdk/express";

const app = express();
app.use(orch8Express({
  client,                                  // attached as req.orch8
  push: {                                  // optional push receiver
    path: "/orch8/push",                   // default
    secret: process.env.ORCH8_PUSH_SECRET!,
    handlers: { "send-email": async (task) => sendEmail(task.params) },
  },
}));
app.use(express.json());                   // after orch8Express, or:
// app.use(express.json({ verify: orch8RawBody })) before it

app.post("/signup", async (req, res) => {
  const job = await getOrch8(req).jobs.enqueue("send-email", { to: req.body.email });
  res.json({ job: job.id });
});
```

### NestJS (`@orch8.io/sdk/nestjs`)

```typescript
import { Injectable, Module } from "@nestjs/common";
import { Orch8Client, type WorkerTask } from "@orch8.io/sdk";
import { Orch8Handler, Orch8Module } from "@orch8.io/sdk/nestjs";

@Injectable()
export class EmailHandlers {
  @Orch8Handler("send-email")
  async send(task: WorkerTask) {
    return { sent: true };
  }
}

@Injectable()
export class SignupService {
  constructor(private readonly orch8: Orch8Client) {}   // or @Inject(ORCH8_CLIENT)
}

@Module({
  imports: [
    Orch8Module.forRoot({
      client: { baseUrl: process.env.ORCH8_URL!, tenantId: "acme" },
      worker: { workerId: `api-${process.pid}` },      // optional: poll with discovered handlers
    }),
  ],
  providers: [EmailHandlers, SignupService],
})
export class AppModule {}
```

`forRoot` registers the module globally, discovers `@Orch8Handler` methods on
providers and controllers, starts an `Orch8Worker` on bootstrap when `worker`
is set, and stops it on shutdown (enable `app.enableShutdownHooks()`). Inject
`Orch8HandlerRegistry` to read the handler map or call
`registry.createPushHandler({ secret })` from a controller for push dispatch.

### Durable AI tools (`@orch8.io/sdk/ai-sdk`, `@orch8.io/sdk/openai-agents`)

Following the engine's framework-adapter pattern, tool calls go behind
idempotent Orch8 steps and agent loops checkpoint at turn boundaries. Each
wrapped tool call becomes a background job whose idempotency key is
`${scope}:${toolName}:${toolCallId}`: a retried or replayed turn with the same
call id returns the recorded result instead of charging the card twice. The
original tools run on an ordinary worker. The adapters rely on the `/jobs` API
(see Background jobs).

```typescript
// Vercel AI SDK
import { generateText, tool } from "ai";
import { durableTools, aiSdkToolHandlers, checkpointSteps, TurnCheckpointer } from "@orch8.io/sdk/ai-sdk";

const tools = { chargeCard: tool({ description: "...", inputSchema, execute: charge }) };

// Worker process: executes the real tools (handler names "ai-tool.<name>").
new Orch8Worker({ client, workerId: "tools-1", handlers: aiSdkToolHandlers(tools) });

// Agent process (e.g. inside an "agent-turn" worker handler):
async function agentTurn(task: WorkerTask) {
  const checkpointer = new TurnCheckpointer({ client, task, workerId: "agent-1" });
  const previous = checkpointer.resume();            // state from a crashed attempt, if any
  return generateText({
    model,
    tools: durableTools(tools, { client, scope: task.instance_id }),
    messages: previous?.messages ?? initialMessages,
    onStepFinish: checkpointSteps(checkpointer),     // checkpoint every model step
  });
}
```

```typescript
// OpenAI Agents SDK (JS)
import { Agent, run, RunState } from "@openai/agents";
import { durableAgentTools, agentToolHandlers, checkpointRunState, TurnCheckpointer } from "@orch8.io/sdk/openai-agents";

const agent = new Agent({ name: "support", tools: durableAgentTools([lookupOrder, refund], { client, scope: threadId }) });
const handlers = agentToolHandlers([lookupOrder, refund]);   // register on a worker

const checkpointer = new TurnCheckpointer({ client, task, workerId });
const saved = checkpointer.resume();
const input = saved ? await RunState.fromString(agent, saved.state) : userMessage;
const result = await run(agent, input);
await checkpointRunState(checkpointer, result);              // one checkpoint per turn
```

Hosted tools and handoffs pass through unchanged. A call that ends `failed`,
`cancelled`, or `dead_lettered` throws `DurableToolError` into the agent loop.
Checkpoints use the worker heartbeat checkpoint API (compare-and-swap on
`checkpoint_seq`, 256 KiB limit); pass a `select` function to
`checkpointSteps` to store less than the full message list.

## Testing

`@orch8.io/sdk/testing` provides two in-process environments.

**`FakeOrch8Server`** is a pure-TypeScript engine double for unit-testing
workers with Vitest or Jest. It implements the worker protocol (poll, queue
poll, complete, fail, heartbeat and checkpoint compare-and-swap, claim epochs,
leases), instance CRUD/signals/outputs, and the jobs API on a virtual clock.
`runUntilIdle()` skips time over delays and retry backoffs:

```typescript
import { describe, expect, it } from "vitest";
import { Orch8Worker } from "@orch8.io/sdk";
import { FakeOrch8Server } from "@orch8.io/sdk/testing";

it("sends the welcome email after an hour", async () => {
  const engine = new FakeOrch8Server();
  const client = engine.client();          // Orch8Client backed by the fake, no network
  const job = await client.jobs.enqueue("send-email", { to: "a@b.c" }, { delayMs: 3_600_000 });

  await engine.runUntilIdle({ "send-email": async (task) => ({ sent: true }) });

  expect((await client.jobs.get(job.id)).status).toBe("completed");
});

it("runs a real worker against enqueued tasks", async () => {
  const engine = new FakeOrch8Server();
  const task = engine.enqueueTask({ handler_name: "greet", params: { name: "Ada" } });
  const worker = new Orch8Worker({
    client: engine.client(),
    workerId: "w-1",
    pollIntervalMs: 5,
    handlers: { greet: async (t) => ({ hi: t.params }) },
  });
  await worker.start();
  expect((await engine.waitForTask(task.id)).state).toBe("completed");
  await worker.stop();
});
```

`engine.advanceTime(ms)` moves the clock by hand (expiring leases whose
heartbeats lapsed), `engine.requests` records every call, and
`engine.listen()` serves the same fake over real HTTP for code that cannot take
an injected client. Every `Orch8Client` also accepts a `fetch` option.

**`NativeTestEnvironment`** runs whole sequences in the engine's Rust core via
the optional peer dependency `@orch8/engine-native` (napi bindings from the
engine repo, `packages/node-native`). Delays and backoffs run on virtual time:

```typescript
import { workflow } from "@orch8.io/sdk";
import { createNativeTestEnvironment } from "@orch8.io/sdk/testing";

const env = await createNativeTestEnvironment(); // throws a clear error if not installed
const seq = workflow("reminder").delay({ duration: 3 * 86_400_000 }).build();
const result = await env.run(seq, { user_id: "u1" });
expect(result.state).toBe("completed");
```

The native runner executes built-in handlers in dry-run mode and auto-approves
human steps. It does not call your external worker handlers; a run that needs
one (or a signal) returns with `state: "waiting"`. Use `FakeOrch8Server` for
worker logic.

## Error Handling

```typescript
import { Orch8Error } from "@orch8.io/sdk";

try {
  await client.getInstance("non-existent");
} catch (err) {
  if (err instanceof Orch8Error) {
    console.error(`API error ${err.status} on ${err.path}`);
  }
}
```

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
npm run check:browser        # browser bundle has no node: imports; lease worker source is fresh
npm run generate:lease-worker # after editing src/browser/engine.ts
```
