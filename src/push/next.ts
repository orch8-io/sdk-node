import type { PushHandlerOptions } from "./core.js";
import { createWebPushHandler } from "./web.js";

/**
 * Next.js App Router route handler.
 *
 * ```ts
 * // app/api/orch8/route.ts
 * export const runtime = "nodejs"; // or "edge"
 * export const { POST } = createNextPushRoute({ client, secret, handlers });
 * ```
 */
export function createNextPushRoute(options: PushHandlerOptions): {
  POST: (request: Request) => Promise<Response>;
} {
  return { POST: createWebPushHandler(options) };
}
