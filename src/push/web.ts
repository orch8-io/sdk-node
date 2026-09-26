import { createPushHandler, type PushHandlerOptions, type PushResponse } from "./core.js";

export function toWebResponse(res: PushResponse): Response {
  return new Response(res.body, { status: res.status, headers: res.headers });
}

/**
 * Web-standard `(Request) => Promise<Response>` push receiver. Works on Vercel
 * Functions, Deno, Bun, Netlify Edge, and any Fetch-API runtime.
 */
export function createWebPushHandler(options: PushHandlerOptions): (request: Request) => Promise<Response> {
  const handle = createPushHandler(options);
  return async (request) => {
    const body = new Uint8Array(await request.arrayBuffer());
    return toWebResponse(await handle({ method: request.method, headers: request.headers, body }));
  };
}

/** Alias for Vercel Functions (`export const POST = createVercelPushHandler(...)`). */
export const createVercelPushHandler = createWebPushHandler;
