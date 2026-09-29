// @vitest-environment jsdom
/**
 * End-to-end: `BrowserWorker` in a jsdom page against a REAL Orch8 engine.
 *
 * Skipped unless both are set:
 *   ORCH8_E2E_URL          engine base URL, e.g. http://127.0.0.1:18480
 *   ORCH8_E2E_ADMIN_KEY    the engine's root API key (ORCH8_API_KEY)
 * Optional:
 *   ORCH8_E2E_ALLOWED_ORIGIN  an origin listed in the engine's ORCH8_CORS_ORIGINS
 *                             (default http://localhost:5173)
 *
 * Run with `npm run test:e2e:browser`.
 *
 * jsdom has no `Worker`, so every BrowserWorker runs its lease loop with
 * `mode: "main"` (the documented fallback); handlers, page-data helpers,
 * lifecycle listeners and the lease protocol are the same code paths.
 * Requests go over Node's real `fetch`. Node does not enforce CORS, so the
 * CORS scenario checks the engine's preflight responses directly.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Orch8Client } from "../../src/client.js";
import {
  BrowserWorker,
  readForm,
  querySelectorText,
  querySelectorAllText,
  type BrowserTaskContext,
  type BrowserWorkerEvent,
  type BrowserWorkerOptions,
} from "../../src/browser/index.js";

const BASE_URL = (process.env.ORCH8_E2E_URL ?? "").replace(/\/$/, "");
const ADMIN_KEY = process.env.ORCH8_E2E_ADMIN_KEY ?? "";
const ALLOWED_ORIGIN = process.env.ORCH8_E2E_ALLOWED_ORIGIN ?? "http://localhost:5173";
const enabled = BASE_URL !== "" && ADMIN_KEY !== "";

const CREDENTIAL_DISPATCH_ERROR = "steps placed on browser runtimes cannot receive credentials";

// ---------------------------------------------------------------------------
// Real fetch, bridged for jsdom
// ---------------------------------------------------------------------------

// Under the jsdom environment `AbortController` is jsdom's, which Node's
// fetch (undici) rejects as a foreign signal. Bridge the abort by racing it.
const nodeFetch: typeof fetch = globalThis.fetch.bind(globalThis);
const realFetch: typeof fetch = (input, init = {}) => {
  const { signal, ...rest } = init;
  const request = nodeFetch(input, rest);
  if (!signal) return request;
  return new Promise<Response>((resolve, reject) => {
    if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    request.then(resolve, reject);
  });
};

interface Exchange {
  path: string;
  method: string;
  requestBody: unknown;
  status: number;
  responseText: string;
}

/** A fetch that records every exchange (the whole raw payload the tab received). */
function recordingFetch(onResponse?: (exchange: Exchange) => void) {
  const exchanges: Exchange[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const response = await realFetch(input, init);
    const text = response.status === 204 ? "" : await response.clone().text();
    let requestBody: unknown = null;
    try {
      requestBody = typeof init.body === "string" ? JSON.parse(init.body) : null;
    } catch {
      requestBody = init.body;
    }
    const exchange: Exchange = {
      path: url.slice(BASE_URL.length),
      method: init.method ?? "GET",
      requestBody,
      status: response.status,
      responseText: text,
    };
    exchanges.push(exchange);
    onResponse?.(exchange);
    return response;
  };
  return { fetch: fetchImpl, exchanges };
}

function polledTasks(exchange: Exchange): unknown[] {
  if (exchange.path !== "/workers/tasks/poll" || exchange.status !== 200) return [];
  const body = JSON.parse(exchange.responseText) as { tasks?: unknown[] };
  return body.tasks ?? [];
}

