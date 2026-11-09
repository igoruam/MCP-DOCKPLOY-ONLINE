const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#14171a;--muted:#5b6670;--line:#d9dee3;--accent:#2f6fed;--err:#b42318;--errbg:#fef3f2}
@media (prefers-color-scheme:dark){:root{--bg:#0f1214;--card:#181c20;--fg:#eef1f3;--muted:#9aa5ae;--line:#2a3036;--accent:#6b9bff;--err:#ff8a80;--errbg:#2a1614}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:grid;min-height:100vh;place-items:center;padding:16px}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:1.25rem;margin:0 0 4px}p{margin:.4rem 0;color:var(--muted);font-size:.92rem}
label{display:block;margin:18px 0 6px;font-weight:600;font-size:.9rem}
input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);font:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{margin-top:22px;width:100%;padding:12px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{background:var(--errbg);color:var(--err);border-radius:8px;padding:10px 12px;margin-top:14px;font-size:.9rem}
small{display:block;margin-top:6px;color:var(--muted);font-size:.8rem}
.fine{margin-top:20px;border-top:1px solid var(--line);padding-top:14px;font-size:.8rem}`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function loginPage(opts: {
  req: string;
  clientName: string;
  redirectHost: string;
  error?: string | undefined;
  dokployUrl?: string | undefined;
}): string {
  return shell(
    "Connect Dokploy",
    `<h1>Connect your Dokploy</h1>
<p><strong>${esc(opts.clientName)}</strong> (${esc(opts.redirectHost)}) wants to manage your Dokploy through this MCP server.</p>
${opts.error ? `<div class="err" role="alert">${esc(opts.error)}</div>` : ""}
<form method="post" action="/authorize" autocomplete="off">
<input type="hidden" name="req" value="${esc(opts.req)}">
<label for="u">Dokploy URL</label>
<input id="u" name="dokploy_url" type="url" required placeholder="https://dokploy.example.com" value="${esc(opts.dokployUrl ?? "")}">
<label for="k">Dokploy API key</label>
<input id="k" name="api_key" type="password" required autocomplete="off" placeholder="Settings → Profile → API/CLI">
<small>Generate it in Dokploy under Settings → Profile → API/CLI.</small>
<button type="submit">Connect</button>
</form>
<p class="fine">Your key is verified once, then kept only inside an encrypted token held by your AI client. This server stores nothing. To revoke access, delete the API key in Dokploy.</p>`,
  );
}

export function errorPage(message: string): string {
  return shell(
    "Cannot connect",
    `<h1>Cannot connect</h1><div class="err" role="alert">${esc(message)}</div><p>Close this tab and start the connection again from your AI client.</p>`,
  );
}
