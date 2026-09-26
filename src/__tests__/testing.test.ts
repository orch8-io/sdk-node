import { describe, expect, it, vi } from "vitest";
import { Orch8Worker } from "../worker.js";
import {
  FakeOrch8Server,
  createNativeTestEnvironment,
  isNativeEngineAvailable,
  type EngineNativeBindings,
} from "../testing/index.js";
import { workflow } from "../builder.js";

describe("FakeOrch8Server", () => {
  it("runs jobs through handlers and skips virtual time over delays", async () => {
    const engine = new FakeOrch8Server();
    const client = engine.client();
    const start = engine.now();
    const job = await client.jobs.enqueue("send-email", { to: "a@b.c" }, { delayMs: 3_600_000 });
    expect(job.status).toBe("scheduled");

    const handler = vi.fn(async (task) => ({ sent: (task.params as { to: string }).to }));
    const results = await engine.runUntilIdle({ "send-email": handler });
    expect(results.map((r) => r.outcome)).toEqual(["completed"]);
    expect(engine.now() - start).toBe(3_600_000);

    const detail = await client.jobs.get(job.id);
    expect(detail).toMatchObject({ status: "completed", output: { sent: "a@b.c" } });
  });

  it("retries retryable failures with backoff and dead-letters when exhausted", async () => {
    const engine = new FakeOrch8Server();
    const client = engine.client();
    const job = await client.jobs.enqueue("flaky", {}, {
      retry: { max_attempts: 3, initial_backoff_ms: 1_000 },
    });
    const start = engine.now();
    const flaky = vi.fn(async () => {
      throw Object.assign(new Error("503"), { retryable: true });
    });
    await engine.runUntilIdle({ flaky });
    expect(flaky).toHaveBeenCalledTimes(3);
    expect(engine.now() - start).toBe(1_000 + 2_000);
    expect((await client.jobs.get(job.id)).status).toBe("dead_lettered");
  });

  it("dedupes idempotent job enqueues and paginates list", async () => {
    const engine = new FakeOrch8Server();
    const client = engine.client();
    const a = await client.jobs.enqueue("h", 1, { idempotencyKey: "k" });
    const b = await client.jobs.enqueue("h", 1, { idempotencyKey: "k" });
    await client.jobs.enqueue("h", 2);
    await client.jobs.enqueue("h", 3);
    expect(b.id).toBe(a.id);
    const pages: number[] = [];
    for await (const page of client.jobs.list({ handler: "h", limit: 2 })) pages.push(page.items.length);
    expect(pages).toEqual([2, 1]);
  });

  it("enforces claim epochs and expires leases on virtual time", async () => {
    const engine = new FakeOrch8Server({ leaseSecs: 30 });
    const client = engine.client();
    const task = engine.enqueueTask({ handler_name: "h" });
    const [first] = await client.pollTasks({ handler_name: "h", worker_id: "w1" });
    expect(first.claim_epoch).toBe(1);
    engine.advanceTime(31_000); // lease lapses, task returns to pending
    const [second] = await client.pollTasks({ handler_name: "h", worker_id: "w2" });
    expect(second.claim_epoch).toBe(2);
    await expect(
      client.completeTask(task.id, { worker_id: "w1", claim_epoch: 1, output: {} }),
    ).rejects.toMatchObject({ status: 409 });
    await client.completeTask(task.id, { worker_id: "w2", claim_epoch: 2, output: { ok: true } });
    expect(engine.task(task.id)?.state).toBe("completed");
  });

  it("supports checkpoint compare-and-swap on heartbeat", async () => {
    const engine = new FakeOrch8Server();
    const client = engine.client();
    engine.enqueueTask({ handler_name: "h" });
    const [t] = await client.pollTasks({ handler_name: "h", worker_id: "w" });
    const ack = await client.heartbeatTask(t.id, { worker_id: "w", claim_epoch: t.claim_epoch, checkpoint: { turn: 1 }, checkpoint_seq: 0 });
    expect(ack.checkpoint_seq).toBe(1);
    await expect(
      client.heartbeatTask(t.id, { worker_id: "w", claim_epoch: t.claim_epoch, checkpoint: { turn: 2 }, checkpoint_seq: 0 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(engine.task(t.id)?.resume_checkpoint).toEqual({ turn: 1 });
  });

  it("drives a real Orch8Worker and exposes instance outputs", async () => {
    const engine = new FakeOrch8Server();
    const client = engine.client();
    const instance = await client.createInstance({ sequence_id: "seq-1", context: { data: { user: 1 } } });
    const task = engine.enqueueTask({ handler_name: "greet", instance_id: instance.id, block_id: "hello", params: { name: "Ada" } });
    const worker = new Orch8Worker({
      client,
      workerId: "w-1",
      pollIntervalMs: 5,
      handlers: { greet: async (t) => ({ greeting: `hi ${(t.params as { name: string }).name}` }) },
    });
    await worker.start();
    try {
      const done = await engine.waitForTask(task.id);
      expect(done.state).toBe("completed");
    } finally {
      await worker.stop();
    }
    expect(await client.getOutputs(instance.id)).toMatchObject([
      { block_id: "hello", output: { greeting: "hi Ada" } },
    ]);
    await client.sendSignal(instance.id, { signal_type: "cancel" });
    expect(engine.instances.get(instance.id)?.signals).toHaveLength(1);
  });

  it("serves the same API over real HTTP", async () => {
    const engine = new FakeOrch8Server();
    const server = await engine.listen();
    try {
      const res = await fetch(`${server.url}/api/v1/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handler: "h", payload: {} }),
      });
      expect(res.status).toBe(201);
      expect(engine.jobs.size).toBe(1);
    } finally {
      await server.close();
    }
  });
});

describe("NativeTestEnvironment", () => {
  it("delegates to injected engine bindings and fills sequence defaults", async () => {
    const bindings: EngineNativeBindings = {
      sequenceSchemaVersion: () => 1,
      validateSequenceJson: (s) => s,
      runSequenceJson: vi.fn(async (seq: string, input?: string, maxTicks?: number) => {
        const parsed = JSON.parse(seq);
        expect(parsed).toMatchObject({ tenant_id: "test", namespace: "default", version: 1 });
        expect(JSON.parse(input!)).toEqual({ amount: 5 });
        expect(maxTicks).toBe(50);
        return JSON.stringify({ state: "completed", context: { data: { amount: 5 } }, outputs: [], ticks: 3 });
      }),
    };
    const env = await createNativeTestEnvironment({ bindings });
    expect(env.schemaVersion).toBe(1);
    const seq = workflow("checkout").delay({ duration: 86_400_000 }).build();
    const result = await env.run(seq, { amount: 5 }, { maxTicks: 50 });
    expect(result.state).toBe("completed");
    expect(env.validate({ name: "x", blocks: [] })).toMatchObject({ name: "x", tenant_id: "test" });
  });

  it("explains how to install the optional peer when missing", async () => {
    if (isNativeEngineAvailable()) return;
    await expect(createNativeTestEnvironment()).rejects.toThrow(/@orch8\/engine-native is not installed/);
  });
});
