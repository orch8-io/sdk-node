import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orch8Client, Orch8Error } from "../client.js";

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

function networkError(): Response {
  throw new Error("network error");
}

describe("Orch8Client integration / edge cases", () => {
  let client: Orch8Client;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new Orch8Client({
      baseUrl: "http://localhost:8080",
      tenantId: "tenant-1",
    });
  });

  it("retries are not built-in but network errors surface immediately", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(client.health()).rejects.toThrow("ECONNREFUSED");
  });

  it("handles 500 with HTML body gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve("<html>bad gateway</html>"),
    } as unknown as Response);

    await expect(client.health()).rejects.toBeInstanceOf(Orch8Error);
  });

  it("sends Accept header on every request", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    await client.health();

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Accept).toBe("application/json");
  });

  it("handles empty 200 body as undefined", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error("empty")),
      text: () => Promise.resolve(""),
    } as unknown as Response);

    const result = await client.updateInstanceState("inst-1", { state: "done" });
    expect(result).toBeUndefined();
  });

  it("handles 204 as undefined", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: () => Promise.reject(new Error("no body")),
      text: () => Promise.resolve(""),
    } as unknown as Response);

    const result = await client.deleteSequence("seq-1");
    expect(result).toBeUndefined();
  });

  it("passes extra headers to every request", async () => {
    const authed = new Orch8Client({
      baseUrl: "http://localhost:8080",
      headers: { "X-Custom": "val" },
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    await authed.health();

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["X-Custom"]).toBe("val");
  });
});