async function raw(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; text: string; headers: Headers }> {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json", ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await realFetch(`${BASE_URL}${path}`, init);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== undefined && value !== null && value !== false) return value as T;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Backend (Node, admin key) + page (jsdom) fixtures
// ---------------------------------------------------------------------------

function suffix(): string {
  return randomUUID().slice(0, 8);
}

function backend(tenantId: string): Orch8Client {
  return new Orch8Client({
    baseUrl: BASE_URL,
    tenantId,
    headers: { "x-api-key": ADMIN_KEY },
    retry: false,
    fetch: realFetch,
  });
}

function step(id: string, handler: string, params: Record<string, unknown> = {}) {
  return { type: "step", id, handler, params };
}

async function runSequence(
  client: Orch8Client,
  name: string,
  blocks: unknown[],
  context?: Record<string, unknown>,
): Promise<string> {
  const sequence = await client.createSequence({ name: `${name}-${suffix()}`, blocks });
  const instance = await client.createInstance({
    sequence_id: sequence.id,
    ...(context ? { context } : {}),
  });
  return instance.id;
}

async function waitForState(client: Orch8Client, instanceId: string, states: string[], timeoutMs = 20_000): Promise<string> {
  return waitFor(`instance ${instanceId} in ${states.join("|")}`, async () => {
    const instance = await client.getInstance(instanceId);
    return states.includes(instance.state) ? instance.state : undefined;
  }, timeoutMs);
}

function tokenRuntimeId(token: string): string {
  const payload = token.slice("bst_".length).split(".")[0];
  return (JSON.parse(Buffer.from(payload, "base64url").toString()) as { runtime_id: string }).runtime_id;
}

const workers: BrowserWorker[] = [];

interface PageWorker {
  worker: BrowserWorker;
  events: BrowserWorkerEvent[];
  tokenCalls: () => number;
  tokens: string[];
  exchanges: Exchange[];
}

type PageWorkerOptions = Partial<BrowserWorkerOptions> & { ttlSecs?: number; onExchange?: (e: Exchange) => void };

function pageWorker(
  client: Orch8Client,
  handlers: string[],
  register: (worker: BrowserWorker) => void,
  options: PageWorkerOptions = {},
): PageWorker {
  const events: BrowserWorkerEvent[] = [];
  const tokens: string[] = [];
  let calls = 0;
  const { ttlSecs, onExchange, onEvent, ...rest } = options;
  const recorder = recordingFetch(onExchange);
  const worker = new BrowserWorker({
    baseUrl: BASE_URL,
    mode: "main",
    pollIntervalMs: 200,
    maxBackoffMs: 1_000,
    // The page asks ITS backend for a token; here the backend is the admin client.
    getToken: async () => {
      calls += 1;
      const session = await client.createBrowserSession({ handlers, ttlSecs: ttlSecs ?? 600 });
      tokens.push(session.token);
      return session;
    },
    fetch: recorder.fetch,
    onEvent: (event) => {
      events.push(event);
      onEvent?.(event);
    },
    ...rest,
  });
  register(worker);
  workers.push(worker);
  return { worker, events, tokenCalls: () => calls, tokens, exchanges: recorder.exchanges };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  for (const child of children) node.append(child);
  return node;
}

function renderCheckoutPage(): void {
  const express = el("option", { value: "exp" }, ["Express"]);
  express.selected = true;
  const gift = el("input", { name: "gift", type: "checkbox", value: "yes" });
  gift.checked = true;
  document.body.replaceChildren(
    el("h1", { id: "title" }, ["Order #42"]),
    el("ul", { class: "items" }, [el("li", {}, ["Keyboard"]), el("li", {}, ["Mouse"])]),
    el("form", { id: "checkout" }, [
      el("input", { name: "name", value: "Ada Lovelace" }),
      el("input", { name: "email", type: "email", value: "ada@example.com" }),
      el("input", { name: "password", type: "password", value: "hunter2" }),
      el("input", { name: "csrf", type: "hidden", value: "csrf-123" }),
      gift,
      el("select", { name: "shipping" }, [el("option", { value: "std" }, ["Standard"]), express]),
      el("textarea", { name: "note" }, ["Leave at the door"]),
    ]),
  );
}

/** The browser step handler of the happy path: form values plus some DOM text. */
async function readPage(input: unknown) {
  return {
    form: readForm("#checkout"),
    title: querySelectorText("#title"),
    items: querySelectorAllText(".items li"),
    input,
  };
}

afterEach(async () => {
  while (workers.length > 0) {
    const worker = workers.pop()!;
    await worker.stop("test_done").catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------

describe.skipIf(!enabled)("BrowserWorker against a real engine", () => {
  beforeAll(async () => {
    const health = await realFetch(`${BASE_URL}/health/ready`);
    expect(health.ok, `engine at ${BASE_URL} is not ready`).toBe(true);
    renderCheckoutPage();
  });

  it("1. happy path: server builtin → browser read_page → server builtin that uses the page data", { timeout: 60_000 }, async () => {
    renderCheckoutPage();
    const client = backend(`bw-happy-${suffix()}`);
    const handler = "read_page";
    const page = pageWorker(client, [handler], (w) => w.register(handler, readPage));
    await page.worker.start();

    const instanceId = await runSequence(client, "bw-happy", [
      step("A", "log", { message: "hello from the server" }),
      step("B", handler, { greeting: "{{outputs.A.message}}", $runtime: { runtime_kinds: ["browser"] } }),
      step("C", "log", { message: "{{outputs.B.form.email}} | {{outputs.B.title}} | {{outputs.B.form.shipping}}" }),
    ]);
    expect(await waitForState(client, instanceId, ["completed", "failed"])).toBe("completed");

    const outputs = await client.getOutputs(instanceId);
    const byBlock = new Map(outputs.map((o) => [o.block_id, o.output as Record<string, any>]));
    const b = byBlock.get("B")!;
    expect(b.form).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      gift: "yes",
      shipping: "exp",
      note: "Leave at the door",
    });
    expect(b.title).toBe("Order #42");
    expect(b.items).toEqual(["Keyboard", "Mouse"]);
    // `$runtime` is stripped from the params the handler sees; templates resolve.
    expect(b.input).toEqual({ greeting: "hello from the server" });
    expect(byBlock.get("C")!.message).toBe("ada@example.com | Order #42 | exp");

    // Provenance: the audit log records the browser runtime that produced B.
    const runtimeId = tokenRuntimeId(page.tokens[0]);
    const audit = (await client.listAuditLog(instanceId)) as unknown as Array<Record<string, any>>;
    const provenance = audit.find((entry) => entry.event_type === "worker_output_provenance" && entry.block_id === "B");
    expect(provenance, JSON.stringify(audit.map((e) => e.event_type))).toBeTruthy();
    expect(provenance!.details.runtime_kind).toBe("browser");
    expect(provenance!.details.runtime_id).toBe(runtimeId);
    expect(provenance!.details.untrusted_page_data).toBe(true);
    expect(page.events.some((e) => e.type === "task_completed")).toBe(true);
  });

  it("2a. no secrets: a browser-placed step referencing a credential fails at dispatch and never reaches the tab", { timeout: 60_000 }, async () => {
    const tenantId = `bw-secret-${suffix()}`;
    const client = backend(tenantId);
    const credentialId = `cred-${suffix()}`;
    await client.createCredential({ id: credentialId, name: "stripe", kind: "api_key", value: `sk_live_${suffix()}`, tenant_id: tenantId });
    const handler = `form_${suffix()}`;
    const calls: unknown[] = [];
    const page = pageWorker(client, [handler], (w) =>
      w.register(handler, (input) => {
        calls.push(input);
        return {};
      }),
    );
    await page.worker.start();

    const instanceId = await runSequence(client, "bw-secret-placed", [
      step("form", handler, { api_key: `credentials://${credentialId}`, $runtime: { runtime_kinds: ["browser"] } }),
    ]);
    expect(await waitForState(client, instanceId, ["completed", "failed"])).toBe("failed");

    // Permanent: no worker task was ever created, and the tab never saw one.
    await sleep(1_500);
    expect(await waitForState(client, instanceId, ["failed"])).toBe("failed");
    const tasks = await client.listWorkerTasks({ handler_name: handler });
    expect(tasks).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(page.events.some((e) => e.type === "task_started")).toBe(false);
    const polls = page.exchanges.filter((e) => e.path === "/workers/tasks/poll");
    expect(polls.length).toBeGreaterThan(0);
    expect(polls.flatMap(polledTasks)).toEqual([]);
  });

  it("2a. no secrets: the dispatch failure records the documented reason where operators can see it", { timeout: 60_000 }, async () => {
    const tenantId = `bw-secret-reason-${suffix()}`;
    const client = backend(tenantId);
    const credentialId = `cred-${suffix()}`;
    await client.createCredential({ id: credentialId, name: "stripe", kind: "api_key", value: `sk_live_${suffix()}`, tenant_id: tenantId });
    const instanceId = await runSequence(client, "bw-secret-reason", [
      step("form", `form_${suffix()}`, { api_key: `credentials://${credentialId}`, $runtime: { runtime_kinds: ["browser"] } }),
    ]);
    expect(await waitForState(client, instanceId, ["completed", "failed"])).toBe("failed");
    const [instance, outputs, audit] = await Promise.all([
      client.getInstance(instanceId),
      client.getOutputs(instanceId),
      client.listAuditLog(instanceId),
    ]);
    expect(JSON.stringify({ instance, outputs, audit })).toContain(CREDENTIAL_DISPATCH_ERROR);
  });

  it("2b. no secrets: a server step uses a credential, the following browser step receives none of it", { timeout: 60_000 }, async () => {
    const tenantId = `bw-secret2-${suffix()}`;
    const client = backend(tenantId);
    const secret = `sk_live_${randomUUID().replace(/-/g, "")}`;
    const credentialId = `cred-${suffix()}`;
    await client.createCredential({ id: credentialId, name: "stripe", kind: "api_key", value: secret, tenant_id: tenantId });
    const serverHandler = `charge_${suffix()}`;
    const browserHandler = `confirm_${suffix()}`;

    let received: { params: unknown; ctx: BrowserTaskContext } | null = null;
    const page = pageWorker(client, [browserHandler], (w) =>
      w.register(browserHandler, (input, ctx) => {
        received = { params: input, ctx };
        return { confirmed: true };
      }),
    );
    await page.worker.start();

    const instanceId = await runSequence(
      client,
      "bw-secret-server-then-browser",
      [
        // Server builtin that resolves the credential.
        step("audit_key", "log", { message: `credentials://${credentialId}` }),
        // Server worker (the backend process) that uses the credential.
        step("charge", serverHandler, { api_key: `credentials://${credentialId}`, amount: 42 }),
        step("confirm", browserHandler, { amount: 42, $runtime: { runtime_kinds: ["browser"] } }),
      ],
      {
        data: { note: "public", stripe: `credentials://${credentialId}` },
        config: { stripe_secret: secret },
      },
    );

    // The backend's server worker claims the credential step and sees the secret.
    const serverTask = await waitFor("server task", async () => {
      const tasks = await client.pollTasks({ handler_name: serverHandler, worker_id: "backend-worker" });
      return tasks[0];
    });
    expect((serverTask.params as Record<string, unknown>).api_key).toBe(secret);
    await client.completeTask(serverTask.id, {
      worker_id: "backend-worker",
      claim_epoch: serverTask.claim_epoch,
      output: { charge_id: "ch_1", status: "succeeded" },
    });

    expect(await waitForState(client, instanceId, ["completed", "failed"])).toBe("completed");
    expect(received).not.toBeNull();
    const got = received as unknown as { params: unknown; ctx: BrowserTaskContext };
    const context = got.ctx.context as Record<string, any>;
    expect(context.config).toBeUndefined();
    expect(context.audit).toBeUndefined();
    expect(context.data?.note).toBe("public");
    expect(context.data?.stripe).toBeUndefined();
    expect(got.params).toEqual({ amount: 42 });

    // The whole payload the tab received (every poll response, every request
    // it made, and what the handler saw) never contains the secret.
    const everything = JSON.stringify({ exchanges: page.exchanges, params: got.params, context: got.ctx.context });
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(`credentials://${credentialId}`);
    expect(page.exchanges.flatMap(polledTasks)).toHaveLength(1);
  });

  it("3. token scope: the browser token only reaches its own lease protocol", { timeout: 30_000 }, async () => {
    const tenantId = `bw-scope-${suffix()}`;
    const client = backend(tenantId);
    const handler = `scoped_${suffix()}`;
    const session = await client.createBrowserSession({ handlers: [handler], ttlSecs: 120 });
    expect(session.token).toMatch(/^bst_/);
    const auth = { "x-api-key": session.token };
    const now = new Date();
    const caps = (kind: string, runtimeId: string) => ({
      runtime_id: runtimeId,
      kind,
      trust: "registered",
      handlers: [handler],
      offline_capable: false,
      observed_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 120_000).toISOString(),
    });

    const cases: Array<[string, string, string, unknown, number]> = [
      ["list tasks", "GET", "/workers/tasks", undefined, 403],
      ["worker commands", "POST", "/workers/commands", { worker_id: session.runtimeId, command: "drain" }, 403],
      ["create sequence", "POST", "/sequences", { id: randomUUID(), tenant_id: tenantId, namespace: "default", name: "x", version: 1, blocks: [] }, 403],
      ["mint another session", "POST", "/runtimes/browser-sessions", { handlers: [handler] }, 403],
      ["poll as another runtime_id", "POST", "/workers/tasks/poll", { handler_name: handler, worker_id: randomUUID() }, 403],
      ["poll advertising kind=server", "POST", "/workers/tasks/poll", { handler_name: handler, worker_id: session.runtimeId, capabilities: caps("server", session.runtimeId) }, 403],
      ["poll advertising another runtime_id", "POST", "/workers/tasks/poll", { handler_name: handler, worker_id: session.runtimeId, capabilities: caps("browser", randomUUID()) }, 403],
      ["poll a handler outside the allowlist", "POST", "/workers/tasks/poll", { handler_name: "charge_card", worker_id: session.runtimeId }, 403],
      ["poll a queue outside the allowlist", "POST", "/workers/tasks/poll/queue", { queue_name: "payments", handler_name: handler, worker_id: session.runtimeId }, 403],
      ["complete as another worker", "POST", `/workers/tasks/${randomUUID()}/complete`, { worker_id: "server-worker", claim_epoch: 1, output: {} }, 403],
    ];
    const results: Array<{ name: string; status: number; expected: number; text: string }> = [];
    for (const [name, method, path, body, expected] of cases) {
      const res = await raw(method, path, body, auth);
      results.push({ name, status: res.status, expected, text: res.text.slice(0, 200) });
    }
    expect(results.filter((r) => r.status !== r.expected)).toEqual([]);

    // The legitimate call works with the same token.
    const ok = await raw("POST", "/workers/tasks/poll", { handler_name: handler, worker_id: session.runtimeId }, auth);
    expect(ok.status).toBe(200);
    // A forged token (claims changed, signature kept) is 401.
    const [payload, signature] = session.token.slice(4).split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { handlers: string[] };
    claims.handlers.push("charge_card");
    const forged = `bst_${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
    const forgedPoll = await raw("POST", "/workers/tasks/poll", { handler_name: "charge_card", worker_id: session.runtimeId }, { "x-api-key": forged });
    expect(forgedPoll.status).toBe(401);
  });

  describe("4. tab close", () => {
    async function closeTabScenario(trigger: "during_poll" | "on_task_started") {
      const tenantId = `bw-close-${suffix()}`;
      const client = backend(tenantId);
      const handler = `close_${suffix()}`;
      const firstRuns: unknown[] = [];
      let fired = false;
      const releases: Exchange[] = [];
      const firstTab = pageWorker(
        client,
        [handler],
        (w) =>
          w.register(handler, (input) => {
            firstRuns.push(input);
            return { tab: "first" };
          }),
        {
          onExchange: (exchange) => {
            if (exchange.path.endsWith("/release")) releases.push(exchange);
            // The claim is committed server-side; the tab closes before the
            // poll response (and so the handler) is processed.
            if (trigger === "during_poll" && !fired && polledTasks(exchange).length > 0) {
              fired = true;
              window.dispatchEvent(new Event("pagehide"));
            }
          },
          onEvent: (event) => {
            // The facade has the task; the handler has not been invoked yet.
            if (trigger === "on_task_started" && !fired && event.type === "task_started") {
              fired = true;
              window.dispatchEvent(new Event("pagehide"));
            }
          },
        },
      );

      const instanceId = await runSequence(client, "bw-close", [step("B", handler, { $runtime: { runtime_kinds: ["browser"] } })]);
      await firstTab.worker.start();
      await waitFor("pagehide fired", async () => fired);
      const releasedAt = Date.now();
      const release = await waitFor("release request", async () => releases[0]);
      expect(release.status).toBe(204);
      expect((release.requestBody as { started: boolean }).started).toBe(false);

      // Back to pending right away — not after the 30 s browser lease.
      const pending = await waitFor("task back to pending", async () => {
        const tasks = await client.listWorkerTasks({ handler_name: handler });
        return tasks.find((t) => t.state === "pending");
      }, 5_000);
      expect(Date.now() - releasedAt).toBeLessThan(5_000);
      expect(pending.worker_id ?? null).toBeNull();
      expect(firstRuns).toHaveLength(0);
      await firstTab.worker.stop();
      expect(releases).toHaveLength(1);

      // Another tab (a new session) picks it up and completes it.
      const secondTab = pageWorker(client, [handler], (w) => w.register(handler, () => ({ tab: "second" })));
      await secondTab.worker.start();
      expect(await waitForState(client, instanceId, ["completed", "failed"])).toBe("completed");
      const outputs = await client.getOutputs(instanceId);
      expect(outputs.find((o) => o.block_id === "B")?.output).toEqual({ tab: "second" });
      expect(firstRuns).toHaveLength(0);
    }

    it("pagehide while the claiming poll is in flight releases with started=false", { timeout: 60_000 }, () =>
      closeTabScenario("during_poll"));

    it("pagehide after the tab received the task but before the handler ran releases with started=false", { timeout: 60_000 }, () =>
      closeTabScenario("on_task_started"));
  });

  it("5. token expiry and refresh: getToken is called again, work continues, an expired token is 401", { timeout: 60_000 }, async () => {
    const tenantId = `bw-ttl-${suffix()}`;
    const client = backend(tenantId);
    const handler = `ttl_${suffix()}`;
    const page = pageWorker(client, [handler], (w) => w.register(handler, () => ({ done: true })), { ttlSecs: 4 });
    await page.worker.start();
    const firstToken = page.tokens[0];

    // Outlive the first token.
    await sleep(6_000);
    expect(page.tokenCalls()).toBeGreaterThanOrEqual(2);
    expect(page.events.some((e) => e.type === "token_refreshed")).toBe(true);
    expect(page.worker.running).toBe(true);

    // Work created after the first token died still runs.
    const instanceId = await runSequence(client, "bw-ttl", [step("B", handler, { $runtime: { runtime_kinds: ["browser"] } })]);
    expect(await waitForState(client, instanceId, ["completed", "failed"])).toBe("completed");
    expect(page.exchanges.filter((e) => e.path.endsWith("/complete")).map((e) => e.status)).toEqual([200]);
    // The worker refreshed ahead of expiry: it never used a dead token.
    expect(page.exchanges.filter((e) => e.status === 401)).toEqual([]);

    // The expired token itself is refused.
    const expired = await raw("POST", "/workers/tasks/poll", { handler_name: handler, worker_id: tokenRuntimeId(firstToken) }, { "x-api-key": firstToken });
    expect(expired.status).toBe(401);
  });

  describe("6. oversized output", () => {
    const big = () => ({ blob: "x".repeat(1024 * 1024 + 512 * 1024) });

    async function oversized(options: PageWorkerOptions) {
      const tenantId = `bw-big-${suffix()}`;
      const client = backend(tenantId);
      const handler = `big_${suffix()}`;
      const page = pageWorker(client, [handler], (w) => w.register(handler, big), options);
      await page.worker.start();
      const instanceId = await runSequence(client, "bw-big", [step("B", handler, { $runtime: { runtime_kinds: ["browser"] } })]);
      expect(await waitForState(client, instanceId, ["completed", "failed"])).toBe("failed");
      const fails = await waitFor("fail ack", async () => {
        const list = page.exchanges.filter((e) => e.path.endsWith("/fail"));
        return list.length > 0 ? list : undefined;
      });
      expect(fails).toHaveLength(1);
      expect(fails[0].status).toBe(200);
      expect((fails[0].requestBody as { retryable: boolean }).retryable).toBe(false);

      // Nothing oversized was stored: no output for B, the task has no output, one attempt only.
      const outputs = await client.getOutputs(instanceId);
      const stored = outputs.find((o) => o.block_id === "B");
      expect(JSON.stringify(stored?.output ?? null).length).toBeLessThan(64 * 1024);
      const tasks = await client.listWorkerTasks({ handler_name: handler });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].state).toBe("failed");
      expect(tasks[0].error_retryable).toBe(false);
      expect(JSON.stringify(tasks[0].output ?? null).length).toBeLessThan(1024);
      return page;
    }

    it("is refused in the tab (client guard) as a non-retryable failure", { timeout: 60_000 }, async () => {
      const page = await oversized({});
      const failed = page.events.find((e) => e.type === "task_failed") as { retryable: boolean } | undefined;
      expect(failed?.retryable).toBe(false);
      expect(page.exchanges.filter((e) => e.path.endsWith("/complete"))).toHaveLength(0);
    });

    it("is refused by the engine (413) when the client guard is raised, and fails non-retryably", { timeout: 60_000 }, async () => {
      const page = await oversized({ maxOutputBytes: 16 * 1024 * 1024 });
      expect(page.exchanges.filter((e) => e.path.endsWith("/complete")).map((e) => e.status)).toEqual([413]);
      // The tab turned the 413 into a permanent failure instead of holding the claim until the lease expired.
      const [fail] = page.exchanges.filter((e) => e.path.endsWith("/fail"));
      expect((fail.requestBody as { message: string }).message).toMatch(/too large \(413\).*maximum is 1048576/);
    });
  });

  it("7. CORS: allowed origin passes the preflight with x-api-key; a disallowed origin is refused", { timeout: 30_000 }, async () => {
    const preflight = (origin: string) =>
      realFetch(`${BASE_URL}/workers/tasks/poll`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,x-api-key",
        },
      });
    const allowed = await preflight(ALLOWED_ORIGIN);
    expect(allowed.status).toBeLessThan(300);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect((allowed.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain("x-api-key");
    expect((allowed.headers.get("access-control-allow-methods") ?? "").toUpperCase()).toContain("POST");

    const denied = await preflight("https://evil.example");
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();

    // Actual requests: the allowed origin gets the header, a disallowed one does not.
    const client = backend(`bw-cors-${suffix()}`);
    const session = await client.createBrowserSession({ handlers: ["cors_probe"], ttlSecs: 60 });
    const body = { handler_name: "cors_probe", worker_id: session.runtimeId };
    const fromAllowed = await raw("POST", "/workers/tasks/poll", body, { "x-api-key": session.token, Origin: ALLOWED_ORIGIN });
    expect(fromAllowed.status).toBe(200);
    expect(fromAllowed.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    const fromDenied = await raw("POST", "/workers/tasks/poll", body, { "x-api-key": session.token, Origin: "https://evil.example" });
    expect(fromDenied.headers.get("access-control-allow-origin")).toBeNull();
  });
});
