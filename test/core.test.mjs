import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toBaseUnits, fromBaseUnits, floorOf, resolveAsset, describeRouterErrors, runTool, clearAssetCache,
} from "../dist/core.js";
import { handle } from "../dist/remote.js";

const ASSETS = [
  { asset_id: "BASE.USDC-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", chain: "BASE", decimals: 6, verified: true, contract_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  { asset_id: "BASE.USDC-0xdeadbeef00000000000000000000000000000000", symbol: "USDC", chain: "BASE", decimals: 6, verified: false, verification: "not listed" },
  { asset_id: "ZEC.ZEC", symbol: "ZEC", chain: "ZEC", decimals: 8, verified: true },
  { asset_id: "ETH.ETH", symbol: "ETH", chain: "ETH", decimals: 18, verified: true },
  { asset_id: "BTC.BTC", symbol: "BTC", chain: "BTC", decimals: 8, verified: true },
  { asset_id: "BTC.BTC(OMNI)-coin", symbol: "BTC", chain: "BTC", decimals: 8, verified: true },
];

test("toBaseUnits", () => {
  assert.equal(toBaseUnits("50", 6), "50000000");
  assert.equal(toBaseUnits("0.1", 18), "100000000000000000");
  assert.equal(toBaseUnits("1.23456789", 8), "123456789");
  assert.equal(toBaseUnits("007.5", 6), "7500000");
  assert.equal(toBaseUnits("1_000", 6), "1000000000");
  assert.throws(() => toBaseUnits("1.1234567", 6), /more than 6 decimal/);
  assert.throws(() => toBaseUnits("0", 6), /greater than zero/);
  assert.throws(() => toBaseUnits("0.000", 6), /greater than zero/);
  for (const bad of ["-1", "1e6", "abc", "", "1.", ".5", "1,5", "0x10"]) assert.throws(() => toBaseUnits(bad, 6), /Invalid amount/, bad);
});

test("fromBaseUnits", () => {
  assert.equal(fromBaseUnits("6594910", 8), "0.0659491");
  assert.equal(fromBaseUnits("50000000", 6), "50");
  assert.equal(fromBaseUnits("1", 18), "0.000000000000000001");
  assert.equal(fromBaseUnits("123", 0), "123");
  assert.equal(fromBaseUnits(null, 6), null);
  assert.equal(fromBaseUnits("1.5", 6), null);
  for (const d of [0, 6, 8, 18]) assert.equal(toBaseUnits(fromBaseUnits("987654321987654321", d), d), "987654321987654321");
});

test("floorOf uses the quote floor, else derives it (Chainflip)", () => {
  assert.equal(floorOf({ min_amount_out: "900", amount_out: "1000" }, 50), "900");
  assert.equal(floorOf({ min_amount_out: null, amount_out: "1000000000000000000" }, 50), "995000000000000000");
});

test("resolveAsset", () => {
  assert.equal(resolveAsset(ASSETS, "zec.zec").asset_id, "ZEC.ZEC");
  assert.equal(resolveAsset(ASSETS, "BASE.USDC").asset_id, ASSETS[0].asset_id, "prefers the single verified match");
  assert.equal(resolveAsset(ASSETS, ASSETS[1].asset_id).verified, false, "exact id wins");
  assert.throws(() => resolveAsset(ASSETS, "BTC.BTC(OMNI)"), /Unknown asset/);
  assert.equal(resolveAsset(ASSETS, "BTC.BTC").asset_id, "BTC.BTC", "exact id beats shorthand");
  assert.throws(() => resolveAsset(ASSETS, "SOL.SOL"), /Unknown asset/);
});

test("describeRouterErrors drops unsupported noise and adds minimums", () => {
  const txt = describeRouterErrors([
    { kind: "unsupported_asset", protocol: "relay", detail: "Unavailable asset: ZEC.ZEC" },
    { kind: "amount_out_of_range", protocol: "near", detail: "too small", min_amount_in: "1000000" },
  ], ASSETS[0]);
  assert.match(txt, /near: amount_out_of_range/);
  assert.match(txt, /minimum 1 USDC/);
  assert.doesNotMatch(txt, /relay/);
  assert.match(describeRouterErrors([{ kind: "unsupported_asset", protocol: "relay", detail: "x" }]), /No protocol supports/);
});

// ---- tool flow against a fake router ----

const QUOTE = {
  protocol: "near", amount_in: "50000000", amount_out: "6594910", min_amount_out: "6532258",
  amount_in_usd: "49.98", amount_out_usd: "49.54", estimated_duration_seconds: 152, slippage: { bps: 95 },
};

function fakeRouter({ swapStatuses = [201], deposit = {} } = {}) {
  const calls = [];
  let swapN = 0;
  const f = async (url, init = {}) => {
    const path = url.replace("http://router", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method || "GET", body, headers: init.headers });
    const r = (status, obj) => new Response(JSON.stringify(obj), { status });
    if (path === "/v1/assets") return r(200, { assets: ASSETS });
    if (path === "/v1/quote") {
      if (body.amount_in === "1") return r(422, [{ kind: "no_liquidity", protocol: "near", detail: "No liquidity available" }]);
      return r(200, { best: QUOTE, alternatives: [], errors: [] });
    }
    if (path === "/v1/swap") {
      const status = swapStatuses[Math.min(swapN++, swapStatuses.length - 1)];
      if (status === 409) return r(409, [{ kind: "invalid_request", detail: "in flight" }]);
      return r(status, { swap_id: "near:0xDEP", protocol: "near", deposit_address: "0xDEP", deposit_memo: null, amount_in: body.amount_in, amount_out: "6594910", min_amount_out: body.min_amount_out, origin_address: body.origin_address, destination_address: body.destination_address, expires_at: "2026-11-21T00:00:00Z", ...deposit });
    }
    if (path === "/v1/swap/near%3A0xDEP") return r(200, { swap_id: "near:0xDEP", status: "SUCCESS", protocol: "near", origin_asset: ASSETS[0].asset_id, destination_asset: "ZEC.ZEC", amount_in: "50000000", quoted_amount_out: "6594910", deposit_address: "0xDEP", details: { amount_out: "6600000", payout_txs: [{ hash: "abc", url: "https://x/abc" }] } });
    return r(404, []);
  };
  return { calls, ctx: { base: "http://router", fetch: f, sleep: async () => {}, forwardedFor: "203.0.113.9" } };
}

