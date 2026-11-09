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
  it("lists tools without credentials", async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(100);
    await client.close();
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

  it("returns a clear error when credentials are missing", async () => {
    const client = await connect({});
    const result = await client.callTool({ name: "project-all", arguments: {} });
    expect(JSON.stringify(result)).toContain("X-Dokploy-Url");
    await client.close();
  });

  it("never falls back to server env credentials", async () => {
    process.env.DOKPLOY_URL = fakeUrl;
    process.env.DOKPLOY_API_KEY = "good-key";
    const client = await connect({});
    const result = await client.callTool({ name: "project-all", arguments: {} });
    expect(JSON.stringify(result)).toContain("Missing Dokploy credentials");
    delete process.env.DOKPLOY_URL;
    delete process.env.DOKPLOY_API_KEY;
    await client.close();
  });

  it("honours X-Dokploy-Tool-Preset", async () => {
    const client = await connect({ "x-dokploy-tool-preset": "minimal" });
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
