import { createHash, randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { createApiClient } from "../utils/apiClient.js";
import { createLogger } from "../utils/logger.js";
import { errorPage, loginPage } from "./page.js";
import { seal, unseal } from "./seal.js";

const logger = createLogger("OAuth");

const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 60 * 60 * 24 * 30; // 30 days
const CODE_TTL = 120;
const CLIENT_TTL = 60 * 60 * 24 * 365 * 5;

// Who may receive authorization codes. Open dynamic registration is otherwise a
// phishing vector (attacker registers a redirect_uri they own, victim logs in).
const DEFAULT_REDIRECT_HOSTS = [
  "claude.ai",
  "claude.com",
  "chatgpt.com",
  "platform.openai.com",
  "localhost",
  "127.0.0.1",
];

function allowedRedirectHosts(): string[] {
  const extra = (process.env.OAUTH_ALLOWED_REDIRECT_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_REDIRECT_HOSTS, ...extra];
}

function isAllowedRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  const host = u.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return false;
  return allowedRedirectHosts().some((h) => host === h || host.endsWith(`.${h}`));
}

// --- tiny in-memory rate limiter + single-use code registry (single instance) ---
const hits = new Map<string, { n: number; reset: number }>();
function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.reset < now) {
    hits.set(key, { n: 1, reset: now + windowMs });
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return false;
  }
  entry.n += 1;
  return entry.n > max;
}

const usedCodes = new Map<string, number>();
function consumeCode(jti: string, exp: number): boolean {
  const now = Date.now() / 1000;
  for (const [k, e] of usedCodes) if (e < now) usedCodes.delete(k);
  if (usedCodes.has(jti)) return false;
  usedCodes.set(jti, exp);
  return true;
}

function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export function baseUrl(c: Context): string {
  const configured = process.env.PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const url = new URL(c.req.url);
  const proto =
    c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host =
    c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host") || url.host;
  return `${proto}://${host}`;
}

function oauthError(c: Context, error: string, description: string, status: 400 | 401 | 429 = 400) {
  return c.json({ error, error_description: description }, status, {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  });
}

interface ClientPayload {
  ru: string[];
  name: string;
}
interface ReqPayload {
  cid: string;
  ru: string;
  cc: string;
  state?: string | undefined;
}
interface CodePayload {
  cid: string;
  ru: string;
  cc: string;
  u: string;
  k: string;
  jti: string;
}
export interface TokenPayload {
  u: string;
  k: string;
  cid?: string;
}

export function verifyAccessToken(token: string): TokenPayload | null {
  return unseal<TokenPayload>("access", token);
}