const parse = (res) => JSON.parse(res.content[0].text);

test("get_quote converts units both ways and forwards client ip", async () => {
  clearAssetCache();
  const { calls, ctx } = fakeRouter();
  const res = await runTool(ctx, "get_quote", { from_asset: "BASE.USDC", to_asset: "ZEC.ZEC", amount: "50" });
  assert.equal(res.isError, undefined);
  const out = parse(res);
  assert.equal(calls.find((c) => c.path === "/v1/quote").body.amount_in, "50000000");
  assert.equal(out.best.amount_out, "0.0659491");
  assert.equal(out.best.min_amount_out, "0.06532258");
  assert.equal(calls[0].headers["x-forwarded-for"], "203.0.113.9");
  assert.ok(!("x-router-key" in calls[0].headers));
});

test("get_quote router error becomes isError text", async () => {
  clearAssetCache();
  const { ctx } = fakeRouter();
  const res = await runTool(ctx, "get_quote", { from_asset: "BASE.USDC", to_asset: "ZEC.ZEC", amount: "0.000001" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /no_liquidity/);
});

test("create_swap re-quotes with real addresses, sends floor, retries 409 with same key", async () => {
  clearAssetCache();
  const { calls, ctx } = fakeRouter({ swapStatuses: [409, 409, 201] });
  const res = await runTool(ctx, "create_swap", { from_asset: "BASE.USDC", to_asset: "ZEC.ZEC", amount: "50", destination_address: "t1dest", refund_address: "0xme", protocol: "near" });
  assert.equal(res.isError, undefined, res.content[0].text);
  const q = calls.find((c) => c.path === "/v1/quote").body;
  assert.equal(q.destination_address, "t1dest");
  assert.deepEqual(q.protocols, ["near"]);
  const swaps = calls.filter((c) => c.path === "/v1/swap");
  assert.equal(swaps.length, 3);
  assert.equal(new Set(swaps.map((s) => s.headers["idempotency-key"])).size, 1);
  const b = swaps[0].body;
  assert.equal(b.min_amount_out, "6532258");
  assert.equal(b.slippage_bps, 95);
  assert.equal(b.origin_address, "0xme");
  assert.ok(!("allow_placeholder_address" in b));
  const out = parse(res);
  assert.deepEqual(res.structuredContent, out);
  assert.equal(out.swap_id, "near:0xDEP");
  assert.equal(out.deposit_address, "0xDEP");
  assert.equal(out.send_exactly, "50 USDC on BASE");
  assert.deepEqual(out.warnings, []);
});

test("create_swap refuses missing addresses and mismatched deposits, warns on memo", async () => {
  clearAssetCache();
  let { ctx } = fakeRouter();
  let res = await runTool(ctx, "create_swap", { from_asset: "BASE.USDC", to_asset: "ZEC.ZEC", amount: "50", destination_address: " ", refund_address: "0xme" });
  assert.equal(res.isError, true);
  ({ ctx } = fakeRouter({ deposit: { min_amount_out: "1" } }));
  res = await runTool(ctx, "create_swap", { from_asset: "BASE.USDC", to_asset: "ZEC.ZEC", amount: "50", destination_address: "t1", refund_address: "0xme" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Do not send funds/);
  ({ ctx } = fakeRouter({ deposit: { deposit_memo: "=:ZEC.ZEC:t1" } }));
  res = await runTool(ctx, "create_swap", { from_asset: "BASE.USDC", to_asset: "ZEC.ZEC", amount: "50", destination_address: "t1", refund_address: "0xme" });
  assert.match(parse(res).warnings[0], /REQUIRES the memo/);
});

test("get_swap_status formats amounts", async () => {
  clearAssetCache();
  const { ctx } = fakeRouter();
  const out = parse(await runTool(ctx, "get_swap_status", { swap_id: "near:0xDEP" }));
  assert.equal(out.status, "SUCCESS");
  assert.equal(out.amount_out, "0.066 ZEC");
  assert.deepEqual(out.payout_txs, ["https://x/abc"]);
  for (const id of ["chainflip:123-Btc-45", "maya:door-bc1qxyz", "garden:abc_def.1"]) assert.match(id, /^[A-Za-z0-9:._-]+$/);
  const bad = await runTool(ctx, "get_swap_status", { swap_id: "../admin" });
  assert.equal(bad.isError, true);
});

// ---- remote JSON-RPC ----

test("remote handshake, list, call, errors", async () => {
  clearAssetCache();
  const { ctx } = fakeRouter();
  const rpc = async (obj) => JSON.parse((await handle("POST", "application/json", JSON.stringify(obj), ctx)).body);
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  const odd = await rpc({ jsonrpc: "2.0", id: 9, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.notEqual(odd.result.protocolVersion, "1999-01-01");
  assert.equal(init.result.serverInfo.name, "shieldz-swap");
  assert.equal((await handle("POST", "", JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), ctx)).status, 202);
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["list_assets", "get_quote", "create_swap", "get_swap_status", "report_deposit"]);
  assert.ok(list.result.tools.every((t) => !("run" in t)));
  const call = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_assets", arguments: { search: "zec" } } });
  assert.equal(JSON.parse(call.result.content[0].text).assets[0].asset_id, "ZEC.ZEC");
  assert.equal((await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } })).error.code, -32602);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 5, method: "x" })).error.code, -32601);
  assert.equal(JSON.parse((await handle("POST", "", "{bad", ctx)).body).error.code, -32700);
  const page = await handle("GET", "text/html", "", ctx);
  assert.match(page.body, /Shieldz Swap MCP server/);
  assert.equal((await handle("GET", "text/event-stream", "", ctx)).status, 405);
});

