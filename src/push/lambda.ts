import { createPushHandler, type PushHandlerOptions } from "./core.js";

/** API Gateway REST (v1), HTTP API (v2), and Lambda Function URL events. */
export interface LambdaHttpEvent {
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined> | null;
  httpMethod?: string;
  requestContext?: { http?: { method?: string } };
}

export interface LambdaHttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function decodeBase64(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  const bin = atob(value);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * AWS Lambda handler for API Gateway (REST or HTTP API) and Function URLs.
 *
 * ```ts
 * export const handler = createLambdaPushHandler({ client, secret, handlers });
 * ```
 */
export function createLambdaPushHandler(
  options: PushHandlerOptions,
): (event: LambdaHttpEvent) => Promise<LambdaHttpResult> {
  const handle = createPushHandler(options);
  return async (event) => {
    const raw = event.body ?? "";
    const body = event.isBase64Encoded ? decodeBase64(raw) : raw;
    const method = event.requestContext?.http?.method ?? event.httpMethod;
    const res = await handle({ method, headers: event.headers ?? {}, body });
    return { statusCode: res.status, headers: res.headers, body: res.body };
  };
}
