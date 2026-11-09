# Publishing to Anthropic's directory

Two separate submissions at https://claude.ai/directory/manage (the plugin points at a remote MCP
server you run, so the server must be listed too):

1. **MCP connector** → `https://mcp.<your-domain>/mcp` (submit first)
2. **Plugin bundle** → this repo, plugin path `plugin`

## Before submitting

- [ ] Server deployed on Dokploy with HTTPS, `MCP_SECRET` and `PUBLIC_URL` set; `/health` is OK.
- [ ] `https://mcp.<domain>/.well-known/oauth-authorization-server` and `…/oauth-protected-resource` respond.
- [ ] Domain is **not** flagged by Google Safe Browsing (check transparencyreport.google.com/safe-browsing/search).
- [ ] `plugin/.mcp.json` has the real server URL; repo is public (or private + Claude GitHub App) with a connected GitHub account on claude.ai.
- [ ] `claude plugin validate ./plugin` passes (run from the repo root).
- [ ] Reviewers will need a way to test: provide a **test Dokploy instance URL + API key** (throw-away instance with dummy projects) in the submission notes.
- [ ] Raise `version` in `plugin/.claude-plugin/plugin.json` on every release.

## Answers for the "Data handling" step

| Question | Answer |
|---|---|
| Reads or stores personal data? | Reads whatever the user's own Dokploy returns (project/app names, env vars with secrets redacted). Stores nothing. |
| Sends data to services other than declared connectors? | No. Only to the Dokploy URL the user enters. |
| Retention | None server-side; see `PRIVACY.md`. |
| Intended for under 18? | No. |

The plugin sends the user's API key to the hosted server at sign-in; this is disclosed in the plugin
README and `PRIVACY.md` to avoid the "sends data to an undisclosed destination" finding.

## Test plan for reviewers

1. Add the connector → browser opens the sign-in page.
2. Enter Dokploy URL + API key → redirected back, connected.
3. Ask "list my Dokploy projects" (`project-all`, read-only) and "create a project named demo" (write).
