// Real MCP SDK clients against both transports, with a fake router on localhost.
// The SDK client validates structuredContent against each tool's outputSchema.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../dist/remote.js";

const ASSETS = [
  { asset_id: "BASE.USDC-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", chain: "BASE", decimals: 6, verified: true, usd_price: "1", contract_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  { asset_id: "ZEC.ZEC", symbol: "ZEC", chain: "ZEC", decimals: 8, verified: true, usd_price: "750" },
];
const QUOTE = (protocol, out) => ({ protocol, amount_in: "50000000", amount_out: out, min_amount_out: protocol === "chainflip" ? null : "6500000", amount_in_usd: "50", amount_out_usd: "49.5", estimated_duration_seconds: 150, slippage: { bps: 50 } });

let router, routerUrl, remote, remoteUrl;
const seenXff = [];

before(async () => {
  router = createServer((req, res) => {
    seenXff.push(req.headers["x-forwarded-for"]);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (s, o) => res.writeHead(s, { "content-type": "application/json" }).end(JSON.stringify(o));
      const b = body ? JSON.parse(body) : {};
      if (req.url === "/v1/assets") return send(200, { assets: ASSETS });
      if (req.url === "/v1/quote") return send(200, { best: QUOTE("near", "6600000"), alternatives: [QUOTE("chainflip", "6590000")], errors: [] });
      if (req.url === "/v1/swap") return send(201, { swap_id: "near:0xDEP", protocol: "near", deposit_address: "0xDEP", deposit_memo: null, amount_in: b.amount_in, amount_out: "6600000", min_amount_out: b.min_amount_out, origin_address: b.origin_address, destination_address: b.destination_address, expires_at: "2026-11-21T00:00:00Z", explorer_url: null });
      if (req.url === "/v1/swap/near%3A0xDEP") return send(200, { swap_id: "near:0xDEP", status: "PENDING", protocol: "near", origin_asset: ASSETS[0].asset_id, destination_asset: "ZEC.ZEC", amount_in: "50000000", quoted_amount_out: "6600000", deposit_address: "0xDEP", details: {} });
      if (req.url === "/v1/swap/near%3A0xDEP/deposit") return send(202, {});
      send(404, [{ kind: "invalid_request", detail: "no swap" }]);
    });
  });
  await new Promise((r) => router.listen(0, "127.0.0.1", r));
  routerUrl = `http://127.0.0.1:${router.address().port}`;
  remote = startServer({ port: 0, host: "127.0.0.1", apiBase: routerUrl });
  await new Promise((r) => remote.once("listening", r));
  remoteUrl = `http://127.0.0.1:${remote.address().port}/mcp`;
});

after(() => { router.close(); remote.close(); });

async function exercise(client) {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 5);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`);
    assert.ok(r.structuredContent, name);
    return r.structuredContent;
  };
  assert.equal((await call("list_assets", {})).chains.length, 2);
  const q = await call("get_quote", { from_asset: "BASE.USDC", to_asset: "ZEC.ZEC", amount: "50" });
  assert.equal(q.best.amount_out, "0.066");
  assert.equal(q.alternatives[0].min_amount_out, "0.0655705");
  const s = await call("create_swap", { from_asset: "BASE.USDC", to_asset: "ZEC.ZEC", amount: "50", destination_address: "t1abc", refund_address: "0xme" });
  assert.equal(s.swap_id, "near:0xDEP");
  assert.equal((await call("get_swap_status", { swap_id: s.swap_id })).status, "PENDING");
  assert.equal((await call("report_deposit", { swap_id: s.swap_id, tx_hash: "0xabc" })).ok, true);
  const bad = await client.callTool({ name: "get_quote", arguments: { from_asset: "NOPE.X", to_asset: "ZEC.ZEC", amount: "1" } });
  assert.equal(bad.isError, true);
}

test("stdio transport with the SDK client", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/stdio.js", import.meta.url))],
    env: { ...process.env, SHIELDZ_SWAP_BASE_URL: routerUrl },
    stderr: "ignore",
  }));
  assert.match(client.getInstructions() ?? "", /Never invent addresses/);
  await exercise(client);
  await client.close();
});

test("remote Streamable HTTP with the SDK client, forwarding X-Forwarded-For", async () => {
  seenXff.length = 0;
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(remoteUrl), { requestInit: { headers: { "x-forwarded-for": "198.51.100.7" } } }));
  await exercise(client);
  await client.close();
  assert.ok(seenXff.length > 0 && seenXff.every((x) => x === "198.51.100.7"), JSON.stringify(seenXff));
});

test("remote extras: server card, landing page, 404, 413", async () => {
  const base = remoteUrl.replace(/\/mcp$/, "");
  const card = await (await fetch(`${base}/.well-known/mcp/server-card.json`)).json();
  assert.equal(card.tools.length, 5);
  assert.match(await (await fetch(remoteUrl, { headers: { accept: "text/html" } })).text(), /Shieldz Swap MCP server/);
  assert.equal((await fetch(`${base}/admin`)).status, 404);
  assert.equal((await fetch(remoteUrl, { method: "POST", body: "x".repeat(70_000) })).status, 413);
});