test("tool definitions are complete enough for directory scoring", async () => {
  const { toolList } = await import("../dist/core.js");
  for (const t of toolList()) {
    assert.ok(t.title && t.description.length > 120, t.name);
    assert.ok(t.annotations && "readOnlyHint" in t.annotations, t.name);
    assert.equal(t.outputSchema.type, "object", t.name);
    for (const [k, v] of Object.entries(t.inputSchema.properties)) assert.ok(v.description, `${t.name}.${k}`);
    for (const [k, v] of Object.entries(t.outputSchema.properties)) assert.ok(v.description || v.properties, `${t.name} out.${k}`);
  }
});

test("versions agree across package.json, server.json and code", async () => {
  const { readFileSync } = await import("node:fs");
  const { VERSION } = await import("../dist/core.js");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  const srv = JSON.parse(readFileSync(new URL("../server.json", import.meta.url)));
  assert.equal(pkg.version, VERSION);
  assert.equal(srv.version, VERSION);
  assert.equal(srv.packages[0].version, VERSION);
  assert.equal(srv.name, pkg.mcpName);
  assert.ok(srv.description.length <= 100);
});

test("server card lists the same tools", async () => {
  const { serverCard } = await import("../dist/remote.js");
  const card = serverCard();
  assert.equal(card.serverInfo.name, "shieldz-swap");
  assert.equal(card.tools.length, 5);
});
