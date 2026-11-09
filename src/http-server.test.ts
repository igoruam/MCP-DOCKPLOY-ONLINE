import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./http-server.js";

// A fake Dokploy that records the API key it receives.
const seen: { path?: string; key?: string }[] = [];
let fakeDokploy: http.Server;
let mcp: ReturnType<typeof serve>;
let fakeUrl: string;
let mcpUrl: string;

beforeAll(async () => {
  process.env.DOKPLOY_ALLOW_HTTP = "1";
  process.env.DOKPLOY_ALLOW_PRIVATE_HOSTS = "1";
  fakeDokploy = http.createServer((req, res) => {
    seen.push({ path: req.url, key: req.headers["x-api-key"] as string });
    res.setHeader("content-type", "application/json");
    if (req.headers["x-api-key"] !== "good-key") {
      res.statusCode = 401;
      return res.end(JSON.stringify({ message: "Unauthorized" }));
    }
    res.end(JSON.stringify([{ projectId: "p1", name: "demo" }]));
  });
  await new Promise<void>((r) => fakeDokploy.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fakeDokploy.address() as AddressInfo).port}`;

  await new Promise<void>((r) => {
    mcp = serve({ fetch: createApp().fetch, port: 0 }, () => r());
  });
  mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
});

afterAll(() => {
  fakeDokploy.close();
  mcp.close();
});

async function connect(headers: Record<string, string>) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers } }),
  );
  return client;
}

describe("hosted MCP server (stateless, per-request credentials)", () => {
  it("lists tools with credentials", async () => {
    const client = await connect({ "x-dokploy-url": fakeUrl, "x-dokploy-api-key": "good-key" });
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(100);
    await client.close();
  });

  it("answers 401 with OAuth discovery metadata when unauthenticated", async () => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(
      /^Bearer resource_metadata=".*\/\.well-known\/oauth-protected-resource"$/,
    );
  });

  it("calls the caller's own Dokploy with the caller's own key", async () => {
    const client = await connect({ "x-dokploy-url": fakeUrl, "x-dokploy-api-key": "good-key" });
    const result = await client.callTool({ name: "project-all", arguments: {} });
    expect(JSON.stringify(result)).toContain("demo");
    expect(seen.at(-1)).toEqual({ path: "/api/project.all", key: "good-key" });
    await client.close();
  });

  it("keeps two users' credentials isolated, even concurrently", async () => {
    const [a, b] = await Promise.all([
      connect({ "x-dokploy-url": fakeUrl, "x-dokploy-api-key": "good-key" }),
      connect({ "x-dokploy-url": fakeUrl, "x-dokploy-api-key": "other-key" }),
    ]);
    const [ra, rb] = await Promise.all([
      a.callTool({ name: "project-all", arguments: {} }),
      b.callTool({ name: "project-all", arguments: {} }),
    ]);
    expect(JSON.stringify(ra)).toContain("demo");
    expect(JSON.stringify(rb)).toContain("Authentication failed");
    await a.close();
    await b.close();
  });

  it("never falls back to server env credentials", async () => {
    process.env.DOKPLOY_URL = fakeUrl;
    process.env.DOKPLOY_API_KEY = "good-key";
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    delete process.env.DOKPLOY_URL;
    delete process.env.DOKPLOY_API_KEY;
  });

  it("honours X-Dokploy-Tool-Preset", async () => {
    const client = await connect({
      "x-dokploy-url": fakeUrl,
      "x-dokploy-api-key": "good-key",
      "x-dokploy-tool-preset": "minimal",
    });
    const { tools } = await client.listTools();
    expect(tools.every((t) => /^(project|application)-/.test(t.name))).toBe(true);
    await client.close();
  });

  it("refuses private hosts unless explicitly allowed", async () => {
    delete process.env.DOKPLOY_ALLOW_PRIVATE_HOSTS;
    const client = await connect({ "x-dokploy-url": fakeUrl, "x-dokploy-api-key": "good-key" });
    const result = await client.callTool({ name: "project-all", arguments: {} });
    expect(JSON.stringify(result)).toMatch(/must use https|Private/);
    process.env.DOKPLOY_ALLOW_PRIVATE_HOSTS = "1";
    await client.close();
  });

  it("answers /health and rejects GET /mcp", async () => {
    const base = mcpUrl.replace("/mcp", "");
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(mcpUrl)).status).toBe(405);
  });
});

describe("OAuth flow (what Claude.ai / ChatGPT do)", () => {
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const base = () => mcpUrl.replace("/mcp", "");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  async function register(uris: string[] = [redirectUri]) {
    return fetch(`${base()}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: uris }),
    });
  }

  async function authorize(clientId: string, key: string, url = fakeUrl, cc = challenge) {
    const page = await fetch(
      `${base()}/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: cc,
        code_challenge_method: "S256",
        state: "xyz",
      })}`,
    );
    const html = await page.text();
    expect(html).toContain("Dokploy API key");
    const req = html.match(/name="req" value="([^"]+)"/)?.[1] ?? "";
    return fetch(`${base()}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ req, dokploy_url: url, api_key: key }),
    });
  }

  const token = (params: Record<string, string>) =>
    fetch(`${base()}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });

  it("publishes discovery metadata", async () => {
    const pr = await (await fetch(`${base()}/.well-known/oauth-protected-resource`)).json();
    expect(pr.resource).toBe(mcpUrl);
    const as = await (await fetch(`${base()}/.well-known/oauth-authorization-server`)).json();
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.registration_endpoint).toBe(`${base()}/register`);
  });

  it("refuses to register redirect URIs on unknown hosts", async () => {
    expect((await register(["https://evil.example/cb"])).status).toBe(400);
    expect((await register(["http://claude.ai/cb"])).status).toBe(400);
  });

  it("runs register → login → token → MCP call → refresh", async () => {
    const { client_id } = await (await register()).json();

    const done = await authorize(client_id, "good-key");
    expect(done.status).toBe(302);
    const loc = new URL(done.headers.get("location") as string);
    expect(loc.origin + loc.pathname).toBe(redirectUri);
    expect(loc.searchParams.get("state")).toBe("xyz");
    const code = loc.searchParams.get("code") as string;

    const tok = await (
      await token({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id,
        code_verifier: verifier,
      })
    ).json();
    expect(tok.token_type).toBe("Bearer");

    const client = new Client({ name: "oauth", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } },
      }),
    );
    const result = await client.callTool({ name: "project-all", arguments: {} });
    expect(JSON.stringify(result)).toContain("demo");
    expect(seen.at(-1)?.key).toBe("good-key");
    await client.close();

    // the URL/key are not readable from the token
    expect(tok.access_token).not.toContain("good-key");

    const refreshed = await (
      await token({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id })
    ).json();
    expect(refreshed.access_token).toBeTruthy();
  });

  it("rejects a replayed code, a wrong PKCE verifier and a wrong redirect_uri", async () => {
    const { client_id } = await (await register()).json();
    const mk = async () => {
      const r = await authorize(client_id, "good-key");
      return new URL(r.headers.get("location") as string).searchParams.get("code") as string;
    };
    const ok = {
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      client_id,
      code_verifier: verifier,
    };

    const c1 = await mk();
    expect((await token({ ...ok, code: c1 })).status).toBe(200);
    expect((await token({ ...ok, code: c1 })).status).toBe(400); // replay

    const c2 = await mk();
    expect((await token({ ...ok, code: c2, code_verifier: "wrong" })).status).toBe(400);
    const c3 = await mk();
    expect((await token({ ...ok, code: c3, redirect_uri: "https://claude.ai/other" })).status).toBe(
      400,
    );
  });

  it("shows an error and issues no code when Dokploy rejects the key", async () => {
    const { client_id } = await (await register()).json();
    const res = await authorize(client_id, "bad-key");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("rejected this API key");
  });

  it("rejects tampered or foreign tokens at /mcp", async () => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer not-a-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("does not accept an authorization code as an access token", async () => {
    const { client_id } = await (await register()).json();
    const r = await authorize(client_id, "good-key");
    const code = new URL(r.headers.get("location") as string).searchParams.get("code") as string;
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${code}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});
