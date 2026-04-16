import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Orch8Worker } from "../worker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function errorResponse(status: number, body: unknown = { error: "fail" }): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Orch8Worker", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Stop the worker under fake timers by advancing enough for the drain timeout. */
  async function stopWorker(worker: Orch8Worker): Promise<void> {
    const stopping = worker.stop();
    // The stop() method has a 30s drain timeout via setTimeout; advance past it.
    await vi.advanceTimersByTimeAsync(35_000);
    await stopping;
  }

  // ---- Circuit breaker check ---------------------------------------------

  describe("Circuit breaker check", () => {
    it("skips polling when circuit breaker is open", async () => {
      const handler = vi.fn().mockResolvedValue({ ok: true });

      const worker = new Orch8Worker({
        engineUrl: "http://localhost:8080",
        workerId: "w-1",
        handlers: { "my-handler": handler },
        pollIntervalMs: 100,
        circuitBreakerCheck: true,
      });

      // Circuit breaker check returns open state.
      mockFetch.mockResolvedValueOnce(jsonResponse({ state: "open" }));

      await worker.start();
      // Initial poll fires at 0ms delay.
      await vi.advanceTimersByTimeAsync(0);

      // Only the circuit breaker GET should have been called, no poll POST.
      const calls = mockFetch.mock.calls;
      expect(calls.length).toBe(1);
      const [cbUrl, cbInit] = calls[0];
      expect(cbUrl).toBe("http://localhost:8080/circuit-breakers/my-handler");
      expect(cbInit.method).toBe("GET");

      await stopWorker(worker);
    });

    it("proceeds with polling when circuit breaker is closed", async () => {
      const handler = vi.fn().mockResolvedValue({ ok: true });

      const worker = new Orch8Worker({
        engineUrl: "http://localhost:8080",
        workerId: "w-1",
        handlers: { "my-handler": handler },
        pollIntervalMs: 100,
        circuitBreakerCheck: true,
      });

      // Circuit breaker check: closed.
      mockFetch.mockResolvedValueOnce(jsonResponse({ state: "closed" }));
      // Poll: returns empty tasks.
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await worker.start();
      await vi.advanceTimersByTimeAsync(0);

      const calls = mockFetch.mock.calls;
      expect(calls.length).toBe(2);

      // First: circuit breaker check.
      expect(calls[0][0]).toBe("http://localhost:8080/circuit-breakers/my-handler");

      // Second: poll.
      expect(calls[1][0]).toBe("http://localhost:8080/workers/tasks/poll");
      expect(calls[1][1].method).toBe("POST");

      await stopWorker(worker);
    });

    it("proceeds with polling when circuit breaker check fails", async () => {
      const handler = vi.fn().mockResolvedValue({ ok: true });

      const worker = new Orch8Worker({
        engineUrl: "http://localhost:8080",
        workerId: "w-1",
        handlers: { "my-handler": handler },
        pollIntervalMs: 100,
        circuitBreakerCheck: true,
      });

      // Circuit breaker check: network error.
      mockFetch.mockRejectedValueOnce(new Error("network error"));
      // Poll: returns empty tasks.
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await worker.start();
      await vi.advanceTimersByTimeAsync(0);

      const calls = mockFetch.mock.calls;
      expect(calls.length).toBe(2);
      expect(calls[1][0]).toBe("http://localhost:8080/workers/tasks/poll");

      await stopWorker(worker);
    });
  });

  // ---- Exponential backoff -----------------------------------------------

  describe("Exponential backoff", () => {
    it("increases poll interval on consecutive failures", async () => {
      const handler = vi.fn().mockResolvedValue({ ok: true });
      const pollIntervalMs = 1000;

      const worker = new Orch8Worker({
        engineUrl: "http://localhost:8080",
        workerId: "w-1",
        handlers: { "my-handler": handler },
        pollIntervalMs,
      });

      // First poll: fails with 500.
      mockFetch.mockResolvedValueOnce(errorResponse(500));
      // Second poll (after backoff): also fails.
      mockFetch.mockResolvedValueOnce(errorResponse(500));
      // Third poll (after larger backoff): succeeds with no tasks.
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await worker.start();

      // Initial poll fires at 0ms delay.
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // After 1 failure, backoff = pollIntervalMs * 2^1 = 2000ms.
      // Advance by less than 2000ms -- should NOT have polled again.
      await vi.advanceTimersByTimeAsync(1999);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance to 2000ms -- second poll fires.
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // After 2 consecutive failures, backoff = pollIntervalMs * 2^2 = 4000ms.
      await vi.advanceTimersByTimeAsync(3999);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      await stopWorker(worker);
    });

    it("resets backoff after a successful poll", async () => {
      const handler = vi.fn().mockResolvedValue({ ok: true });
      const pollIntervalMs = 1000;

      const worker = new Orch8Worker({
        engineUrl: "http://localhost:8080",
        workerId: "w-1",
        handlers: { "my-handler": handler },
        pollIntervalMs,
      });

      // First poll: fails.
      mockFetch.mockResolvedValueOnce(errorResponse(500));
      // Second poll (at 2000ms backoff): succeeds.
      mockFetch.mockResolvedValueOnce(jsonResponse([]));
      // Third poll (should be back to base interval 1000ms): succeeds.
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await worker.start();

      // Initial poll at 0ms.
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Backoff 2000ms after failure.
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // After success, next poll should be at base interval (1000ms), not 4000ms.
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      await stopWorker(worker);
    });

    it("caps backoff at MAX_BACKOFF_MS (30s)", async () => {
      const handler = vi.fn().mockResolvedValue({ ok: true });
      const pollIntervalMs = 1000;

      const worker = new Orch8Worker({
        engineUrl: "http://localhost:8080",
        workerId: "w-1",
        handlers: { "my-handler": handler },
        pollIntervalMs,
      });

      // Simulate many consecutive failures to exceed 30s.
      // After 5 failures: backoff = 1000 * 2^5 = 32000, capped to 30000.
      for (let i = 0; i < 6; i++) {
        mockFetch.mockResolvedValueOnce(errorResponse(500));
      }

      await worker.start();

      // Poll 1 at 0ms.
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Poll 2 at 2000ms (backoff 2^1 * 1000).
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Poll 3 at 4000ms (backoff 2^2 * 1000).
      await vi.advanceTimersByTimeAsync(4000);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // Poll 4 at 8000ms (backoff 2^3 * 1000).
      await vi.advanceTimersByTimeAsync(8000);
      expect(mockFetch).toHaveBeenCalledTimes(4);

      // Poll 5 at 16000ms (backoff 2^4 * 1000).
      await vi.advanceTimersByTimeAsync(16000);
      expect(mockFetch).toHaveBeenCalledTimes(5);

      // Poll 6 at 30000ms (capped from 32000 to 30000).
      await vi.advanceTimersByTimeAsync(30000);
      expect(mockFetch).toHaveBeenCalledTimes(6);

      await stopWorker(worker);
    });
  });
});
