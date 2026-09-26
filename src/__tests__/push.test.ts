import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Orch8Client } from "../client.js";
import {
  createCloudflarePushHandler,
  createLambdaPushHandler,
  createNextPushRoute,
  createPushHandler,
  createWebPushHandler,
  verifyPushSignature,
} from "../push/index.js";

const SECRET = "shhh";
const NOW = 1_800_000_000_000;

const envelope = {
  task_id: "t-1",
  instance_id: "i-1",
  block_id: "s1",
  handler_name: "charge",
  queue_name: "payments",
  params: { cents: 100 },
  context: {},
  attempt: 0,
  timeout_ms: null,
};

/** Independent re-implementation of orch8-engine webhooks::sign. */
function engineSign(body: string, ts: number, secret = SECRET) {
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return { "X-Orch8-Timestamp": String(ts), "X-Orch8-Signature": `sha256=${sig}` };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function engine(taskOverrides: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; body: any }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path.endsWith("/poll/queue")) {
      return json({
        tasks: [{ ...envelope, id: "t-1", claim_epoch: 7, state: "claimed", ...taskOverrides }],
        lease_secs: 60,
      });
    }
    return json({});
  });
  const client = new Orch8Client({ baseUrl: "http://engine", fetch: fetchMock as unknown as typeof fetch, retry: false });
  return { client, calls };
}

