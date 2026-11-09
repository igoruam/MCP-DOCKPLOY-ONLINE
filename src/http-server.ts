#!/usr/bin/env node

import type { HttpBindings } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Hono } from "hono";
import { createServer } from "./server.js";
import { contextFromHeaders, requestContext } from "./utils/context.js";
import { createLogger } from "./utils/logger.js";

const logger = createLogger("MCP-HTTP-Server");

const jsonrpcError = (code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  error: { code, message },
  id: null,
});

// When the MCP transport takes over the raw Node response, Hono must not touch it.
function neverResolve(): Promise<never> {
  return new Promise(() => {});
}

/**
 * Stateless, multi-tenant Streamable HTTP server.
 *
 * Every request carries the caller's own Dokploy instance and API key:
 *   X-Dokploy-Url       https://dokploy.example.com
 *   X-Dokploy-Api-Key   <Dokploy API key>
 * Optional: X-Dokploy-Tool-Preset, X-Dokploy-Enabled-Tags, X-Dokploy-Disabled-Tags,
 *           X-Dokploy-Custom-Headers (JSON, e.g. Cloudflare Access service token).
 * The server stores nothing: credentials live only for the duration of a request.
 */
export function createApp() {
  const app = new Hono<{ Bindings: HttpBindings }>();

  app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

  app.post("/mcp", async (c) => {
    const { incoming, outgoing } = c.env;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(jsonrpcError(-32700, "Parse error: body must be JSON"), 400);
    }

    let context: ReturnType<typeof contextFromHeaders>;
    try {
      context = contextFromHeaders((name) => c.req.header(name));
    } catch (error) {
      return c.json(
        jsonrpcError(-32602, error instanceof Error ? error.message : "Invalid headers"),
        400,
      );
    }

    try {
      const server = createServer({
        toolPreset: context.toolPreset,
        enabledTags: context.enabledTags,
        disabledTags: context.disabledTags,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
      outgoing.on("close", () => {
        void transport.close();
        void server.close();
      });

      await requestContext.run(context, async () => {
        await server.connect(
          transport as unknown as import("@modelcontextprotocol/sdk/shared/transport.js").Transport,
        );
        await transport.handleRequest(incoming, outgoing, body);
      });
      return neverResolve();
    } catch (error) {
      logger.error("Error handling MCP request", {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(jsonrpcError(-32603, "Internal server error"), 500);
    }
  });

  // Stateless mode: no server-initiated streams and no sessions to terminate.
  const methodNotAllowed = (c: import("hono").Context) =>
    c.json(jsonrpcError(-32000, "Method not allowed: this server is stateless"), 405);
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}

export async function main() {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  serve({ fetch: createApp().fetch, port }, () => {
    logger.info("MCP Dokploy server started", {
      port,
      mode: "stateless multi-tenant (credentials via X-Dokploy-* headers)",
      endpoints: { mcp: `http://localhost:${port}/mcp`, health: `http://localhost:${port}/health` },
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    logger.error("Fatal error occurred", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
}
