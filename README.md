# @orch8/sdk

Node.js SDK for the [Orch8](https://orch8.io) workflow engine.

## Installation

```bash
npm install @orch8/sdk
```

Requires Node.js 18+.

Version 0.7 supports the Orch8 0.7 sequence contract, including sagas,
conditional steps, filtered retries, output schemas, local-time delays, and
bounded loop history. Portable continuity APIs are available under
`client.continuity`.

## Quick Start

```typescript
import { Orch8Client } from "@orch8/sdk";

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

## Error Handling

```typescript
import { Orch8Error } from "@orch8/sdk";

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
