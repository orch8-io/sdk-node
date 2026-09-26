import { describe, expect, it, vi } from "vitest";
import { Orch8Client } from "../client.js";
import { JobWaitTimeoutError } from "../jobs.js";

function json(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setup(responses: Array<Response | (() => Response)>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return typeof next === "function" ? next() : next;
  });
  const client = new Orch8Client({
    baseUrl: "http://engine/api/v1",
    tenantId: "t1",
    fetch: fetchMock as unknown as typeof fetch,
    retry: false,
  });
  return { client, calls };
}

const job = {
  id: "j1",
  instance_id: "i1",
  handler: "send-email",
  status: "scheduled",
  created_at: "2026-01-01T00:00:00Z",
  run_at: "2026-01-01T00:00:00Z",
};

describe("client.jobs", () => {
  it("enqueue maps options to the wire body", async () => {
    const { client, calls } = setup([json(job, 201)]);
    const result = await client.jobs.enqueue(
      "send-email",
      { to: "a@b.c" },
      {
        queue: "emails",
        priority: 5,
        retry: { max_attempts: 3, initial_backoff_ms: 100, max_backoff_ms: 1000 },
        runAt: new Date("2026-02-01T00:00:00Z"),
        idempotencyKey: "welcome:42",
        metadata: { source: "signup" },
      },
    );
    expect(result.id).toBe("j1");
    expect(calls[0]).toEqual({
      url: "http://engine/api/v1/jobs",
      method: "POST",
      body: {
        handler: "send-email",
        payload: { to: "a@b.c" },
        queue: "emails",
        priority: 5,
        retry: { max_attempts: 3, initial_backoff_ms: 100, max_backoff_ms: 1000 },
        run_at: "2026-02-01T00:00:00.000Z",
        idempotency_key: "welcome:42",
        metadata: { source: "signup" },
      },
    });
  });

  it("enqueue sends delay_ms and rejects delay+runAt", async () => {
    const { client, calls } = setup([json(job, 201)]);
    await client.jobs.enqueue("h", 1, { delayMs: 250 });
    expect(calls[0].body).toEqual({ handler: "h", payload: 1, delay_ms: 250 });
    await expect(client.jobs.enqueue("h", 1, { delayMs: 1, runAt: "x" })).rejects.toThrow(
      /mutually exclusive/,
    );
  });

  it("get / cancel encode ids", async () => {
    const { client, calls } = setup([json({ ...job, status: "completed", output: { ok: 1 } }), json(undefined, 204)]);
    const detail = await client.jobs.get<{ ok: number }>("a/b");
    expect(detail.output?.ok).toBe(1);
    await client.jobs.cancel("a/b");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET http://engine/api/v1/jobs/a%2Fb",
      "DELETE http://engine/api/v1/jobs/a%2Fb",
    ]);
  });

  it("list iterates pages following next_cursor", async () => {
    const { client, calls } = setup([
      json({ items: [job], next_cursor: "c2" }),
      json({ items: [{ ...job, id: "j2" }], next_cursor: null }),
    ]);
    const ids: string[] = [];
    for await (const page of client.jobs.list({ handler: "send-email", status: "failed", limit: 1 })) {
      ids.push(...page.items.map((j) => j.id));
    }
    expect(ids).toEqual(["j1", "j2"]);
    expect(calls[0].url).toBe("http://engine/api/v1/jobs?handler=send-email&status=failed&limit=1");
    expect(calls[1].url).toBe(
      "http://engine/api/v1/jobs?handler=send-email&status=failed&limit=1&cursor=c2",
    );
  });

  it("listAll flattens items and stops on a repeated cursor", async () => {
    const { client } = setup([
      json({ items: [job], next_cursor: "same" }),
      json({ items: [{ ...job, id: "j2" }], next_cursor: "same" }),
    ]);
    const ids: string[] = [];
    for await (const j of client.jobs.listAll()) ids.push(j.id);
    expect(ids).toEqual(["j1", "j2"]);
  });

  it("waitFor polls until a terminal status", async () => {
    const { client, calls } = setup([
      json({ ...job, status: "scheduled" }),
      json({ ...job, status: "running" }),
      json({ ...job, status: "dead_lettered", error: "boom" }),
    ]);
    const done = await client.jobs.waitFor("j1", { pollIntervalMs: 10 });
    expect(done.status).toBe("dead_lettered");
    expect(calls).toHaveLength(3);
  });

  it("waitFor times out", async () => {
    const { client } = setup(Array.from({ length: 50 }, () => () => json({ ...job, status: "running" })));
    await expect(client.jobs.waitFor("j1", { pollIntervalMs: 10, timeoutMs: 30 })).rejects.toBeInstanceOf(
      JobWaitTimeoutError,
    );
  });
});
