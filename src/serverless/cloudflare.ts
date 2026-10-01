import { drainOnce, serverlessWorkerId, type DrainOptions, type DrainResult } from "./drain.js";

/** Minimal Cloudflare `ExecutionContext`. */
export interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Minimal Cloudflare `ScheduledController`. */
export interface CloudflareScheduledController {
  scheduledTime?: number;
  cron?: string;
}

export interface CloudflareExecutorOptions extends Omit<DrainOptions, "deadlineMs"> {
  /**
   * Wall-clock budget per trigger. Workers expose no remaining-time API, so
   * set this below your plan's limit (CPU time for fetch, wall time for Cron
   * Triggers). Default: 25000 ms.
   */
  budgetMs?: number;
  /**
   * Shared secret for the `fetch` trigger (`Authorization: Bearer <secret>`,
   * `POST` only). Without it the fetch trigger answers 404, so a public
   * Worker URL cannot be used to drain your queue.
   */
  triggerSecret?: string;
}

export interface CloudflareExecutor<Env> {
  /** Cron Trigger entry point. */
  scheduled(controller: CloudflareScheduledController, env: Env, ctx?: CloudflareExecutionContext): Promise<void>;
  /** On-demand trigger (e.g. from a webhook or a queue push). */
  fetch(request: Request, env: Env, ctx?: CloudflareExecutionContext): Promise<Response>;
  /** Run one drain directly (both triggers use it). */
  drain(env: Env): Promise<DrainResult>;
}

function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Cloudflare Workers executor (module syntax). Uses only `fetch`, timers and
 * `AbortController` — no Node APIs, no `nodejs_compat` flag. Import it, and
 * the client, from `@orch8.io/sdk/serverless`:
 *
 * ```ts
 * import { Orch8Client, createCloudflareExecutor } from "@orch8.io/sdk/serverless";
 *
 * export default createCloudflareExecutor((env: Env) => ({
 *   client: new Orch8Client({ baseUrl: env.ORCH8_URL, headers: { "x-api-key": env.ORCH8_API_KEY } }),
 *   handlers: { "enrich-lead": async (task) => enrich(task.params) },
 *   triggerSecret: env.ORCH8_TRIGGER_SECRET,
 * }));
 * ```
 *
 * Options may be a function of `env` (bindings); they are built once per
 * `env` object. Capability advertisements default to `kind: "edge"`.
 */
export function createCloudflareExecutor<Env extends object = Record<string, unknown>>(
  options: CloudflareExecutorOptions | ((env: Env) => CloudflareExecutorOptions),
): CloudflareExecutor<Env> {
  const cache = new WeakMap<object, CloudflareExecutorOptions & { workerId: string }>();
  let fixed: (CloudflareExecutorOptions & { workerId: string }) | undefined;

  const resolve = (env: Env): CloudflareExecutorOptions & { workerId: string } => {
    if (typeof options !== "function") {
      fixed ??= { ...options, workerId: options.workerId ?? serverlessWorkerId("cf") };
      return fixed;
    }
    const key = (env ?? {}) as object;
    let built = cache.get(key);
    if (!built) {
      const o = options(env);
      built = { ...o, workerId: o.workerId ?? serverlessWorkerId("cf") };
      cache.set(key, built);
    }
    return built;
  };

  const drain = (env: Env): Promise<DrainResult> => {
    const { budgetMs = 25_000, triggerSecret: _secret, ...rest } = resolve(env);
    const now = rest.now ?? Date.now;
    return drainOnce({
      defaultKind: "edge",
      ...rest,
      deadlineMs: now() + Math.max(0, budgetMs),
    });
  };

  return {
    drain,
    async scheduled(_controller, env, ctx) {
      const run = drain(env);
      ctx?.waitUntil(run);
      await run;
    },
    async fetch(request, env) {
      const { triggerSecret } = resolve(env);
      if (!triggerSecret) return json(404, { error: "fetch_trigger_disabled" });
      if (request.method.toUpperCase() !== "POST") {
        return json(405, { error: "method_not_allowed" }, { allow: "POST" });
      }
      const auth = request.headers.get("authorization") ?? "";
      const presented = auth.replace(/^Bearer\s+/i, "");
      if (!auth || !constantTimeEqual(presented, triggerSecret)) {
        return json(401, { error: "unauthorized" });
      }
      const result = await drain(env);
      return json(result.stoppedBy === "poll_error" ? 502 : 200, result);
    },
  };
}
