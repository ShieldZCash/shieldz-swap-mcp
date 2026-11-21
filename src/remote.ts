// Remote MCP endpoint (Streamable HTTP, stateless, tools only) for swap.shieldz.cash/mcp.
// Runs on the same host as the router, listens on loopback only, sits behind nginx.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { INSTRUCTIONS, SITE, VERSION, runTool, toolList, type Ctx } from "./core.js";
const MAX_BODY = 64 * 1024;

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version, authorization",
};

export interface Reply { status: number; headers: Record<string, string>; body: string }

const json = (payload: unknown): Reply => ({
  status: 200,
  headers: { "content-type": "application/json", ...CORS },
  body: JSON.stringify(payload),
});
const result = (id: unknown, r: unknown) => json({ jsonrpc: "2.0", id, result: r });
const error = (id: unknown, code: number, message: string) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const empty = (status: number): Reply => ({ status, headers: { ...CORS }, body: "" });

const LANDING = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shieldz Swap MCP server</title><meta name="description" content="Model Context Protocol endpoint for Shieldz Swap: let an AI agent quote and create non-custodial cross-chain swaps across 40+ chains."><link rel="canonical" href="${SITE}/mcp"><meta name="robots" content="noindex, follow"><style>body{margin:0;background:#0a0a0a;color:#fafafa;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}main{max-width:580px;padding:32px}code{background:#141414;border:1px solid #262626;border-radius:8px;padding:2px 7px;font-family:ui-monospace,Menlo,monospace;color:#57d497}a{color:#57d497}</style></head><body><main><h1>Shieldz Swap MCP server</h1><p>This is the Shieldz Swap <strong>Model Context Protocol</strong> endpoint, not a page for humans. Point an MCP client at <code>${SITE}/mcp</code> (Streamable HTTP) and an AI agent can compare live cross-chain routes, create a swap and track it. Non-custodial: the user sends the deposit from their own wallet.</p><p>Tools: <code>list_assets</code>, <code>get_quote</code>, <code>create_swap</code>, <code>get_swap_status</code>, <code>report_deposit</code>. Local install: <code>npx -y @shieldz/swap-mcp</code>.</p><p>Humans: <a href="/">swap.shieldz.cash</a> · <a href="https://github.com/ShieldZCash/shieldz-swap-mcp">source on GitHub</a></p></main></body></html>`;

// Static metadata for directories that read it instead of probing (Smithery and others).
export function serverCard() {
  return {
    serverInfo: { name: "shieldz-swap", title: "Shieldz Swap", version: VERSION },
    description: "Non-custodial cross-chain swaps for AI agents: live route quotes across NEAR Intents, Chainflip, Relay, MAYAChain, BOB Gateway and Garden, deposit-address swaps and status tracking on 40+ chains. No API key.",
    websiteUrl: SITE,
    repository: "https://github.com/ShieldZCash/shieldz-swap-mcp",
    transport: { type: "streamable-http", url: `${SITE}/mcp` },
    authentication: { required: false },
    capabilities: { tools: { listChanged: false } },
    instructions: INSTRUCTIONS,
    tools: toolList(),
    resources: [],
    prompts: [],
  };
}

export async function handle(method: string, accept: string, rawBody: string, ctx: Ctx): Promise<Reply> {
  method = method.toUpperCase();
  if (method === "OPTIONS") return empty(204);
  if (method === "GET") {
    if (accept.includes("text/event-stream")) return { status: 405, headers: { ...CORS }, body: "Method Not Allowed" };
    return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" }, body: LANDING };
  }
  if (method === "DELETE") return empty(204);
  if (method !== "POST") return { status: 405, headers: { ...CORS }, body: "Method Not Allowed" };

  let msg: any;
  try { msg = JSON.parse(rawBody); } catch { return error(null, -32700, "Parse error"); }
  if (Array.isArray(msg) || !msg || typeof msg !== "object") return error(null, -32600, "Invalid Request");
  const { id, method: m, params } = msg;
  if ((id === undefined || id === null) && typeof m === "string" && m.startsWith("notifications/")) return empty(202);

  switch (m) {
    case "initialize":
      return result(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "shieldz-swap", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: toolList() });
    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : "";
      if (!toolList().some((t) => t.name === name)) return error(id, -32602, `Unknown tool: ${name}`);
      const started = Date.now();
      const out = await runTool(ctx, name, params?.arguments ?? {});
      console.log(`tool=${name} error=${!!out.isError} ms=${Date.now() - started}`);
      return result(id, out);
    }
    default:
      return error(id, -32601, `Method not found: ${m ?? ""}`);
  }
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; chunks.length = 0; return; }
      if (!tooBig) chunks.push(c);
    });
    req.on("end", () => resolve(tooBig ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startServer(opts: { port: number; host: string; apiBase: string }) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url || "/").split("?")[0];
    if (path === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }).end("ok"); return; }
    if (path === "/.well-known/mcp/server-card.json" || path === "/.well-known/mcp.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=3600", ...CORS }).end(JSON.stringify(serverCard(), null, 2));
      return;
    }
    if (path !== "/mcp" && path !== "/mcp/") { res.writeHead(404, { "content-type": "text/plain" }).end("Not found"); return; }
    try {
      const body = req.method === "POST" ? await readBody(req) : "";
      if (body === null) { res.writeHead(413, { ...CORS, connection: "close" }).end("Payload Too Large"); return; }
      const xff = req.headers["x-forwarded-for"];
      const ctx: Ctx = { base: opts.apiBase, forwardedFor: Array.isArray(xff) ? xff.join(", ") : xff };
      const out = await handle(req.method || "GET", String(req.headers.accept || ""), body, ctx);
      res.writeHead(out.status, out.headers).end(out.body);
    } catch (e) {
      console.error("mcp error", e);
      if (!res.headersSent) res.writeHead(500, CORS).end("Internal error");
    }
  });
  server.listen(opts.port, opts.host, () => console.log(`shieldz-swap-mcp remote ${VERSION} on http://${opts.host}:${opts.port}/mcp -> ${opts.apiBase}`));
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  startServer({
    port: Number(process.env.PORT || 8787),
    host: process.env.HOST || "127.0.0.1",
    apiBase: (process.env.SWAP_API_BASE || SITE).replace(/\/+$/, ""),
  });
}
