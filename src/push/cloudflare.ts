import type { PushHandlerOptions } from "./core.js";
import { createWebPushHandler } from "./web.js";

/**
 * Cloudflare Workers module handler. Options are built from `env` on the first
 * request (secrets are bindings there) and cached per `env` object.
 *
 * ```ts
 * export default createCloudflarePushHandler((env) => ({
 *   client: new Orch8Client({ baseUrl: env.ORCH8_URL, headers: { "x-api-key": env.ORCH8_API_KEY } }),
 *   secret: env.ORCH8_PUSH_SECRET,
 *   handlers,
 * }));
 * ```
 */
export function createCloudflarePushHandler<Env extends object = Record<string, unknown>>(
  options: PushHandlerOptions | ((env: Env) => PushHandlerOptions),
): { fetch(request: Request, env: Env, ctx?: unknown): Promise<Response> } {
  const cache = new WeakMap<object, (request: Request) => Promise<Response>>();
  let fixed: ((request: Request) => Promise<Response>) | undefined;
  return {
    fetch(request, env) {
      if (typeof options !== "function") {
        fixed ??= createWebPushHandler(options);
        return fixed(request);
      }
      const key = (env ?? {}) as object;
      let handler = cache.get(key);
      if (!handler) {
        handler = createWebPushHandler(options(env));
        cache.set(key, handler);
      }
      return handler(request);
    },
  };
}
