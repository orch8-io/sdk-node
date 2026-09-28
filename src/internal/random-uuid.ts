/**
 * RFC 4122 v4 UUID from the Web Crypto global (Node 19+, edge runtimes,
 * browsers) or `node:crypto` (Node 18). The indirect require keeps edge
 * bundlers from resolving the builtin, so modules using this stay runnable on
 * Cloudflare Workers without `nodejs_compat`.
 */
export function randomUUID(): string {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (typeof globalCrypto?.randomUUID === "function") return globalCrypto.randomUUID();
  const req = typeof require === "function" ? require : undefined;
  const nodeCrypto = req?.("node:crypto") as { randomUUID?: () => string } | undefined;
  if (typeof nodeCrypto?.randomUUID === "function") return nodeCrypto.randomUUID();
  throw new Error("crypto.randomUUID is not available in this runtime");
}
