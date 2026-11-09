# Privacy

**What the hosted server processes.** The Dokploy URL and Dokploy API key you enter on the sign-in
page, and the tool calls/responses relayed between your AI client and your Dokploy instance.

**What it stores.** Nothing. The server has no database or disk state. After sign-in your URL and
API key exist only inside an AES-256-GCM encrypted token that your AI client holds and sends back
with each request; the server decrypts it in memory for the duration of a request.

**Logging.** Operational logs record only tool names, HTTP methods/paths, status codes and error messages.
Tool inputs, Dokploy responses, URLs and API keys are never logged.

**Third parties.** None. Data is sent only to the Dokploy URL you provide. No analytics, no tracking.

**Retention.** Zero server-side retention. Tokens expire (access 1 hour, refresh 30 days); deleting
the API key in Dokploy revokes access immediately.

**Minors.** Not intended for people under 18.

**Self-hosting.** The code is open source (Apache-2.0); you can run your own instance.

Contact: open an issue at https://github.com/igoruam/MCP-DOCKPLOY-ONLINE/issues
