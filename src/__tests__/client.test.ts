import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orch8Client, Orch8Error } from "../client.js";

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

function noContentResponse(): Response {
  return {
    ok: true,
    status: 204,
    json: () => Promise.reject(new Error("no body")),
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

function emptyBodyResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.reject(new Error("no body")),
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

function errorResponse(status: number, body: unknown = { error: "not found" }): Response {
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

describe("Orch8Client", () => {
  let client: Orch8Client;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new Orch8Client({
      baseUrl: "http://localhost:8080",
      tenantId: "tenant-1",
      namespace: "default",
    });
  });

  // ---- Header tests -------------------------------------------------------

  describe("Headers", () => {
    it("sends X-Tenant-Id header when configured", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "seq-1" }));
      await client.getSequence("seq-1");

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers["X-Tenant-Id"]).toBe("tenant-1");
    });

    it("does not send X-Tenant-Id header when not configured", async () => {
      const bare = new Orch8Client({ baseUrl: "http://localhost:8080" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "seq-1" }));
      await bare.getSequence("seq-1");

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers["X-Tenant-Id"]).toBeUndefined();
    });

    it("sends custom Authorization header on every request", async () => {
      const authed = new Orch8Client({
        baseUrl: "http://localhost:8080",
        headers: { Authorization: "Bearer my-key" },
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "seq-1" }));
      await authed.getSequence("seq-1");

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers["Authorization"]).toBe("Bearer my-key");
    });
  });

  // ---- Empty body handling ------------------------------------------------

  describe("Empty body handling", () => {
    it("returns undefined when 200 response has empty text body", async () => {
      mockFetch.mockResolvedValueOnce(emptyBodyResponse());
      const result = await client.updateInstanceState("inst-1", { state: "running" });
      expect(result).toBeUndefined();
    });
  });

  // ---- Error handling -----------------------------------------------------

  describe("Error handling", () => {
    it("throws Orch8Error on 404", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404));
      await expect(client.getSequence("nonexistent")).rejects.toThrow(Orch8Error);
    });

    it("Orch8Error carries status and path", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404));
      try {
        await client.getSequence("nonexistent");
      } catch (err) {
        expect(err).toBeInstanceOf(Orch8Error);
        const orch8Err = err as Orch8Error;
        expect(orch8Err.status).toBe(404);
        expect(orch8Err.path).toBe("/sequences/nonexistent");
      }
    });

    it("handles 204 No Content as undefined", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());
      const result = await client.deleteTrigger("t-1");
      expect(result).toBeUndefined();
    });
  });

  // ---- Sequences ----------------------------------------------------------

  describe("Sequences", () => {
    it("createSequence POSTs to /sequences", async () => {
      const seq = { id: "seq-1", name: "my-seq", version: 1 };
      mockFetch.mockResolvedValueOnce(jsonResponse(seq));

      const result = await client.createSequence({ name: "my-seq", blocks: [] });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/sequences");
      expect(init.method).toBe("POST");
      expect(result).toEqual(seq);
    });

    it("getSequence GETs /sequences/:id", async () => {
      const seq = { id: "seq-1", name: "my-seq" };
      mockFetch.mockResolvedValueOnce(jsonResponse(seq));

      const result = await client.getSequence("seq-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/sequences/seq-1");
      expect(init.method).toBe("GET");
      expect(result).toEqual(seq);
    });

    it("getSequenceByName GETs /sequences/by-name with query params", async () => {
      const seq = { id: "seq-1", name: "my-seq" };
      mockFetch.mockResolvedValueOnce(jsonResponse(seq));

      const result = await client.getSequenceByName("t1", "ns1", "my-seq");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "http://localhost:8080/sequences/by-name?tenant_id=t1&namespace=ns1&name=my-seq",
      );
      expect(init.method).toBe("GET");
      expect(result).toEqual(seq);
    });

    it("getSequenceByName appends version when provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "seq-1" }));

      await client.getSequenceByName("t1", "ns1", "my-seq", 3);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("version=3");
    });

    it("deprecateSequence POSTs to /sequences/:id/deprecate and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(emptyBodyResponse());

      const result = await client.deprecateSequence("seq-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/sequences/seq-1/deprecate");
      expect(init.method).toBe("POST");
      expect(result).toBeUndefined();
    });

    it("listSequenceVersions GETs /sequences/versions with query params", async () => {
      const versions = [{ id: "seq-1", version: 1 }, { id: "seq-2", version: 2 }];
      mockFetch.mockResolvedValueOnce(jsonResponse(versions));

      const result = await client.listSequenceVersions("t1", "ns1", "my-seq");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "http://localhost:8080/sequences/versions?tenant_id=t1&namespace=ns1&name=my-seq",
      );
      expect(init.method).toBe("GET");
      expect(result).toEqual(versions);
    });
  });

  // ---- Instances ----------------------------------------------------------

  describe("Instances", () => {
    it("createInstance POSTs to /instances", async () => {
      const inst = { id: "inst-1", state: "pending" };
      mockFetch.mockResolvedValueOnce(jsonResponse(inst));

      const result = await client.createInstance({ sequence_id: "seq-1" });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances");
      expect(init.method).toBe("POST");
      expect(result).toEqual(inst);
    });

    it("batchCreateInstances POSTs to /instances/batch wrapping array in {instances:[...]}", async () => {
      const response = { created: 2, ids: ["inst-1", "inst-2"] };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      const result = await client.batchCreateInstances([
        { sequence_id: "seq-1" },
        { sequence_id: "seq-1" },
      ]);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/batch");
      expect(init.method).toBe("POST");
      const sentBody = JSON.parse(init.body as string);
      expect(sentBody).toHaveProperty("instances");
      expect(Array.isArray(sentBody.instances)).toBe(true);
      expect(result).toEqual(response);
    });

    it("getInstance GETs /instances/:id", async () => {
      const inst = { id: "inst-1", state: "running" };
      mockFetch.mockResolvedValueOnce(jsonResponse(inst));

      const result = await client.getInstance("inst-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/inst-1");
      expect(init.method).toBe("GET");
      expect(result).toEqual(inst);
    });

    it("listInstances GETs /instances without filter", async () => {
      const instances = [{ id: "inst-1" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(instances));

      const result = await client.listInstances();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances");
      expect(init.method).toBe("GET");
      expect(result).toEqual(instances);
    });

    it("listInstances GETs /instances?state=running with filter", async () => {
      const instances = [{ id: "inst-1", state: "running" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(instances));

      const result = await client.listInstances({ state: "running" });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances?state=running");
      expect(result).toEqual(instances);
    });

    it("updateInstanceState PATCHes /instances/:id/state and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(emptyBodyResponse());

      const result = await client.updateInstanceState("inst-1", { state: "paused" });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/inst-1/state");
      expect(init.method).toBe("PATCH");
      expect(result).toBeUndefined();
    });

    it("updateInstanceContext PATCHes /instances/:id/context and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(emptyBodyResponse());

      const result = await client.updateInstanceContext("inst-1", { key: "value" });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/inst-1/context");
      expect(init.method).toBe("PATCH");
      expect(result).toBeUndefined();
    });

    it("sendSignal POSTs to /instances/:id/signals and returns signal_id", async () => {
      const response = { signal_id: "sig-123" };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      const result = await client.sendSignal("inst-1", { type: "resume" });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/inst-1/signals");
      expect(init.method).toBe("POST");
      expect(result).toEqual(response);
    });

    it("getOutputs GETs /instances/:id/outputs", async () => {
      const outputs = [{ step: "step-1", output: {} }];
      mockFetch.mockResolvedValueOnce(jsonResponse(outputs));

      const result = await client.getOutputs("inst-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/inst-1/outputs");
      expect(init.method).toBe("GET");
      expect(result).toEqual(outputs);
    });

    it("getExecutionTree GETs /instances/:id/tree", async () => {
      const tree = [{ id: "node-1", children: [] }];
      mockFetch.mockResolvedValueOnce(jsonResponse(tree));

      const result = await client.getExecutionTree("inst-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/inst-1/tree");
      expect(init.method).toBe("GET");
      expect(result).toEqual(tree);
    });

    it("retryInstance POSTs to /instances/:id/retry", async () => {
      const inst = { id: "inst-1", state: "pending" };
      mockFetch.mockResolvedValueOnce(jsonResponse(inst));

      const result = await client.retryInstance("inst-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/inst-1/retry");
      expect(init.method).toBe("POST");
      expect(result).toEqual(inst);
    });

    it("listCheckpoints GETs /instances/:id/checkpoints", async () => {
      const checkpoints = [{ id: "cp-1" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(checkpoints));

      const result = await client.listCheckpoints("inst-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/inst-1/checkpoints");
      expect(init.method).toBe("GET");
      expect(result).toEqual(checkpoints);
    });

    it("saveCheckpoint POSTs to /instances/:id/checkpoints", async () => {
      const checkpoint = { id: "cp-1", data: {} };
      mockFetch.mockResolvedValueOnce(jsonResponse(checkpoint));

      const result = await client.saveCheckpoint("inst-1", { data: {} });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/inst-1/checkpoints");
      expect(init.method).toBe("POST");
      expect(result).toEqual(checkpoint);
    });

    it("getLatestCheckpoint GETs /instances/:id/checkpoints/latest", async () => {
      const checkpoint = { id: "cp-1" };
      mockFetch.mockResolvedValueOnce(jsonResponse(checkpoint));

      const result = await client.getLatestCheckpoint("inst-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/inst-1/checkpoints/latest");
      expect(init.method).toBe("GET");
      expect(result).toEqual(checkpoint);
    });

    it("pruneCheckpoints POSTs to /instances/:id/checkpoints/prune and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(emptyBodyResponse());

      const result = await client.pruneCheckpoints("inst-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/inst-1/checkpoints/prune");
      expect(init.method).toBe("POST");
      expect(result).toBeUndefined();
    });

    it("listAuditLog GETs /instances/:id/audit", async () => {
      const log = [{ event: "state_change" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(log));

      const result = await client.listAuditLog("inst-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/inst-1/audit");
      expect(init.method).toBe("GET");
      expect(result).toEqual(log);
    });

    it("bulkUpdateState PATCHes /instances/bulk/state", async () => {
      const response = { updated: 3 };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      const result = await client.bulkUpdateState({ ids: ["i1", "i2", "i3"], state: "paused" });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/bulk/state");
      expect(init.method).toBe("PATCH");
      expect(result).toEqual(response);
    });

    it("bulkReschedule PATCHes /instances/bulk/reschedule", async () => {
      const response = { rescheduled: 2 };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      const result = await client.bulkReschedule({ ids: ["i1", "i2"] });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/bulk/reschedule");
      expect(init.method).toBe("PATCH");
      expect(result).toEqual(response);
    });

    it("listDLQ GETs /instances/dlq", async () => {
      const dlq = [{ id: "inst-dead" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(dlq));

      const result = await client.listDLQ();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/dlq");
      expect(init.method).toBe("GET");
      expect(result).toEqual(dlq);
    });
  });

  // ---- Cron ---------------------------------------------------------------

  describe("Cron", () => {
    it("createCron POSTs to /cron", async () => {
      const cron = { id: "cron-1" };
      mockFetch.mockResolvedValueOnce(jsonResponse(cron));

      const result = await client.createCron({ schedule: "* * * * *" });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/cron");
      expect(init.method).toBe("POST");
      expect(result).toEqual(cron);
    });

    it("listCron GETs /cron without filter", async () => {
      const crons = [{ id: "cron-1" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(crons));

      const result = await client.listCron();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/cron");
      expect(init.method).toBe("GET");
      expect(result).toEqual(crons);
    });

    it("listCron GETs /cron?tenant_id=x with tenant filter", async () => {
      const crons = [{ id: "cron-1" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(crons));

      const result = await client.listCron("tenant-x");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/cron?tenant_id=tenant-x");
      expect(result).toEqual(crons);
    });

    it("getCron GETs /cron/:id", async () => {
      const cron = { id: "cron-1" };
      mockFetch.mockResolvedValueOnce(jsonResponse(cron));

      const result = await client.getCron("cron-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/cron/cron-1");
      expect(init.method).toBe("GET");
      expect(result).toEqual(cron);
    });

    it("updateCron PUTs to /cron/:id", async () => {
      const cron = { id: "cron-1", schedule: "0 * * * *" };
      mockFetch.mockResolvedValueOnce(jsonResponse(cron));

      const result = await client.updateCron("cron-1", { schedule: "0 * * * *" });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/cron/cron-1");
      expect(init.method).toBe("PUT");
      expect(result).toEqual(cron);
    });

    it("deleteCron DELETEs /cron/:id and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      const result = await client.deleteCron("cron-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/cron/cron-1");
      expect(init.method).toBe("DELETE");
      expect(result).toBeUndefined();
    });
  });

  // ---- Triggers -----------------------------------------------------------

  describe("Triggers", () => {
    it("createTrigger POSTs to /triggers", async () => {
      const trigger = { slug: "t-1", sequence_name: "my-seq" };
      mockFetch.mockResolvedValueOnce(jsonResponse(trigger));

      const result = await client.createTrigger({ slug: "t-1", sequence_name: "my-seq" });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/triggers");
      expect(init.method).toBe("POST");
      expect(result).toEqual(trigger);
    });

    it("listTriggers GETs /triggers", async () => {
      const triggers = [{ slug: "t-1" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(triggers));

      const result = await client.listTriggers();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/triggers");
      expect(init.method).toBe("GET");
      expect(result).toEqual(triggers);
    });

    it("getTrigger GETs /triggers/:slug", async () => {
      const trigger = { slug: "t-1" };
      mockFetch.mockResolvedValueOnce(jsonResponse(trigger));

      const result = await client.getTrigger("t-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/triggers/t-1");
      expect(init.method).toBe("GET");
      expect(result).toEqual(trigger);
    });

    it("deleteTrigger DELETEs /triggers/:slug and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      const result = await client.deleteTrigger("t-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/triggers/t-1");
      expect(init.method).toBe("DELETE");
      expect(result).toBeUndefined();
    });

    it("fireTrigger POSTs to /triggers/:slug/fire", async () => {
      const inst = { id: "inst-1" };
      mockFetch.mockResolvedValueOnce(jsonResponse(inst));

      const result = await client.fireTrigger("t-1", { data: "hello" });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/triggers/t-1/fire");
      expect(init.method).toBe("POST");
      expect(result).toEqual(inst);
    });
  });

  // ---- Plugins ------------------------------------------------------------

  describe("Plugins", () => {
    it("createPlugin POSTs to /plugins", async () => {
      const plugin = { name: "my-plugin" };
      mockFetch.mockResolvedValueOnce(jsonResponse(plugin));

      const result = await client.createPlugin({ name: "my-plugin" });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/plugins");
      expect(init.method).toBe("POST");
      expect(result).toEqual(plugin);
    });

    it("listPlugins GETs /plugins", async () => {
      const plugins = [{ name: "my-plugin" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(plugins));

      const result = await client.listPlugins();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/plugins");
      expect(init.method).toBe("GET");
      expect(result).toEqual(plugins);
    });

    it("getPlugin GETs /plugins/:name", async () => {
      const plugin = { name: "my-plugin" };
      mockFetch.mockResolvedValueOnce(jsonResponse(plugin));

      const result = await client.getPlugin("my-plugin");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/plugins/my-plugin");
      expect(init.method).toBe("GET");
      expect(result).toEqual(plugin);
    });

    it("updatePlugin PATCHes /plugins/:name", async () => {
      const plugin = { name: "my-plugin", version: "2.0" };
      mockFetch.mockResolvedValueOnce(jsonResponse(plugin));

      const result = await client.updatePlugin("my-plugin", { version: "2.0" });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/plugins/my-plugin");
      expect(init.method).toBe("PATCH");
      expect(result).toEqual(plugin);
    });

    it("deletePlugin DELETEs /plugins/:name and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      const result = await client.deletePlugin("my-plugin");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/plugins/my-plugin");
      expect(init.method).toBe("DELETE");
      expect(result).toBeUndefined();
    });
  });

  // ---- Sessions -----------------------------------------------------------

  describe("Sessions", () => {
    it("createSession POSTs to /sessions", async () => {
      const session = { id: "sess-1" };
      mockFetch.mockResolvedValueOnce(jsonResponse(session));

      const result = await client.createSession({ key: "my-key" });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/sessions");
      expect(init.method).toBe("POST");
      expect(result).toEqual(session);
    });

    it("getSession GETs /sessions/:id", async () => {
      const session = { id: "sess-1" };
      mockFetch.mockResolvedValueOnce(jsonResponse(session));

      const result = await client.getSession("sess-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/sessions/sess-1");
      expect(init.method).toBe("GET");
      expect(result).toEqual(session);
    });

    it("getSessionByKey GETs /sessions/by-key/:tenantId/:key", async () => {
      const session = { id: "sess-1" };
      mockFetch.mockResolvedValueOnce(jsonResponse(session));

      const result = await client.getSessionByKey("tenant-1", "my-key");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/sessions/by-key/tenant-1/my-key");
      expect(init.method).toBe("GET");
      expect(result).toEqual(session);
    });

    it("updateSessionData PATCHes /sessions/:id/data", async () => {
      const session = { id: "sess-1", data: { foo: "bar" } };
      mockFetch.mockResolvedValueOnce(jsonResponse(session));

      const result = await client.updateSessionData("sess-1", { foo: "bar" });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/sessions/sess-1/data");
      expect(init.method).toBe("PATCH");
      expect(result).toEqual(session);
    });

    it("updateSessionState PATCHes /sessions/:id/state", async () => {
      const session = { id: "sess-1", state: "active" };
      mockFetch.mockResolvedValueOnce(jsonResponse(session));

      const result = await client.updateSessionState("sess-1", { state: "active" });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/sessions/sess-1/state");
      expect(init.method).toBe("PATCH");
      expect(result).toEqual(session);
    });

    it("listSessionInstances GETs /sessions/:id/instances", async () => {
      const instances = [{ id: "inst-1" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(instances));

      const result = await client.listSessionInstances("sess-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/sessions/sess-1/instances");
      expect(init.method).toBe("GET");
      expect(result).toEqual(instances);
    });
  });

  // ---- Workers ------------------------------------------------------------

  describe("Workers", () => {
    it("pollTasks POSTs to /workers/tasks/poll", async () => {
      const tasks = [{ id: "task-1" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(tasks));

      const result = await client.pollTasks({ worker_id: "w-1", capacity: 5 });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/workers/tasks/poll");
      expect(init.method).toBe("POST");
      expect(result).toEqual(tasks);
    });

    it("completeTask POSTs to /workers/tasks/:id/complete and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(emptyBodyResponse());

      const result = await client.completeTask("task-1", { output: {} });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/workers/tasks/task-1/complete");
      expect(init.method).toBe("POST");
      expect(result).toBeUndefined();
    });

    it("failTask POSTs to /workers/tasks/:id/fail and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(emptyBodyResponse());

      const result = await client.failTask("task-1", { error: "oops" });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/workers/tasks/task-1/fail");
      expect(init.method).toBe("POST");
      expect(result).toBeUndefined();
    });

    it("heartbeatTask POSTs to /workers/tasks/:id/heartbeat and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(emptyBodyResponse());

      const result = await client.heartbeatTask("task-1", {});

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/workers/tasks/task-1/heartbeat");
      expect(init.method).toBe("POST");
      expect(result).toBeUndefined();
    });
  });

  // ---- Cluster ------------------------------------------------------------

  describe("Cluster", () => {
    it("listClusterNodes GETs /cluster/nodes", async () => {
      const nodes = [{ id: "node-1" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(nodes));

      const result = await client.listClusterNodes();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/cluster/nodes");
      expect(init.method).toBe("GET");
      expect(result).toEqual(nodes);
    });

    it("drainNode POSTs to /cluster/nodes/:id/drain and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(emptyBodyResponse());

      const result = await client.drainNode("node-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/cluster/nodes/node-1/drain");
      expect(init.method).toBe("POST");
      expect(result).toBeUndefined();
    });
  });

  // ---- Circuit Breakers ---------------------------------------------------

  describe("Circuit Breakers", () => {
    it("listCircuitBreakers GETs /circuit-breakers", async () => {
      const breakers = [{ handler: "my-handler" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(breakers));

      const result = await client.listCircuitBreakers();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/circuit-breakers");
      expect(init.method).toBe("GET");
      expect(result).toEqual(breakers);
    });

    it("getCircuitBreaker GETs /circuit-breakers/:handler", async () => {
      const breaker = { handler: "my-handler", state: "closed" };
      mockFetch.mockResolvedValueOnce(jsonResponse(breaker));

      const result = await client.getCircuitBreaker("my-handler");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/circuit-breakers/my-handler");
      expect(init.method).toBe("GET");
      expect(result).toEqual(breaker);
    });

    it("resetCircuitBreaker POSTs to /circuit-breakers/:handler/reset and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(emptyBodyResponse());

      const result = await client.resetCircuitBreaker("my-handler");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/circuit-breakers/my-handler/reset");
      expect(init.method).toBe("POST");
      expect(result).toBeUndefined();
    });
  });

  // ---- Sequences (additional) ----------------------------------------------

  describe("Sequences (additional)", () => {
    it("listSequences GETs /sequences without filter", async () => {
      const seqs = [{ id: "seq-1", name: "my-seq" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(seqs));

      const result = await client.listSequences();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/sequences");
      expect(init.method).toBe("GET");
      expect(result).toEqual(seqs);
    });

    it("listSequences GETs /sequences?namespace=ns1 with filter", async () => {
      const seqs = [{ id: "seq-1" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(seqs));

      const result = await client.listSequences({ namespace: "ns1" });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/sequences?namespace=ns1");
      expect(result).toEqual(seqs);
    });

    it("deleteSequence DELETEs /sequences/:id and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      const result = await client.deleteSequence("seq-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/sequences/seq-1");
      expect(init.method).toBe("DELETE");
      expect(result).toBeUndefined();
    });

    it("migrateInstance POSTs to /sequences/migrate-instance", async () => {
      const inst = { id: "inst-1", state: "running" };
      mockFetch.mockResolvedValueOnce(jsonResponse(inst));

      const result = await client.migrateInstance({
        instance_id: "inst-1",
        target_sequence_id: "seq-2",
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/sequences/migrate-instance");
      expect(init.method).toBe("POST");
      const sentBody = JSON.parse(init.body as string);
      expect(sentBody).toEqual({
        instance_id: "inst-1",
        target_sequence_id: "seq-2",
      });
      expect(result).toEqual(inst);
    });
  });

  // ---- Instances (additional) ---------------------------------------------

  describe("Instances (additional)", () => {
    it("injectBlocks POSTs to /instances/:id/inject-blocks and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(emptyBodyResponse());

      const result = await client.injectBlocks("inst-1", {
        blocks: [{ type: "task", handler: "my-handler" }],
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/instances/inst-1/inject-blocks");
      expect(init.method).toBe("POST");
      const sentBody = JSON.parse(init.body as string);
      expect(sentBody).toEqual({
        blocks: [{ type: "task", handler: "my-handler" }],
      });
      expect(result).toBeUndefined();
    });
  });

  // ---- Approvals ----------------------------------------------------------

  describe("Approvals", () => {
    it("listApprovals GETs /approvals without filter", async () => {
      const approvals = [{ id: "inst-1", state: "waiting_approval" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(approvals));

      const result = await client.listApprovals();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/approvals");
      expect(init.method).toBe("GET");
      expect(result).toEqual(approvals);
    });

    it("listApprovals GETs /approvals?state=pending with filter", async () => {
      const approvals = [{ id: "inst-1" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(approvals));

      const result = await client.listApprovals({ state: "pending" });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/approvals?state=pending");
      expect(result).toEqual(approvals);
    });
  });

  // ---- Workers (additional) -----------------------------------------------

  describe("Workers (additional)", () => {
    it("listWorkerTasks GETs /workers/tasks without filter", async () => {
      const tasks = [{ id: "task-1", handler_name: "my-handler" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(tasks));

      const result = await client.listWorkerTasks();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/workers/tasks");
      expect(init.method).toBe("GET");
      expect(result).toEqual(tasks);
    });

    it("listWorkerTasks GETs /workers/tasks?handler_name=foo with filter", async () => {
      const tasks = [{ id: "task-1" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(tasks));

      const result = await client.listWorkerTasks({ handler_name: "foo" });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/workers/tasks?handler_name=foo");
      expect(result).toEqual(tasks);
    });

    it("getWorkerTaskStats GETs /workers/tasks/stats", async () => {
      const stats = { total: 10, running: 3, pending: 7 };
      mockFetch.mockResolvedValueOnce(jsonResponse(stats));

      const result = await client.getWorkerTaskStats();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/workers/tasks/stats");
      expect(init.method).toBe("GET");
      expect(result).toEqual(stats);
    });

    it("pollTasksFromQueue POSTs to /workers/tasks/poll/queue", async () => {
      const tasks = [{ id: "task-1" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(tasks));

      const result = await client.pollTasksFromQueue({
        queue_name: "high-priority",
        worker_id: "w-1",
        limit: 5,
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/workers/tasks/poll/queue");
      expect(init.method).toBe("POST");
      const sentBody = JSON.parse(init.body as string);
      expect(sentBody).toEqual({
        queue_name: "high-priority",
        worker_id: "w-1",
        limit: 5,
      });
      expect(result).toEqual(tasks);
    });
  });

  // ---- Resource Pools -----------------------------------------------------

  describe("Resource Pools", () => {
    it("listPools GETs /pools without filter", async () => {
      const pools = [{ id: "pool-1", name: "gpu-pool" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(pools));

      const result = await client.listPools();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/pools");
      expect(init.method).toBe("GET");
      expect(result).toEqual(pools);
    });

    it("listPools GETs /pools?tenant_id=t1 with tenant filter", async () => {
      const pools = [{ id: "pool-1" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(pools));

      const result = await client.listPools("t1");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/pools?tenant_id=t1");
      expect(result).toEqual(pools);
    });

    it("createPool POSTs to /pools", async () => {
      const pool = { id: "pool-1", name: "gpu-pool" };
      mockFetch.mockResolvedValueOnce(jsonResponse(pool));

      const result = await client.createPool({ name: "gpu-pool", max_size: 10 });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/pools");
      expect(init.method).toBe("POST");
      const sentBody = JSON.parse(init.body as string);
      expect(sentBody).toEqual({ name: "gpu-pool", max_size: 10 });
      expect(result).toEqual(pool);
    });

    it("getPool GETs /pools/:id", async () => {
      const pool = { id: "pool-1", name: "gpu-pool" };
      mockFetch.mockResolvedValueOnce(jsonResponse(pool));

      const result = await client.getPool("pool-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/pools/pool-1");
      expect(init.method).toBe("GET");
      expect(result).toEqual(pool);
    });

    it("deletePool DELETEs /pools/:id and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      const result = await client.deletePool("pool-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/pools/pool-1");
      expect(init.method).toBe("DELETE");
      expect(result).toBeUndefined();
    });

    it("listPoolResources GETs /pools/:poolId/resources", async () => {
      const resources = [{ id: "res-1", pool_id: "pool-1" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(resources));

      const result = await client.listPoolResources("pool-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/pools/pool-1/resources");
      expect(init.method).toBe("GET");
      expect(result).toEqual(resources);
    });

    it("createPoolResource POSTs to /pools/:poolId/resources", async () => {
      const resource = { id: "res-1", pool_id: "pool-1" };
      mockFetch.mockResolvedValueOnce(jsonResponse(resource));

      const result = await client.createPoolResource("pool-1", {
        name: "gpu-0",
        capacity: 1,
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/pools/pool-1/resources");
      expect(init.method).toBe("POST");
      const sentBody = JSON.parse(init.body as string);
      expect(sentBody).toEqual({ name: "gpu-0", capacity: 1 });
      expect(result).toEqual(resource);
    });

    it("updatePoolResource PUTs to /pools/:poolId/resources/:resourceId", async () => {
      const resource = { id: "res-1", pool_id: "pool-1", capacity: 2 };
      mockFetch.mockResolvedValueOnce(jsonResponse(resource));

      const result = await client.updatePoolResource("pool-1", "res-1", {
        capacity: 2,
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/pools/pool-1/resources/res-1");
      expect(init.method).toBe("PUT");
      const sentBody = JSON.parse(init.body as string);
      expect(sentBody).toEqual({ capacity: 2 });
      expect(result).toEqual(resource);
    });

    it("deletePoolResource DELETEs /pools/:poolId/resources/:resourceId and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      const result = await client.deletePoolResource("pool-1", "res-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/pools/pool-1/resources/res-1");
      expect(init.method).toBe("DELETE");
      expect(result).toBeUndefined();
    });
  });

  // ---- Credentials --------------------------------------------------------

  describe("Credentials", () => {
    it("listCredentials GETs /credentials without filter", async () => {
      const creds = [{ id: "cred-1", name: "api-key" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(creds));

      const result = await client.listCredentials();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/credentials");
      expect(init.method).toBe("GET");
      expect(result).toEqual(creds);
    });

    it("listCredentials GETs /credentials?tenant_id=t1 with tenant filter", async () => {
      const creds = [{ id: "cred-1" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(creds));

      const result = await client.listCredentials("t1");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/credentials?tenant_id=t1");
      expect(result).toEqual(creds);
    });

    it("createCredential POSTs to /credentials", async () => {
      const cred = { id: "cred-1", name: "api-key" };
      mockFetch.mockResolvedValueOnce(jsonResponse(cred));

      const result = await client.createCredential({
        name: "api-key",
        value: "secret-123",
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/credentials");
      expect(init.method).toBe("POST");
      const sentBody = JSON.parse(init.body as string);
      expect(sentBody).toEqual({ name: "api-key", value: "secret-123" });
      expect(result).toEqual(cred);
    });

    it("getCredential GETs /credentials/:id", async () => {
      const cred = { id: "cred-1", name: "api-key" };
      mockFetch.mockResolvedValueOnce(jsonResponse(cred));

      const result = await client.getCredential("cred-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/credentials/cred-1");
      expect(init.method).toBe("GET");
      expect(result).toEqual(cred);
    });

    it("deleteCredential DELETEs /credentials/:id and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(noContentResponse());

      const result = await client.deleteCredential("cred-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/credentials/cred-1");
      expect(init.method).toBe("DELETE");
      expect(result).toBeUndefined();
    });

    it("updateCredential PATCHes /credentials/:id", async () => {
      const cred = { id: "cred-1", name: "api-key", value: "new-secret" };
      mockFetch.mockResolvedValueOnce(jsonResponse(cred));

      const result = await client.updateCredential("cred-1", {
        value: "new-secret",
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/credentials/cred-1");
      expect(init.method).toBe("PATCH");
      const sentBody = JSON.parse(init.body as string);
      expect(sentBody).toEqual({ value: "new-secret" });
      expect(result).toEqual(cred);
    });
  });

  // ---- Circuit Breakers (per-tenant) --------------------------------------

  describe("Circuit Breakers (per-tenant)", () => {
    it("listTenantCircuitBreakers GETs /tenants/:tenantId/circuit-breakers", async () => {
      const breakers = [{ handler: "my-handler", state: "closed" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(breakers));

      const result = await client.listTenantCircuitBreakers("tenant-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/tenants/tenant-1/circuit-breakers");
      expect(init.method).toBe("GET");
      expect(result).toEqual(breakers);
    });

    it("getTenantCircuitBreaker GETs /tenants/:tenantId/circuit-breakers/:handler", async () => {
      const breaker = { handler: "my-handler", state: "open" };
      mockFetch.mockResolvedValueOnce(jsonResponse(breaker));

      const result = await client.getTenantCircuitBreaker("tenant-1", "my-handler");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "http://localhost:8080/tenants/tenant-1/circuit-breakers/my-handler",
      );
      expect(init.method).toBe("GET");
      expect(result).toEqual(breaker);
    });

    it("resetTenantCircuitBreaker POSTs to /tenants/:tenantId/circuit-breakers/:handler/reset and returns undefined", async () => {
      mockFetch.mockResolvedValueOnce(emptyBodyResponse());

      const result = await client.resetTenantCircuitBreaker("tenant-1", "my-handler");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "http://localhost:8080/tenants/tenant-1/circuit-breakers/my-handler/reset",
      );
      expect(init.method).toBe("POST");
      expect(result).toBeUndefined();
    });
  });

  // ---- Health -------------------------------------------------------------

  describe("Health", () => {
    it("health GETs /health/ready", async () => {
      const response = { status: "ok" };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      const result = await client.health();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/health/ready");
      expect(init.method).toBe("GET");
      expect(result).toEqual(response);
    });
  });
});
