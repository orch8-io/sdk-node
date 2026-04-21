# @orch8/sdk

Node.js SDK for the [Orch8](https://orch8.io) workflow engine.

## Installation

```bash
npm install @orch8/sdk
```

Requires Node.js 18+.

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
