import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify an Orch8 webhook HMAC-SHA256 signature.
 *
 * The expected signature is a hex-encoded HMAC-SHA256 of the raw payload
 * bytes, using the trigger secret as the key. The timestamp is validated
 * independently to prevent replay attacks.
 *
 * @param payload - Raw request body string.
 * @param secret - Trigger secret configured in Orch8.
 * @param signature - Hex-encoded signature from the `x-trigger-signature` header.
 * @param timestamp - Unix timestamp from the `x-trigger-timestamp` header.
 * @param toleranceSeconds - Maximum age of the timestamp (default 300s).
 * @returns `true` if the signature and timestamp are valid.
 */
export function verifyWebhookSignature(
  payload: string,
  secret: string,
  signature: string,
  timestamp: string,
  toleranceSeconds = 300,
): boolean {
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts) || Math.abs(now - ts) > toleranceSeconds) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(payload).digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const signatureBuf = Buffer.from(signature, "hex");

  if (expectedBuf.length !== signatureBuf.length) {
    return false;
  }

  try {
    return timingSafeEqual(expectedBuf, signatureBuf);
  } catch {
    return false;
  }
}
