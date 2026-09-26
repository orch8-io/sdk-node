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
```
