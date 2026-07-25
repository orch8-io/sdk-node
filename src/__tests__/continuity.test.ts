import { beforeEach, describe, expect, it, vi } from "vitest";

import { Orch8Client } from "../client.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const response = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as Response;

describe("continuity API", () => {
  let client: Orch8Client;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new Orch8Client({ baseUrl: "https://engine.test" });
  });

  it("encodes identifiers and tenant query values", async () => {
    mockFetch.mockResolvedValueOnce(response({ id: "execution/1" }));
    await client.continuity.getExecution("execution/1", "tenant + one");

    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://engine.test/continuity/executions/execution%2F1?tenant_id=tenant+%2B+one",
    );
  });

  it("posts portable handoff requests", async () => {
    mockFetch.mockResolvedValueOnce(response({ id: "handoff-1" }));
    await client.continuity.createHandoff({ execution_id: "execution-1" });

    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://engine.test/continuity/handoffs",
    );
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      execution_id: "execution-1",
    });
  });

  it("rejects protocol-relative paths in the low-level API", async () => {
    await expect(client.request("GET", "//untrusted.test/path")).rejects.toThrow(
      "exactly one '/'",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
