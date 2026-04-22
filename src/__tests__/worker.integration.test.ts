import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Orch8Worker } from "../worker.js";
import { Orch8Client } from "../client.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe("Orch8Worker integration", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function stopWorker(worker: Orch8Worker): Promise<void> {
    const stopping = worker.stop();
    await vi.advanceTimersByTimeAsync(35_000);
    await stopping;
  }

  it("end-to-end with real fetch mocking", async () => {
    const handler = vi.fn().mockResolvedValue({ done: true });

    const worker = new Orch8Worker({
      engineUrl: "http://localhost:8080",
      workerId: "w-1",
      handlers: { "my-handler": handler },
      pollIntervalMs: 100,
    });

    // First poll returns a task.
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        {
          id: "wt-e2e",
          instance_id: "inst-1",
          block_id: "b-1",
          handler_name: "my-handler",
          state: "claimed",
          created_at: "2025-01-01T00:00:00Z",
        },
      ]),
    );
    // Complete task.
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    // Subsequent polls empty.
    mockFetch.mockResolvedValue(jsonResponse([]));

    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(1);

    const completeCall = mockFetch.mock.calls.find(
      (c) => c[0] === "http://localhost:8080/workers/tasks/wt-e2e/complete",
    );
    expect(completeCall).toBeDefined();

    await stopWorker(worker);
  });

  it("end-to-end with Orch8Client delegation", async () => {
    const client = new Orch8Client({ baseUrl: "http://localhost:8080" });
    const handler = vi.fn().mockResolvedValue({ done: true });

    const pollSpy = vi
      .spyOn(client, "pollTasks")
      .mockResolvedValue([
        {
          id: "wt-client",
          instance_id: "inst-1",
          block_id: "b-1",
          handler_name: "h",
          state: "claimed",
          created_at: "2025-01-01T00:00:00Z",
        } as any,
      ]);
    const completeSpy = vi
      .spyOn(client, "completeTask")
      .mockResolvedValue(undefined);

    const worker = new Orch8Worker({
      client,
      workerId: "w-2",
      handlers: { h: handler },
      pollIntervalMs: 100,
    });

    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(100);
    vi.runAllTicks();

    expect(pollSpy).toHaveBeenCalledWith({
      handler_name: "h",
      worker_id: "w-2",
      limit: 10,
    });
    expect(completeSpy).toHaveBeenCalled();

    await stopWorker(worker);
    pollSpy.mockRestore();
    completeSpy.mockRestore();
  });

  it("handles missing handler by calling failTask", async () => {
    const worker = new Orch8Worker({
      engineUrl: "http://localhost:8080",
      workerId: "w-1",
      handlers: { known: async () => ({}) }, // task will have handler_name "missing" — not registered
      pollIntervalMs: 100,
    });

    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        {
          id: "wt-missing",
          instance_id: "inst-1",
          block_id: "b-1",
          handler_name: "missing",
          state: "claimed",
          created_at: "2025-01-01T00:00:00Z",
        },
      ]),
    );
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true })); // failTask
    mockFetch.mockResolvedValue(jsonResponse([]));

    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(100);
    vi.runAllTicks();

    const failCall = mockFetch.mock.calls.find(
      (c) => c[0] === "http://localhost:8080/workers/tasks/wt-missing/fail",
    );
    expect(failCall).toBeDefined();

    await stopWorker(worker);
  });
});
