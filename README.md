# MCP Dokploy Online

Hosted, multi-tenant MCP server for [Dokploy](https://dokploy.com), based on the
official [Dokploy/mcp](https://github.com/Dokploy/mcp) (Apache-2.0, same ~450 tools).

Unlike the official server (one global `DOKPLOY_URL`/`DOKPLOY_API_KEY`), this one is
**stateless**: each user's Dokploy URL and API key travel in request headers, are used
for that single request and are never stored or logged.

```
Claude Code ──(X-Dokploy-Url, X-Dokploy-Api-Key)──▶ this server (on your Dokploy) ──x-api-key──▶ user's Dokploy API
```

## 1. Deploy the server on Dokploy

1. Create a **Compose** service from this repo (or an **Application** using the `Dockerfile`).
2. Add a **Domain** (e.g. `mcp.example.com`) → service `dokploy-mcp`, port `3000`, HTTPS + Let's Encrypt.
3. Do **not** set `DOKPLOY_API_KEY` on the server. Optional: `DOKPLOY_ALLOWED_HOSTS`, `DOKPLOY_TOOL_PRESET`.
4. Check `https://mcp.example.com/health` → `{"status":"ok"}`.
5. Put that URL in `plugin/.mcp.json` (`url`) and push.

## 2. Install the plugin (Claude Code)

```bash
claude plugin marketplace add igoruam/MCP-DOCKPLOY-ONLINE
claude plugin install dokploy@dokploy-online
```

Claude Code asks only for **Dokploy URL** and **Dokploy API key** (stored in the system
credential store). Generate the key in Dokploy → Settings → Profile → API/CLI.

Without the plugin, any client that supports custom headers works:

```json
{ "mcpServers": { "dokploy": { "type": "http", "url": "https://mcp.example.com/mcp",
  "headers": { "X-Dokploy-Url": "https://dokploy.example.com", "X-Dokploy-Api-Key": "…" } } } }
```

> Claude.ai (web) and ChatGPT connectors cannot send custom headers; supporting them
> needs an OAuth login flow, which is intentionally not implemented yet.

## Headers

| Header | Required | Meaning |
|---|---|---|
| `X-Dokploy-Url` | yes | Base URL of the user's Dokploy |
| `X-Dokploy-Api-Key` | yes | Dokploy API key |
| `X-Dokploy-Tool-Preset` | no | `all` (default) · `minimal` · `core` · `deploy` · `databases` · `git` |
| `X-Dokploy-Enabled-Tags` / `X-Dokploy-Disabled-Tags` | no | Comma separated tool tags |
| `X-Dokploy-Custom-Headers` | no | JSON, e.g. Cloudflare Access service token |

## Security notes

- Outbound calls are SSRF-guarded: https only, private/loopback/link-local addresses blocked
  (checked again at connect time), no redirects, no URL credentials.
  Override with `DOKPLOY_ALLOW_HTTP`, `DOKPLOY_ALLOW_PRIVATE_HOSTS`; restrict with `DOKPLOY_ALLOWED_HOSTS`.
- In HTTP mode server env credentials are never used, so a public instance can't act with an operator key.
- Secrets in tool responses are redacted (`DOKPLOY_REDACT_ENV`, default on).
- Put the server behind your reverse proxy's rate limiting if it is public.
- The API key gives full control of that Dokploy: use it only with servers you trust.

## Local development

```bash
pnpm install && pnpm test && pnpm run build
DOKPLOY_URL=https://… DOKPLOY_API_KEY=… node build/index.js     # stdio, like upstream
node build/index.js --http                                       # hosted mode on :3000
```

Regenerate tools from a newer Dokploy OpenAPI: `pnpm generate:all`.
