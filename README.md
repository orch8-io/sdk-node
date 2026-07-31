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

Run a polling worker that claims and executes tasks:

```typescript
import { Orch8Client, Orch8Worker } from "@orch8/sdk";

const client = new Orch8Client({ baseUrl: "https://api.orch8.io", tenantId: "my-tenant" });

const worker = new Orch8Worker({
  client,
  workerId: "worker-1",
  handlers: {
    "send-email": async (task) => {
      console.log(`Sending email to ${task.params.to}`);
      return { sent: true };
    },
  },
  maxConcurrent: 10,
});

await worker.start(); // blocks until worker.stop() is called
```

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
