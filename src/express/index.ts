import type { IncomingMessage, ServerResponse } from "node:http";
import type { Orch8Client } from "../client.js";
import { createPushHandler, type PushHandlerOptions } from "../push/core.js";

/**
 * Structural subset of Express's request/response, so this module does not
 * import `express` (an optional peer dependency).
 */
export interface Orch8ExpressRequest extends IncomingMessage {
  path?: string;
  originalUrl?: string;
  body?: unknown;
  rawBody?: Buffer | string;
  orch8?: Orch8Client;
  _body?: boolean;
}
export type Orch8ExpressResponse = ServerResponse;
export type NextFunction = (err?: unknown) => void;
export type Orch8Middleware = (req: Orch8ExpressRequest, res: Orch8ExpressResponse, next: NextFunction) => void;

export interface Orch8ExpressOptions {
  client: Orch8Client;
  /** Mount a push-dispatch receiver. */
  push?: Omit<PushHandlerOptions, "client"> & {
    /** Request path the engine's queue `push_url` points at. Default: `/orch8/push`. */
    path?: string;
  };
}

/**
 * Express middleware that attaches the client as `req.orch8` and, when
 * `push` is configured, answers signed push deliveries at `push.path`.
 *
 * Mount it **before** `express.json()`, or pass {@link orch8RawBody} as the
 * JSON parser's `verify` option — signatures are computed over raw bytes.
 */
export function orch8Express(options: Orch8ExpressOptions): Orch8Middleware {
  const pushPath = options.push?.path ?? "/orch8/push";
  const push = options.push ? createPushHandler({ ...options.push, client: options.client }) : undefined;

  return (req, res, next) => {
    req.orch8 = options.client;
    const path = req.path ?? (req.url ?? "").split("?")[0];
    if (!push || path !== pushPath) return next();

    rawBody(req)
      .then(async (body) => {
        if (body === undefined) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            error: "raw_body_unavailable",
            message: "The request body was parsed before orch8Express; mount it before express.json() or use express.json({ verify: orch8RawBody }).",
          }));
          return;
        }
        const result = await push({ method: req.method, headers: req.headers, body });
        res.statusCode = result.status;
        for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
        res.end(result.body);
      })
      .catch(next);
  };
}

/** `verify` hook for `express.json()` that keeps the raw bytes for signature checks. */
export function orch8RawBody(req: IncomingMessage, _res: ServerResponse, buf: Buffer): void {
  (req as Orch8ExpressRequest).rawBody = Buffer.from(buf);
}

async function rawBody(req: Orch8ExpressRequest): Promise<Buffer | string | undefined> {
  if (req.rawBody !== undefined) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return req.body;
  if (req._body || req.readableEnded) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks);
}

/** Typed accessor for the client attached by {@link orch8Express}. */
export function getOrch8(req: object): Orch8Client {
  const client = (req as { orch8?: Orch8Client }).orch8;
  if (!client) throw new Error("orch8Express middleware is not mounted");
  return client;
}