function issueTokens(p: TokenPayload) {
  return {
    access_token: seal("access", p, ACCESS_TTL),
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: seal("refresh", p, REFRESH_TTL),
    scope: "mcp",
  };
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function registerOAuthRoutes(app: Hono) {
  const protectedResource = (c: Context) =>
    c.json({
      resource: `${baseUrl(c)}/mcp`,
      authorization_servers: [baseUrl(c)],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
      resource_name: "Dokploy MCP",
    });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  const authServer = (c: Context) => {
    const base = baseUrl(c);
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  };
  app.get("/.well-known/oauth-authorization-server", authServer);
  app.get("/.well-known/oauth-authorization-server/mcp", authServer);

  // RFC 7591 dynamic client registration, stateless: the client_id *is* the sealed registration.
  app.post("/register", async (c) => {
    if (rateLimited(`reg:${clientIp(c)}`, 30, 60_000)) {
      return oauthError(c, "temporarily_unavailable", "Too many requests", 429);
    }
    let body: { redirect_uris?: unknown; client_name?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return oauthError(c, "invalid_client_metadata", "Body must be JSON");
    }
    const uris = body.redirect_uris;
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      uris.length > 10 ||
      !uris.every((u) => typeof u === "string" && isAllowedRedirect(u))
    ) {
      return oauthError(
        c,
        "invalid_redirect_uri",
        "redirect_uris must be https URLs on an allowed host (Claude, ChatGPT or localhost)",
      );
    }
    const name =
      typeof body.client_name === "string" ? body.client_name.slice(0, 80) : "MCP client";
    const clientId = seal("client", { ru: uris, name } satisfies ClientPayload, CLIENT_TTL);
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
      { "Cache-Control": "no-store" },
    );
  });

  const securityHeaders = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
  };

  app.get("/authorize", (c) => {
    const q = c.req.query();
    const client = unseal<ClientPayload>("client", q.client_id);
    if (!client) return c.html(errorPage("Unknown or expired client."), 400, securityHeaders);
    if (!q.redirect_uri || !client.ru.includes(q.redirect_uri)) {
      return c.html(
        errorPage("Redirect URI does not match the registered client."),
        400,
        securityHeaders,
      );
    }
    const redirectError = (error: string, description: string) => {
      const u = new URL(q.redirect_uri as string);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (q.state) u.searchParams.set("state", q.state);
      return c.redirect(u.toString(), 302);
    };
    if (q.response_type !== "code") {
      return redirectError("unsupported_response_type", "Only response_type=code is supported");
    }
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return redirectError("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    const req = seal(
      "req",
      {
        cid: q.client_id as string,
        ru: q.redirect_uri,
        cc: q.code_challenge,
        state: q.state,
      } satisfies ReqPayload,
      15 * 60,
    );
    return c.html(
      loginPage({ req, clientName: client.name, redirectHost: new URL(q.redirect_uri).host }),
      200,
      securityHeaders,
    );
  });

  app.post("/authorize", async (c) => {
    const form = await c.req.parseBody();
    const req = unseal<ReqPayload>("req", typeof form.req === "string" ? form.req : undefined);
    if (!req) {
      return c.html(
        errorPage("This sign-in page expired. Start again from your AI client."),
        400,
        securityHeaders,
      );
    }
    const client = unseal<ClientPayload>("client", req.cid);
    if (!client) return c.html(errorPage("Unknown or expired client."), 400, securityHeaders);

    const reqToken = form.req as string;
    const rawUrl = typeof form.dokploy_url === "string" ? form.dokploy_url : "";
    const apiKey = typeof form.api_key === "string" ? form.api_key.trim() : "";
    const redirectHost = new URL(req.ru).host;
    const retry = (error: string, status: 400 | 429 = 400) =>
      c.html(
        loginPage({
          req: reqToken,
          clientName: client.name,
          redirectHost,
          error,
          dokployUrl: rawUrl,
        }),
        status,
        securityHeaders,
      );

    if (rateLimited(`auth:${clientIp(c)}`, 15, 10 * 60_000)) {
      return retry("Too many attempts. Try again in a few minutes.", 429);
    }
    if (!rawUrl.trim() || !apiKey) return retry("Enter both the Dokploy URL and the API key.");

    let dokployUrl: string;
    try {
      const api = createApiClient({ dokployUrl: normalizeUrl(rawUrl), apiKey, customHeaders: {} });
      await api.get("/project.all");
      dokployUrl = normalizeUrl(rawUrl);
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      logger.info("Authorize verification failed", { status });
      if (status === 401 || status === 403) return retry("Dokploy rejected this API key.");
      if (status) return retry(`Dokploy answered with HTTP ${status}. Check the URL.`);
      const msg = error instanceof Error ? error.message : "";
      return retry(
        /https|private|loopback|allowed|valid URL|credentials/i.test(msg)
          ? msg
          : "Could not reach that Dokploy URL. Check the address and that it is public over HTTPS.",
      );
    }

    const code = seal(
      "code",
      {
        cid: req.cid,
        ru: req.ru,
        cc: req.cc,
        u: dokployUrl,
        k: apiKey,
        jti: randomUUID(),
      } satisfies CodePayload,
      CODE_TTL,
    );
    const target = new URL(req.ru);
    target.searchParams.set("code", code);
    if (req.state) target.searchParams.set("state", req.state);
    return c.redirect(target.toString(), 302);
  });

  app.post("/token", async (c) => {
    if (rateLimited(`tok:${clientIp(c)}`, 120, 60_000)) {
      return oauthError(c, "temporarily_unavailable", "Too many requests", 429);
    }
    const form = await c.req.parseBody();
    const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : undefined);
    const grant = str("grant_type");

    if (grant === "authorization_code") {
      const code = unseal<CodePayload>("code", str("code"));
      if (!code) return oauthError(c, "invalid_grant", "Invalid or expired code");
      if (str("client_id") && str("client_id") !== code.cid) {
        return oauthError(c, "invalid_grant", "client_id mismatch");
      }
      if (str("redirect_uri") !== code.ru) {
        return oauthError(c, "invalid_grant", "redirect_uri mismatch");
      }
      const verifier = str("code_verifier");
      if (!verifier || createHash("sha256").update(verifier).digest("base64url") !== code.cc) {
        return oauthError(c, "invalid_grant", "PKCE verification failed");
      }
      if (!consumeCode(code.jti, code.exp)) {
        return oauthError(c, "invalid_grant", "Code already used");
      }
      return c.json(issueTokens({ u: code.u, k: code.k, cid: code.cid }), 200, {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      });
    }

    if (grant === "refresh_token") {
      const refresh = unseal<TokenPayload>("refresh", str("refresh_token"));
      if (!refresh) return oauthError(c, "invalid_grant", "Invalid or expired refresh token");
      if (str("client_id") && refresh.cid && str("client_id") !== refresh.cid) {
        return oauthError(c, "invalid_grant", "client_id mismatch");
      }
      return c.json(
        issueTokens({ u: refresh.u, k: refresh.k, ...(refresh.cid ? { cid: refresh.cid } : {}) }),
        200,
        { "Cache-Control": "no-store", Pragma: "no-cache" },
      );
    }

    return oauthError(c, "unsupported_grant_type", "Use authorization_code or refresh_token");
  });
}
