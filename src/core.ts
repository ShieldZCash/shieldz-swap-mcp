// Shared by the stdio and remote servers: API client, unit conversion and tool definitions.
import { randomUUID } from "node:crypto";

export const VERSION = "0.1.0";
export const SITE = "https://swap.shieldz.cash";

export interface Ctx {
  base: string;
  // Remote server only: the caller's X-Forwarded-For chain, passed through so
  // the router rate-limits each MCP user on their own address.
  forwardedFor?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public body: unknown) {
    super(message);
  }
}

interface RouterError {
  kind?: string;
  protocol?: string | null;
  detail?: string;
  min_amount_in?: string;
  max_amount_in?: string;
  min_notional_usd?: string | number;
}

export async function call(ctx: Ctx, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "user-agent": `shieldz-swap-mcp/${VERSION}`,
    ...(init.body ? { "content-type": "application/json" } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };
  if (ctx.forwardedFor) headers["x-forwarded-for"] = ctx.forwardedFor;
  const res = await (ctx.fetch ?? fetch)(ctx.base + path, {
    ...init,
    headers,
    signal: AbortSignal.timeout(init.timeoutMs ?? 45_000),
  });
  const text = await res.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, body };
}

// ---------- units ----------

export function toBaseUnits(amount: string, decimals: number): string {
  const s = String(amount).trim().replace(/_/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount "${amount}". Use a plain decimal number like "100" or "0.25".`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`Amount "${amount}" has more than ${decimals} decimal places, the most this asset supports.`);
  const base = (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
  if (base === "0") throw new Error("Amount must be greater than zero.");
  return base;
}

export function fromBaseUnits(base: string | null | undefined, decimals: number): string | null {
  if (base == null || !/^\d+$/.test(String(base))) return null;
  const s = String(base).padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals).replace(/^0+(?=\d)/, "");
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

// Same rule as dex-ui minAmountOut(): Chainflip quotes carry no floor, derive it.
export function floorOf(quote: { min_amount_out?: string | null; amount_out?: string }, bps: number): string {
  if (quote.min_amount_out) return quote.min_amount_out;
  const out = BigInt(quote.amount_out || "0");
  return ((out * BigInt(10_000 - bps)) / 10_000n).toString();
}

export const DEFAULT_SLIPPAGE_BPS = 50;

// ---------- assets ----------

export interface Asset {
  asset_id: string;
  symbol: string;
  chain: string;
  decimals: number;
  usd_price?: string;
  verified?: boolean;
  verification?: string;
  contract_address?: string;
  protocols?: string[];
}

let assetCache: { at: number; base: string; list: Asset[] } | null = null;

export function clearAssetCache() { assetCache = null; }

export async function getAssets(ctx: Ctx): Promise<Asset[]> {
  if (assetCache && assetCache.base === ctx.base && Date.now() - assetCache.at < 60_000) return assetCache.list;
  const { status, body } = await call(ctx, "/v1/assets", { timeoutMs: 20_000 });
  if (status !== 200 || !Array.isArray(body?.assets)) throw new ApiError(`Could not load the asset list (HTTP ${status}).`, status, body);
  assetCache = { at: Date.now(), base: ctx.base, list: body.assets };
  return body.assets;
}

// Accepts an exact asset id ("BASE.USDC-0x8335...") or CHAIN.SYMBOL shorthand ("BASE.USDC").
export function resolveAsset(list: Asset[], input: string): Asset {
  const q = String(input || "").trim();
  const exact = list.find((a) => a.asset_id === q) ?? list.find((a) => a.asset_id.toLowerCase() === q.toLowerCase());
  if (exact) return exact;
  const [chain, symbol] = q.split(".");
  if (chain && symbol) {
    const hits = list.filter((a) => a.chain.toLowerCase() === chain.toLowerCase() && a.symbol.toLowerCase() === symbol.toLowerCase());
    const verified = hits.filter((a) => a.verified);
    if (hits.length === 1) return hits[0];
    if (verified.length === 1) return verified[0];
    if (hits.length > 1) {
      throw new Error(`"${q}" is ambiguous. Use one of these asset ids: ${hits.map((a) => a.asset_id).join(", ")}`);
    }
  }
  throw new Error(`Unknown asset "${q}". Call list_assets to find the asset id (format CHAIN.SYMBOL or CHAIN.SYMBOL-CONTRACT).`);
}

function assetView(a: Asset) {
  return {
    asset_id: a.asset_id,
    symbol: a.symbol,
    chain: a.chain,
    decimals: a.decimals,
    usd_price: a.usd_price ?? null,
    verified: !!a.verified,
    ...(a.verified ? {} : { warning: a.verification || "Contract not verified, check it before swapping." }),
  };
}

// ---------- errors ----------

export function describeRouterErrors(body: unknown, origin?: Asset): string {
  const list: RouterError[] = Array.isArray(body) ? body : Array.isArray((body as any)?.errors) ? (body as any).errors : [];
  if (!list.length) return typeof body === "string" && body ? body.slice(0, 300) : "Request failed.";
  const relevant = list.filter((e) => e.kind !== "unsupported_asset");
  const use = relevant.length ? relevant : list;
  const lines = use.slice(0, 6).map((e) => {
    let s = `${e.protocol ?? "router"}: ${e.kind ?? "error"}${e.detail ? ` (${e.detail})` : ""}`;
    if (origin && e.min_amount_in) s += `; minimum ${fromBaseUnits(e.min_amount_in, origin.decimals)} ${origin.symbol}`;
    if (origin && e.max_amount_in) s += `; maximum ${fromBaseUnits(e.max_amount_in, origin.decimals)} ${origin.symbol}`;
    if (e.min_notional_usd != null) s += `; minimum about $${e.min_notional_usd}`;
    return s;
  });
  if (!relevant.length) lines.unshift("No protocol supports this pair.");
  return lines.join("\n");
}

// ---------- quotes ----------

function routeView(q: any, from: Asset, to: Asset) {
  const inUsd = Number(q.amount_in_usd);
  const outUsd = Number(q.amount_out_usd);
  const bps = q.slippage?.bps ?? DEFAULT_SLIPPAGE_BPS;
  return {
    protocol: q.protocol,
    amount_out: fromBaseUnits(q.amount_out, to.decimals),
    min_amount_out: fromBaseUnits(floorOf(q, bps), to.decimals),
    amount_out_usd: Number.isFinite(outUsd) ? +outUsd.toFixed(2) : null,
    total_cost_pct: Number.isFinite(inUsd) && Number.isFinite(outUsd) && inUsd > 0 ? +((1 - outUsd / inUsd) * 100).toFixed(3) : null,
    estimated_seconds: q.estimated_duration_seconds ?? null,
    slippage_bps: bps,
  };
}

async function quoteRaw(ctx: Ctx, from: Asset, to: Asset, amountIn: string, extra: Record<string, unknown> = {}) {
  const { status, body } = await call(ctx, "/v1/quote", {
    method: "POST",
    body: JSON.stringify({ origin_asset: from.asset_id, destination_asset: to.asset_id, amount_in: amountIn, ...extra }),
  });
  if (status !== 200 || !body?.best) throw new ApiError(describeRouterErrors(body, from), status, body);
  return body as { best: any; alternatives: any[] };
}

// ---------- tools ----------

type Schema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  outputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations: Record<string, unknown>;
  run: (ctx: Ctx, args: any) => Promise<Record<string, unknown>>;
}

const SWAP_ID_RE = /^[A-Za-z0-9:._-]{1,256}$/;
const PROTOCOLS = ["near", "chainflip", "relay", "maya", "bob", "garden"];

const str = (description: string): Schema => ({ type: "string", description });
const nstr = (description: string): Schema => ({ type: ["string", "null"], description });
const nnum = (description: string): Schema => ({ type: ["number", "null"], description });

const assetProp = (what: string) =>
  str(`${what} asset. Either an exact asset_id from list_assets ("BASE.USDC-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") or CHAIN.SYMBOL shorthand ("ZEC.ZEC", "BTC.BTC", "ETH.ETH", "SOL.SOL", "BASE.USDC"). Shorthand resolves to the verified asset; if it is ambiguous the error lists the exact ids to use.`);

const amountProp = str(`Amount of from_asset in normal decimal units as a string ("100", "0.05"), NOT base units or wei. Digits and one optional dot only; no commas, signs or exponents.`);

const assetOut: Schema = {
  type: "object",
  description: "A routable asset.",
  properties: {
    asset_id: str("Exact id to pass to get_quote / create_swap."),
    symbol: str("Ticker, e.g. USDC."),
    chain: str("Chain code, e.g. BASE, ETH, BTC, ZEC."),
    decimals: { type: "integer", description: "Token decimals." },
    usd_price: nstr("Latest USD price as a decimal string, null if unknown."),
    verified: { type: "boolean", description: "True when the contract is verified by CoinGecko, DefiLlama or CoinMarketCap." },
    warning: str("Present only for unverified assets: why to double-check the contract."),
  },
  required: ["asset_id", "symbol", "chain", "decimals", "verified"],
};

const routeOut: Schema = {
  type: "object",
  description: "One quoted route.",
  properties: {
    protocol: str("Route provider: near (NEAR Intents), chainflip, relay, maya, bob (BOB Gateway) or garden."),
    amount_out: nstr("Expected output in normal units of to_asset, after all fees."),
    min_amount_out: nstr("Guaranteed floor in normal units; below this the swap refunds instead."),
    amount_out_usd: nnum("Expected output in USD."),
    total_cost_pct: nnum("All-in cost versus input USD value, in percent (fees + spread)."),
    estimated_seconds: nnum("Estimated time from deposit to payout."),
    slippage_bps: { type: "integer", description: "Slippage tolerance used for the floor, in basis points." },
  },
  required: ["protocol", "amount_out", "min_amount_out", "slippage_bps"],
};

export const TOOLS: ToolDef[] = [
  {
    name: "list_assets",
    title: "List swappable assets",
    description:
      "Search the 340+ assets on 40+ chains that Shieldz Swap can route and return their exact asset ids. Use it when you are unsure of an id or which chains support a token (e.g. every chain that has USDC). Skip it for common native coins: get_quote and create_swap already accept shorthand like ZEC.ZEC or BTC.BTC. With no filters it also returns the list of chain codes. Read-only; the list is cached for 60 seconds.",
    inputSchema: {
      type: "object",
      properties: {
        search: str('Case-insensitive symbol or asset id fragment, e.g. "usdc", "zec", "0x8335".'),
        chain: str("Exact chain code filter, e.g. ETH, BASE, ARB, OP, POL, BSC, SOL, BTC, ZEC, TRON, NEAR. Leave empty for all chains."),
        limit: { type: "integer", minimum: 1, maximum: 100, default: 40, description: "Maximum assets to return (1-100, default 40). Verified assets come first." },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        total_matches: { type: "integer", description: "How many assets matched before the limit." },
        assets: { type: "array", items: assetOut, description: "Matching assets, verified first." },
        chains: { type: "array", items: { type: "string" }, description: "All chain codes; only present when no filter was given." },
      },
      required: ["total_matches", "assets"],
    },
    annotations: { title: "List swappable assets", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(ctx, args) {
      const list = await getAssets(ctx);
      const s = String(args.search ?? "").trim().toLowerCase();
      const c = String(args.chain ?? "").trim().toLowerCase();
      const hits = list.filter((a) =>
        (!c || a.chain.toLowerCase() === c) &&
        (!s || a.symbol.toLowerCase().includes(s) || a.asset_id.toLowerCase().includes(s)));
      hits.sort((a, b) => Number(!!b.verified) - Number(!!a.verified));
      const limit = Math.min(Math.max(Number(args.limit) || 40, 1), 100);
      const out: Record<string, unknown> = { total_matches: hits.length, assets: hits.slice(0, limit).map(assetView) };
      if (!c && !s) out.chains = [...new Set(list.map((a) => a.chain))].sort();
      return out;
    },
  },
  {
    name: "get_quote",
    title: "Quote a cross-chain swap",
    description:
      "Get live prices for swapping one asset into another, across chains, by racing NEAR Intents, Chainflip, Relay, MAYAChain, BOB Gateway and Garden. Returns the best route and the alternatives, with output after fees, guaranteed minimum, all-in cost % and ETA. Use it to answer \"how much X do I get for Y\" and to show the user the numbers before create_swap. It creates nothing and needs no addresses. Quotes move with the market, so do not reuse one after a few minutes; create_swap re-quotes on its own. Shieldz charges a flat 0.15% (already in amount_out). Errors explain unsupported pairs or minimum and maximum amounts. Rate-limited per caller (roughly 20 quotes in a burst, then one every 2 seconds).",
    inputSchema: {
      type: "object",
      properties: {
        from_asset: assetProp("Source (what the user sends)."),
        to_asset: assetProp("Destination (what the user receives)."),
        amount: amountProp,
      },
      required: ["from_asset", "to_asset", "amount"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        from: assetOut,
        to: assetOut,
        amount_in: str("Input amount in normal units, as understood."),
        best: routeOut,
        alternatives: { type: "array", items: routeOut, description: "Other routes that answered, best output first." },
        next_step: str("What to do next."),
      },
      required: ["from", "to", "amount_in", "best", "alternatives"],
    },
    annotations: { title: "Quote a cross-chain swap", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(ctx, args) {
      const list = await getAssets(ctx);
      const from = resolveAsset(list, args.from_asset);
      const to = resolveAsset(list, args.to_asset);
      const amountIn = toBaseUnits(args.amount, from.decimals);
      const sel = await quoteRaw(ctx, from, to, amountIn);
      const alts = [...(sel.alternatives ?? [])].sort((a, b) => (BigInt(b.amount_out || 0) > BigInt(a.amount_out || 0) ? 1 : -1));
      return {
        from: assetView(from),
        to: assetView(to),
        amount_in: fromBaseUnits(amountIn, from.decimals),
        best: routeView(sel.best, from, to),
        alternatives: alts.map((q) => routeView(q, from, to)),
        next_step: "To execute: confirm amount and route with the user, ask for their destination address and a refund address on the source chain, then call create_swap.",
      };
    },
  },
  {
    name: "create_swap",
    title: "Create a swap (deposit address)",
    description:
      "Open a non-custodial swap and return a one-time deposit address. Use it only after the user has seen a quote, agreed to the amount and route, and given you both addresses. NEVER invent, guess or reuse addresses from elsewhere in the conversation. It takes a fresh quote with the real addresses (or the protocol you pin), sets the minimum output from that quote, and refuses to return a deposit whose amounts differ from what was quoted. Nothing moves until the user sends exactly send_exactly from their own wallet before expires_at; the server never holds keys or signs. If the swap cannot complete, funds go back to refund_address. Each call creates a new deposit address, so do not call it again to \"retry\" a swap the user already funded. Rate-limited per caller (about 6 swaps in a burst, then one every 20 seconds).",
    inputSchema: {
      type: "object",
      properties: {
        from_asset: assetProp("Source (what the user sends)."),
        to_asset: assetProp("Destination (what the user receives)."),
        amount: str("Exact amount of from_asset the user will send, in normal decimal units (\"100\", \"0.05\"), not base units."),
        destination_address: str("Address the user gave you on the destination chain (to_asset's chain). Swapped funds are paid here."),
        refund_address: str("Address the user gave you on the source chain (from_asset's chain), usually the wallet they send from. Refunds go here if the swap fails or the price drops below the floor."),
        protocol: { type: "string", enum: PROTOCOLS, description: "Optional. Pin this route, e.g. the alternative the user chose from get_quote. Omit to use the best route at creation time." },
      },
      required: ["from_asset", "to_asset", "amount", "destination_address", "refund_address"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        swap_id: str("Id for get_swap_status and report_deposit."),
        protocol: str("Route used."),
        send_exactly: str("Exact amount, asset and chain the user must send."),
        deposit_address: str("One-time address to send the funds to."),
        deposit_memo: nstr("Memo the deposit MUST carry, or null when none is needed."),
        token_contract: str("Token contract of from_asset, when it is a token rather than a native coin."),
        expected_out: str("Expected payout with asset and chain."),
        minimum_out: str("Guaranteed minimum payout; below this the swap refunds."),
        destination_address: str("Payout address, echoed back for the user to check."),
        refund_address: str("Refund address, echoed back for the user to check."),
        expires_at: nstr("ISO time after which the deposit address must not be used."),
        explorer_url: nstr("Public tracking link, when the route has one."),
        warnings: { type: "array", items: { type: "string" }, description: "Must be shown to the user (memo requirements, unverified tokens)." },
        next_step: str("What to tell the user next."),
      },
      required: ["swap_id", "protocol", "send_exactly", "deposit_address", "deposit_memo", "expected_out", "minimum_out", "destination_address", "refund_address", "warnings"],
    },
    annotations: { title: "Create a swap (deposit address)", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(ctx, args) {
      const dest = String(args.destination_address ?? "").trim();
      const refund = String(args.refund_address ?? "").trim();
      if (!dest || !refund) throw new Error("destination_address and refund_address are both required and must come from the user.");
      if (args.protocol != null && !PROTOCOLS.includes(String(args.protocol))) throw new Error(`protocol must be one of ${PROTOCOLS.join(", ")}.`);
      const list = await getAssets(ctx);
      const from = resolveAsset(list, args.from_asset);
      const to = resolveAsset(list, args.to_asset);
      const amountIn = toBaseUnits(args.amount, from.decimals);
      const extra: Record<string, unknown> = { origin_address: refund, destination_address: dest };
      if (args.protocol) extra.protocols = [args.protocol];
      const sel = await quoteRaw(ctx, from, to, amountIn, extra);
      const q = sel.best;
      const bps = q.slippage?.bps ?? DEFAULT_SLIPPAGE_BPS;
      const floor = floorOf(q, bps);
      const req = {
        protocol: q.protocol,
        origin_asset: from.asset_id,
        destination_asset: to.asset_id,
        origin_address: refund,
        destination_address: dest,
        amount_in: amountIn,
        min_amount_out: floor,
        slippage_bps: bps,
      };
      const key = randomUUID();
      const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
      const post = () => call(ctx, "/v1/swap", { method: "POST", body: JSON.stringify(req), headers: { "idempotency-key": key } });
      let res = await post();
      for (let i = 0; res.status === 409 && i < 5; i++) {
        await sleep(1000);
        res = await post();
      }
      if (res.status !== 201 && res.status !== 200) throw new ApiError(describeRouterErrors(res.body, from), res.status, res.body);
      const d = res.body;
      if (d.amount_in !== amountIn || d.min_amount_out !== floor) {
        throw new Error("The router returned a deposit for different amounts than quoted. Do not send funds; get a new quote and try again.");
      }
      const warnings: string[] = [];
      if (d.deposit_memo) warnings.push(`This deposit REQUIRES the memo "${d.deposit_memo}". Sending without it loses the funds. Only use a wallet that can attach a memo.`);
      if (d.router) warnings.push(`Token deposits on this route must go through the router contract ${d.router}, not a plain transfer.`);
      if (!from.verified) warnings.push(`Source asset contract is not verified: ${from.verification ?? ""}`.trim());
      if (!to.verified) warnings.push(`Destination asset contract is not verified: ${to.verification ?? ""}`.trim());
      return {
        swap_id: d.swap_id,
        protocol: d.protocol,
        send_exactly: `${fromBaseUnits(amountIn, from.decimals)} ${from.symbol} on ${from.chain}`,
        deposit_address: d.deposit_address,
        deposit_memo: d.deposit_memo ?? null,
        ...(from.contract_address ? { token_contract: from.contract_address } : {}),
        expected_out: `${fromBaseUnits(d.amount_out, to.decimals)} ${to.symbol} on ${to.chain}`,
        minimum_out: `${fromBaseUnits(d.min_amount_out, to.decimals)} ${to.symbol}`,
        destination_address: d.destination_address,
        refund_address: d.origin_address,
        expires_at: d.expires_at ?? null,
        explorer_url: d.explorer_url ?? null,
        warnings,
        next_step: "Show the user deposit_address, send_exactly, expires_at and every warning. Ask them to send from their own wallet, then track it with get_swap_status (report_deposit with the tx hash speeds up detection).",
      };
    },
  },
  {
    name: "get_swap_status",
    title: "Check swap status",
    description:
      "Look up a swap made with create_swap by its swap_id and explain where it is: PENDING (no deposit seen yet), PROCESSING, SUCCESS, FAILED, REFUNDED, INCOMPLETE_DEPOSIT (less than required arrived) or EXPIRED (address closed, never send to it). Returns amounts in normal units and the deposit, payout and refund transaction links. Use it when the user asks whether their swap arrived. Read-only and safe to repeat; poll every 30 seconds or more, not in a tight loop.",
    inputSchema: {
      type: "object",
      properties: { swap_id: str('swap_id exactly as returned by create_swap, e.g. "near:0xAbc..." or "chainflip:123-Btc-45".') },
      required: ["swap_id"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        swap_id: str("The swap."),
        status: { type: "string", enum: ["PENDING", "PROCESSING", "SUCCESS", "FAILED", "REFUNDED", "INCOMPLETE_DEPOSIT", "EXPIRED"], description: "Current state." },
        meaning: str("Plain-language explanation of the status."),
        protocol: str("Route used."),
        amount_in: nstr("Expected deposit."),
        quoted_out: nstr("Output quoted at creation."),
        amount_out: nstr("Actual payout, once known."),
        refunded: nstr("Refunded amount, if any."),
        reason: nstr("Failure or refund reason from the route, if any."),
        deposit_address: str("Where the deposit goes."),
        deposit_txs: { type: "array", items: { type: "string" }, description: "Deposit transaction links or hashes." },
        payout_txs: { type: "array", items: { type: "string" }, description: "Payout transaction links or hashes." },
        refund_txs: { type: "array", items: { type: "string" }, description: "Refund transaction links or hashes." },
        expires_at: nstr("When the deposit address stops accepting funds."),
        explorer_url: nstr("Public tracking link."),
      },
      required: ["swap_id", "status", "meaning"],
    },
    annotations: { title: "Check swap status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(ctx, args) {
      const id = String(args.swap_id ?? "").trim();
      if (!SWAP_ID_RE.test(id)) throw new Error("Invalid swap_id. Pass it exactly as create_swap returned it.");
      const { status, body } = await call(ctx, `/v1/swap/${encodeURIComponent(id)}`, { timeoutMs: 20_000 });
      if (status === 404) throw new ApiError("No swap with that id.", 404, body);
      if (status !== 200) throw new ApiError(describeRouterErrors(body), status, body);
      const list = await getAssets(ctx).catch(() => [] as Asset[]);
      const from = list.find((a) => a.asset_id === body.origin_asset);
      const to = list.find((a) => a.asset_id === body.destination_asset);
      const fmt = (v: string | null | undefined, a?: Asset) => (v == null ? null : a ? `${fromBaseUnits(v, a.decimals)} ${a.symbol}` : String(v));
      const det = body.details ?? {};
      const txs = (l: any[] | undefined) => (l ?? []).map((t) => t.url || t.hash);
      return {
        swap_id: body.swap_id,
        status: body.status,
        meaning: STATUS_TEXT[body.status] ?? String(body.status),
        protocol: body.protocol,
        amount_in: fmt(body.amount_in, from),
        quoted_out: fmt(body.quoted_amount_out, to),
        amount_out: fmt(det.amount_out, to),
        refunded: fmt(det.refunded_amount, from),
        reason: det.reason ?? null,
        deposit_address: body.deposit_address,
        deposit_txs: txs(det.deposit_txs),
        payout_txs: txs(det.payout_txs),
        refund_txs: txs(det.refund_txs),
        expires_at: body.expires_at ?? null,
        explorer_url: body.explorer_url ?? null,
      };
    },
  },
  {
    name: "report_deposit",
    title: "Report a deposit transaction",
    description:
      "Tell the router the hash of the deposit transaction the user just sent, so the swap is detected immediately instead of on the next scan. Optional: swaps are detected without it, and it never moves funds. Use it once, right after the user shares their tx hash, then follow up with get_swap_status. Calling it again with the same hash is harmless.",
    inputSchema: {
      type: "object",
      properties: {
        swap_id: str("swap_id returned by create_swap."),
        tx_hash: str("Hash of the user's deposit transaction on the source chain (0x... on EVM chains). Letters and digits only, up to 128 characters."),
      },
      required: ["swap_id", "tx_hash"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean", description: "True when the router accepted the hash." },
        next_step: str("What to do next."),
      },
      required: ["ok"],
    },
    annotations: { title: "Report a deposit transaction", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(ctx, args) {
      const id = String(args.swap_id ?? "").trim();
      if (!SWAP_ID_RE.test(id)) throw new Error("Invalid swap_id. Pass it exactly as create_swap returned it.");
      const { status, body } = await call(ctx, `/v1/swap/${encodeURIComponent(id)}/deposit`, {
        method: "POST",
        body: JSON.stringify({ tx_hash: String(args.tx_hash ?? "").trim() }),
        timeoutMs: 20_000,
      });
      if (status === 404) throw new ApiError("No swap with that id.", 404, body);
      if (status >= 300) throw new ApiError(describeRouterErrors(body), status, body);
      return { ok: true, next_step: "Check progress with get_swap_status." };
    },
  },
];

const STATUS_TEXT: Record<string, string> = {
  PENDING: "Waiting for the deposit to arrive.",
  PROCESSING: "Deposit received, swap in progress.",
  SUCCESS: "Done, funds delivered to the destination address.",
  FAILED: "The swap failed.",
  REFUNDED: "Refunded to the refund address.",
  INCOMPLETE_DEPOSIT: "Less than the required amount arrived; the swap is on hold.",
  EXPIRED: "The deposit address expired before any funds arrived. Do not send to it; create a new swap.",
};

export const INSTRUCTIONS =
  "Shieldz Swap: non-custodial cross-chain swaps across 40+ chains, no account or KYC. Flow: list_assets (only if unsure of an id) -> get_quote -> show the numbers and get the user's OK -> create_swap with addresses the user gave you -> the user sends the deposit from their own wallet -> get_swap_status. Never invent addresses, always relay create_swap warnings, and never tell the user to send to an expired deposit address.";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export async function runTool(ctx: Ctx, name: string, args: unknown): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  try {
    const out = await tool.run(ctx, (args && typeof args === "object" ? args : {}) as Record<string, unknown>);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
  } catch (e: any) {
    const msg = e?.name === "TimeoutError" ? "The swap API did not answer in time, try again." : e?.message || String(e);
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

export function toolList() {
  return TOOLS.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({ name, title, description, inputSchema, outputSchema, annotations }));
}
