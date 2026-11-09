import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { createLogger } from "../utils/logger.js";

/**
 * Stateless "sealed" tokens: AES-256-GCM over a JSON payload, bound to a purpose
 * (used as AAD, so a `code` can never be replayed as an `access` token) and an
 * expiry. The server keeps no database: the user's Dokploy URL + API key live,
 * encrypted, inside the token that the AI client holds.
 */
const logger = createLogger("Seal");
let cachedKey: Buffer | undefined;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  let secret = process.env.MCP_SECRET;
  if (!secret || secret.length < 32) {
    logger.warn(
      "MCP_SECRET is missing or shorter than 32 chars: using an ephemeral key. OAuth tokens will stop working on every restart. Set MCP_SECRET (e.g. `openssl rand -hex 32`).",
    );
    secret = randomBytes(32).toString("hex");
  }
  cachedKey = Buffer.from(hkdfSync("sha256", secret, "mcp-dokploy-online", "seal-v1", 32));
  return cachedKey;
}

/** Test helper. */
export function resetSealKey(): void {
  cachedKey = undefined;
}

export type SealPurpose = "client" | "req" | "code" | "access" | "refresh";

export function seal(purpose: SealPurpose, payload: object, ttlSeconds: number): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  cipher.setAAD(Buffer.from(purpose));
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const data = Buffer.concat([
    cipher.update(JSON.stringify({ ...payload, exp }), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

export function unseal<T extends object>(
  purpose: SealPurpose,
  token: string | undefined,
): (T & { exp: number }) | null {
  if (!token) return null;
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", getKey(), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
      "utf8",
    );
    const payload = JSON.parse(json) as T & { exp: number };
    return payload.exp > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}
