// AWS Lambda executor: an EventBridge schedule (e.g. rate(1 minute)) invokes
// this function; each invocation claims up to 5 tasks, runs them inside the
// remaining invocation time minus a safety margin, heartbeats, and releases
// anything still running before Lambda's timeout.
import { Orch8Client, createLambdaExecutor } from "@orch8.io/sdk/serverless";

export const handler = createLambdaExecutor(() => ({
  client: new Orch8Client({
    baseUrl: process.env.ORCH8_URL!,
    tenantId: process.env.ORCH8_TENANT_ID,
    headers: { "x-api-key": process.env.ORCH8_API_KEY! }, // from Secrets Manager / SSM in production
  }),
  handlers: {
    "thumbnail.render": async (task, ctx) => {
      const { url } = task.params as { url: string };
      // Pass ctx.signal to I/O so work stops when the budget ends (the task is
      // then released and re-dispatched) and ctx.effectId as an idempotency key.
      const res = await fetch(url, { signal: ctx.signal });
      return { bytes: (await res.arrayBuffer()).byteLength, idempotencyKey: ctx.effectId };
    },
  },
  maxTasks: 5,
  safetyMarginMs: 3_000, // kept free before the Lambda timeout
  releaseMarginMs: 1_000, // release calls happen inside this window
  capabilities: { kind: "server", regions: [process.env.AWS_REGION ?? "us-east-1"] },
}));
