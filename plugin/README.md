# Dokploy plugin for Claude

Manage your [Dokploy](https://dokploy.com) instance from Claude: projects, applications,
Docker Compose services, databases, domains, deployments and more (~450 tools).

## Setup

1. Install the plugin: `/plugin install bigdev-dokploy --marketplace igoruam/MCP-DOCKPLOY-ONLINE`
2. Claude opens a sign-in page. Enter your **Dokploy URL** (e.g. `https://dokploy.example.com`)
   and a **Dokploy API key** (Dokploy → Settings → Profile → API/CLI → Generate).
3. Done. Ask things like "list my Dokploy projects" or "redeploy the app called web".

## What data goes where

- Your requests to Dokploy are relayed by the hosted MCP server to **your** Dokploy URL, using your API key.
- The URL and key are verified once at sign-in and then kept only inside an encrypted token held by Claude.
  The server has no database and never logs tool inputs, Dokploy responses, URLs or keys.
- Revoke access any time by deleting the API key in Dokploy.

The key grants the same permissions you have in Dokploy; destructive tools (delete, remove, stop) are
annotated so Claude asks before running them.

Source: https://github.com/igoruam/MCP-DOCKPLOY-ONLINE · Privacy: see `PRIVACY.md` in the repository.