describe("verifyPushSignature", () => {
  const body = JSON.stringify(envelope);
  const ts = NOW / 1000;
  const now = () => NOW;

  it("accepts the engine's signature", async () => {
    expect(await verifyPushSignature(body, engineSign(body, ts), SECRET, { now })).toEqual({ ok: true });
  });

  it("rejects a tampered body, wrong secret, missing and stale headers", async () => {
    const headers = engineSign(body, ts);
    expect((await verifyPushSignature(body + " ", headers, SECRET, { now })).ok).toBe(false);
    expect((await verifyPushSignature(body, headers, "other", { now })).ok).toBe(false);
    expect(await verifyPushSignature(body, {}, SECRET, { now })).toEqual({ ok: false, reason: "missing_headers" });
    expect(
      await verifyPushSignature(body, engineSign(body, ts - 301), SECRET, { now }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(
      await verifyPushSignature(body, engineSign(body, ts - 301), SECRET, { now, toleranceSeconds: 600 }),
    ).toEqual({ ok: true });
    expect(
      await verifyPushSignature(body, { ...headers, "X-Orch8-Timestamp": "12abc" }, SECRET, { now }),
    ).toEqual({ ok: false, reason: "bad_timestamp" });
  });
});

describe("createPushHandler", () => {
  const body = JSON.stringify(envelope);
  const headers = engineSign(body, NOW / 1000);

  it("requires a secret unless explicitly unsigned", () => {
    const { client } = engine();
    expect(() => createPushHandler({ client, handlers: {} })).toThrow(/secret/);
    expect(() => createPushHandler({ client, handlers: {}, allowUnsigned: true })).not.toThrow();
  });

  it("claims from the envelope queue, runs the handler, completes with the epoch", async () => {
    const { client, calls } = engine();
    const charge = vi.fn(async (task: any) => ({ charged: task.params.cents }));
    const handle = createPushHandler({ client, secret: SECRET, handlers: { charge }, workerId: "fn-1", now: () => NOW });
    const res = await handle({ method: "POST", headers, body });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      claimed: 1,
      results: [{ task_id: "t-1", handler_name: "charge", outcome: "completed" }],
    });
    expect(calls[0]).toEqual({
      path: "/workers/tasks/poll/queue",
      body: { handler_name: "charge", worker_id: "fn-1", limit: 1, queue_name: "payments" },
    });
    expect(calls[1]).toEqual({
      path: "/workers/tasks/t-1/complete",
      body: { worker_id: "fn-1", claim_epoch: 7, output: { charged: 100 } },
    });
  });

  it("reports handler errors with fail (retryable flag honoured) and still returns 200", async () => {
    const { client, calls } = engine();
    const err = Object.assign(new Error("card declined"), { retryable: true });
    const handle = createPushHandler({
      client, secret: SECRET, workerId: "fn-1", now: () => NOW,
      handlers: { charge: async () => { throw err; } },
    });
    const res = await handle({ method: "POST", headers, body });
    expect(res.status).toBe(200);
    expect(calls[1]).toEqual({
      path: "/workers/tasks/t-1/fail",
      body: { worker_id: "fn-1", claim_epoch: 7, message: "card declined", retryable: true },
    });
  });

  it("returns 401/400/404/405 without contacting the engine", async () => {
    const { client, calls } = engine();
    const handle = createPushHandler({ client, secret: SECRET, handlers: { charge: async () => 1 }, now: () => NOW });
    expect((await handle({ method: "POST", headers: {}, body })).status).toBe(401);
    const bad = "not json";
    expect((await handle({ method: "POST", headers: engineSign(bad, NOW / 1000), body: bad })).status).toBe(400);
    const other = JSON.stringify({ ...envelope, handler_name: "nope" });
    expect((await handle({ method: "POST", headers: engineSign(other, NOW / 1000), body: other })).status).toBe(404);
    expect((await handle({ method: "GET", headers, body })).status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it("returns 502 when the claim poll fails so the engine retries the push", async () => {
    const client = new Orch8Client({
      baseUrl: "http://engine",
      retry: false,
      fetch: (async () => json({ error: "down" }, 503)) as unknown as typeof fetch,
    });
    const handle = createPushHandler({ client, secret: SECRET, handlers: { charge: async () => 1 }, now: () => NOW });
    expect((await handle({ method: "POST", headers, body })).status).toBe(502);
  });
});

describe("runtime adapters", () => {
  const body = JSON.stringify(envelope);

  function request() {
    const ts = Math.floor(Date.now() / 1000);
    return new Request("https://fn.example/api/orch8", { method: "POST", headers: engineSign(body, ts), body });
  }

  it("web / Next.js App Router", async () => {
    const { client } = engine();
    const handlers = { charge: async () => ({ ok: true }) };
    const web = createWebPushHandler({ client, secret: SECRET, handlers });
    expect((await web(request())).status).toBe(200);
    const { POST } = createNextPushRoute({ client, secret: SECRET, handlers });
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect((await res.json()).claimed).toBe(1);
  });

  it("AWS Lambda (HTTP API v2 with base64 body, REST v1)", async () => {
    const { client } = engine();
    const handler = createLambdaPushHandler({ client, secret: SECRET, handlers: { charge: async () => 1 } });
    const ts = Math.floor(Date.now() / 1000);
    const lower = Object.fromEntries(Object.entries(engineSign(body, ts)).map(([k, v]) => [k.toLowerCase(), v]));
    const v2 = await handler({
      body: Buffer.from(body).toString("base64"),
      isBase64Encoded: true,
      headers: lower,
      requestContext: { http: { method: "POST" } },
    });
    expect(v2.statusCode).toBe(200);
    const v1 = await handler({ body, headers: engineSign(body, ts), httpMethod: "POST" });
    expect(v1.statusCode).toBe(200);
    const denied = await handler({ body, headers: {}, httpMethod: "POST" });
    expect(denied.statusCode).toBe(401);
  });

  it("Cloudflare Workers builds options from env", async () => {
    const { client } = engine();
    const factory = vi.fn((env: { SECRET: string }) => ({ client, secret: env.SECRET, handlers: { charge: async () => 1 } }));
    const worker = createCloudflarePushHandler(factory);
    const env = { SECRET };
    expect((await worker.fetch(request(), env)).status).toBe(200);
    expect((await worker.fetch(request(), env)).status).toBe(200);
    expect(factory).toHaveBeenCalledTimes(1);
    expect((await worker.fetch(request(), { SECRET: "wrong" })).status).toBe(401);
  });
});
