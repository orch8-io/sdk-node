let subtlePromise: Promise<SubtleCrypto> | undefined;

/** Web Crypto `subtle`, from the global (Node 19+, edge runtimes) or node:crypto (Node 18). */
export function subtle(): Promise<SubtleCrypto> {
  subtlePromise ??= (async () => {
    const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
    if (globalCrypto?.subtle) return globalCrypto.subtle;
    // The indirect require keeps edge bundlers from resolving the builtin.
    const req = typeof require === "function" ? require : undefined;
    const nodeCrypto = req?.("node:crypto") as { webcrypto?: Crypto } | undefined;
    if (nodeCrypto?.webcrypto?.subtle) return nodeCrypto.webcrypto.subtle;
    throw new Error("Web Crypto is not available in this runtime");
  })();
  return subtlePromise;
}

export function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  const s = await subtle();
  return toHex(await s.digest("SHA-256", new TextEncoder().encode(text)));
}

/** JSON with recursively sorted object keys, for content-derived keys. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as object)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
