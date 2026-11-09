# MCP Dokploy Online

Hosted, multi-tenant MCP server for [Dokploy](https://dokploy.com), based on the official
[Dokploy/mcp](https://github.com/Dokploy/mcp) (Apache-2.0, same ~450 tools).

Unlike the official server (one global `DOKPLOY_URL`/`DOKPLOY_API_KEY`), this one is **stateless and
multi-user**. Each user signs in once with their **Dokploy URL + API key** (OAuth 2.1 login page,
works with Claude.ai, Claude Cowork, Claude Code and ChatGPT connectors). The credentials are kept
only inside an AES-256-GCM encrypted token held by the client; the server has no database.

```
Claude / ChatGPT ──OAuth──▶ this server (on your Dokploy) ──x-api-key──▶ the user's Dokploy API
```

## 1. Deploy the server on Dokploy

1. Create a **Compose** service from this repo.
2. Environment: `MCP_SECRET=$(openssl rand -hex 32)` and `PUBLIC_URL=https://mcp.example.com`.
   Never set `DOKPLOY_API_KEY` on the server.
3. Add a **Domain** (`mcp.example.com`) → service `dokploy-mcp`, port `3000`, HTTPS + Let's Encrypt.
4. Check `https://mcp.example.com/health` → `{"status":"ok"}`.
5. Put the URL in `plugin/.mcp.json` and push.

## 2. Use it

- **Claude.ai / Cowork / ChatGPT**: add a custom connector with `https://mcp.example.com/mcp`; a login
  page asks for Dokploy URL + API key.
- **Claude Code**: `/plugin install bigdev-dokploy --marketplace igoruam/MCP-DOCKPLOY-ONLINE`, then `/mcp` → authenticate.
- **Headers instead of OAuth** (clients that can set headers):
  `X-Dokploy-Url: https://dokploy.example.com` and `X-Dokploy-Api-Key: …`.

Optional headers: `X-Dokploy-Tool-Preset` (`all` · `minimal` · `core` · `deploy` · `databases` · `git`),
`X-Dokploy-Enabled-Tags`, `X-Dokploy-Disabled-Tags`, `X-Dokploy-Custom-Headers` (JSON, e.g. Cloudflare Access).

Publishing to Anthropic's directory: see [docs/SUBMISSION.md](docs/SUBMISSION.md).

## Security notes

- OAuth: PKCE (S256) required, dynamic client registration restricted to Claude, ChatGPT and localhost
  redirect hosts (`OAUTH_ALLOWED_REDIRECT_HOSTS` to extend), single-use codes, 1 h access / 30 d refresh tokens,
  rate-limited login. Rotating `MCP_SECRET` signs everyone out; deleting the API key in Dokploy revokes a user.
- Outbound calls are SSRF-guarded: https only, private/loopback/link-local blocked (re-checked at connect
  time), no redirects. Override with `DOKPLOY_ALLOW_HTTP`, `DOKPLOY_ALLOW_PRIVATE_HOSTS`; restrict with `DOKPLOY_ALLOWED_HOSTS`.
- In HTTP mode server env credentials are never used. Secrets in tool responses are redacted (`DOKPLOY_REDACT_ENV`).
- Rate limits are in-memory (single instance). The API key gives full control of that Dokploy.

## Local development

```bash
pnpm install && pnpm test && pnpm run build
DOKPLOY_URL=https://… DOKPLOY_API_KEY=… node build/index.js     # stdio, like upstream
node build/index.js --http                                       # hosted mode on :3000
```

Regenerate tools from a newer Dokploy OpenAPI: `pnpm generate:all`.
