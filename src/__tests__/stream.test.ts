import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orch8Client } from "../client.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function streamResponse(chunks: string[]): Response {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => {
          if (index >= chunks.length) {
            return Promise.resolve({ done: true, value: undefined });
          }
          const chunk = encoder.encode(chunks[index++]);
          return Promise.resolve({ done: false, value: chunk });
        },
        releaseLock: () => {},
      }),
    },
  } as unknown as Response;
}

describe("streamInstance", () => {
  let client: Orch8Client;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new Orch8Client({
      baseUrl: "http://localhost:8080",
      tenantId: "tenant-1",
    });
  });

  it("parses SSE data lines into JSON objects", async () => {
    mockFetch.mockResolvedValueOnce(
      streamResponse([
        'data: {"event":"start"}\n\n',
        'data: {"event":"step"}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const events: Record<string, unknown>[] = [];
    for await (const ev of client.streamInstance("inst-1")) {
      events.push(ev);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ event: "start" });
    expect(events[1]).toEqual({ event: "step" });
  });

  it("sends Accept: text/event-stream header", async () => {
    mockFetch.mockResolvedValueOnce(streamResponse([]));

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of client.streamInstance("inst-1")) {
      /* noop */
    }

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Accept).toBe("text/event-stream");
    expect(init.headers["X-Tenant-Id"]).toBe("tenant-1");
  });

  it("throws Orch8Error on non-OK response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "not found" }),
      text: () => Promise.resolve('{"error":"not found"}'),
    } as unknown as Response);

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.streamInstance("inst-1")) {
        /* noop */
      }
    }).rejects.toThrow("Orch8 API error 404");
  });
});
