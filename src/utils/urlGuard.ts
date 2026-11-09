import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * SSRF protection. A hosted instance makes outbound calls to a URL chosen by the
 * caller, so by default we only allow https to public addresses.
 *
 *   DOKPLOY_ALLOWED_HOSTS=a.example.com,b.example.com  restrict to these hosts
 *   DOKPLOY_ALLOW_HTTP=1                               allow http://
 *   DOKPLOY_ALLOW_PRIVATE_HOSTS=1                      allow private/loopback IPs
 */

function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
}

export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1] ?? "");
    if (lower === "::" || lower === "::1") return true;
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
  }
  return false;
}

export function assertSafeDokployUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("X-Dokploy-Url is not a valid URL (expected e.g. https://dokploy.example.com)");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && envFlag("DOKPLOY_ALLOW_HTTP"))) {
    throw new Error("Dokploy URL must use https://");
  }
  if (url.username || url.password) {
    throw new Error("Dokploy URL must not contain credentials");
  }
  const allowed = (process.env.DOKPLOY_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(url.hostname.toLowerCase())) {
    throw new Error(`Host ${url.hostname} is not allowed on this MCP server`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!envFlag("DOKPLOY_ALLOW_PRIVATE_HOSTS")) {
    if (host.toLowerCase() === "localhost" || host.toLowerCase().endsWith(".localhost")) {
      throw new Error("Private or loopback hosts are not allowed");
    }
    if (net.isIP(host) && isPrivateAddress(host)) {
      throw new Error("Private or loopback addresses are not allowed");
    }
  }
  return url;
}

// Validates the resolved address at connect time, which also defeats DNS rebinding.
const guardedLookup = ((hostname: string, options: dns.LookupOptions, callback: unknown) => {
  const cb = callback as (
    err: NodeJS.ErrnoException | null,
    address?: string | dns.LookupAddress[],
    family?: number,
  ) => void;
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err);
    if (!envFlag("DOKPLOY_ALLOW_PRIVATE_HOSTS")) {
      const list = Array.isArray(address) ? address.map((a) => a.address) : [address as string];
      if (list.some(isPrivateAddress)) {
        return cb(new Error("Private or loopback addresses are not allowed"));
      }
    }
    cb(null, address, family);
  });
}) as unknown as net.LookupFunction;

export const guardedHttpAgent = new http.Agent({ lookup: guardedLookup });
export const guardedHttpsAgent = new https.Agent({ lookup: guardedLookup });
