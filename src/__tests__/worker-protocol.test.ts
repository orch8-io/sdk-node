import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Orch8Client } from "../client.js";
import { Orch8Worker } from "../worker.js";

const task = { id: "task-1", handler_name: "inspect", claim_epoch: 7, timeout_ms: null };
const envelope = { tasks: [task], lease_secs: 6, heartbeat_interval_secs: 1, poll_after_ms: 5000 };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("worker wire protocol", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("preserves poll metadata and keeps array APIs compatible for both queues and handlers", async () => {
    const client = new Orch8Client({ baseUrl: "http://engine" });
    fetchMock.mockImplementation(async () => response(envelope));
    expect(await client.pollTaskBatch({})).toEqual(envelope);
    expect(await client.pollTaskBatchFromQueue({})).toEqual(envelope);
    expect(await client.pollTasks({})).toEqual([task]);
    expect(await client.pollTasksFromQueue({})).toEqual([task]);
    fetchMock.mockImplementation(async () => response([task]));
    expect(await client.pollTaskBatch({})).toEqual({ tasks: [task] });
    expect(await client.pollTasksFromQueue({})).toEqual([task]);
  });

  it("rejects malformed envelopes instead of treating them as an empty queue", async () => {
    const client = new Orch8Client({ baseUrl: "http://engine" });
    for (const body of [{}, { tasks: null }, { tasks: [], lease_secs: 0 }, { tasks: [], poll_after_ms: -1 }]) {
      fetchMock.mockImplementation(async () => response(body));
      await expect(client.pollTaskBatch({})).rejects.toThrow(TypeError);
    }
  });

  it.each([false, true])("echoes epochs, honors hints, and rejects stale completion (client=%s)", async (useClient) => {
    let finish!: (output: unknown) => void;
    const handler = vi.fn(() => new Promise<unknown>((resolve) => { finish = resolve; }));
    const completed = vi.fn();
    const failed = vi.fn();
    const client = new Orch8Client({ baseUrl: "http://engine", tenantId: "tenant-1", headers: { "x-api-key": "test-key" } });
    const statuses: number[] = [];
    const paths: string[] = [];
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url);
      paths.push(path);
      if (path.endsWith("/poll")) return response(envelope);
      expect(JSON.parse(String(init?.body))).toMatchObject({ worker_id: "phone-1", claim_epoch: 7 });
      if (useClient) {
        expect(init?.headers).toMatchObject({ "X-Tenant-Id": "tenant-1", "x-api-key": "test-key" });
      }
      const status = path.endsWith("/complete") ? 409 : 200;
      statuses.push(status);
      return response({ checkpoint_seq: 0 }, status);
    });
    const worker = new Orch8Worker({
      ...(useClient ? { client } : { engineUrl: "http://engine" }),
      workerId: "phone-1", handlers: { inspect: handler }, pollIntervalMs: 100,
      onTaskComplete: completed, onTaskFail: failed,
    });
    try {
      await worker.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(paths.filter((p) => p.endsWith("/heartbeat"))).toHaveLength(1);
      expect(paths.filter((p) => p.endsWith("/poll"))).toHaveLength(1);
      finish({ done: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(statuses).toEqual([200, 409]);
      expect(completed).not.toHaveBeenCalled();
      expect(failed).not.toHaveBeenCalled();
      expect(paths.some((p) => p.endsWith("/fail"))).toBe(false);
      expect(worker.stats().inFlight).toBe(0);
    } finally {
      finish?.({});
      const stopping = worker.stop();
      await vi.advanceTimersByTimeAsync(30000);
      await stopping;
    }
  });

  it("surfaces a server conflict to direct callers", async () => {
    fetchMock.mockImplementation(async () => response({ error: "stale claim" }, 409));
    const client = new Orch8Client({ baseUrl: "http://engine" });
    await expect(client.completeTask(task.id, { worker_id: "phone-1", claim_epoch: 7 }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("includes the epoch when a handler fails", async () => {
    fetchMock.mockResolvedValueOnce(response(envelope));
    fetchMock.mockImplementation(async () => response({}));
    const failed = vi.fn();
    const worker = new Orch8Worker({ engineUrl: "http://engine", workerId: "phone-1",
      handlers: { inspect: async () => { throw new Error("invalid input"); } }, onTaskFail: failed });
    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/fail"));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      worker_id: "phone-1", claim_epoch: 7, message: "invalid input", retryable: false,
    });
    expect(failed).toHaveBeenCalledTimes(1);
    const stopping = worker.stop();
    await vi.advanceTimersByTimeAsync(30000);
    await stopping;
  });
});
