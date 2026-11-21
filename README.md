# Shieldz Swap MCP

[![npm](https://img.shields.io/npm/v/@shieldz/swap-mcp)](https://www.npmjs.com/package/@shieldz/swap-mcp)
[![CI](https://github.com/ShieldZCash/shieldz-swap-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ShieldZCash/shieldz-swap-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[![Shieldz Swap MCP MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/ShieldZCash/shieldz-swap-mcp/badges/card.svg)](https://glama.ai/mcp/servers/ShieldZCash/shieldz-swap-mcp)

Model Context Protocol server for [Shieldz Swap](https://swap.shieldz.cash). It lets an AI agent compare live cross-chain swap routes, create non-custodial swaps and track them to payout, across 340+ assets on 40+ chains: BTC, ETH, SOL, ZEC, USDC, USDT, TRON, BSC, Base, Arbitrum and more.

**Not using an agent?** The same swap runs in your browser at [swap.shieldz.cash](https://swap.shieldz.cash): pick two coins, paste your address and send from your own wallet.

- **No API key, no account, no KYC.**
- **Non-custodial.** A swap is a one-time deposit address. The user sends funds from their own wallet. The server never holds keys or signs anything.
- **Route comparison.** Every quote races NEAR Intents, Chainflip, Relay, MAYAChain, BOB Gateway and Garden and returns the best output plus the alternatives.
- **Flat 0.15% fee**, already included in the quoted output.
- **Remote or local.** Hosted Streamable HTTP endpoint, npm package, Docker image or a one-click `.mcpb` bundle.

## Tools

| Tool | Read-only | What it does |
| --- | --- | --- |
| `list_assets` | yes | Search routable assets by symbol or chain and get their exact ids. |
| `get_quote` | yes | Live quote for `from_asset`, `to_asset`, `amount` (normal units). Best route, alternatives, guaranteed minimum, all-in cost % and ETA. |
| `create_swap` | no | Re-quotes with the user's `destination_address` and `refund_address`, sets the minimum output floor and returns the deposit address, exact amount to send and expiry. Optional `protocol` pins a route. |
| `get_swap_status` | yes | `PENDING`, `PROCESSING`, `SUCCESS`, `FAILED`, `REFUNDED`, `INCOMPLETE_DEPOSIT` or `EXPIRED`, with deposit, payout and refund transaction links. |
| `report_deposit` | no | Optional: pass the deposit tx hash so the swap is detected faster. Never moves funds. |

Assets can be given as full ids (`BASE.USDC-0x8335...`) or `CHAIN.SYMBOL` shorthand (`ZEC.ZEC`, `BTC.BTC`, `ETH.ETH`, `BASE.USDC`). Amounts are normal decimal units (`"0.05"`), never wei or satoshis. Every tool returns `structuredContent` matching its `outputSchema`.

### Example

> **User:** Swap 50 USDC on Base to Zcash.
>
> **Agent** calls `get_quote` → best route NEAR Intents, about 0.0659 ZEC, minimum 0.0652, about 2.5 minutes. Shows the numbers and asks for the user's ZEC address and Base wallet.
>
> **Agent** calls `create_swap` → "Send exactly 50 USDC on BASE to `0x…` before 21:40 UTC."
>
> **Agent** calls `get_swap_status` → `SUCCESS`, payout tx link.

## Install

### Remote (no install)

```json
{
  "mcpServers": {
    "shieldz-swap": { "type": "http", "url": "https://swap.shieldz.cash/mcp" }
  }
}
```

- Claude Code: `claude mcp add --transport http shieldz-swap https://swap.shieldz.cash/mcp`
- Claude Desktop or claude.ai: Settings → Connectors → Add custom connector → `https://swap.shieldz.cash/mcp`
- Cursor, Windsurf, VS Code, Cline: add the JSON above to the client's MCP config.

### Local (stdio, npx)

```json
{
  "mcpServers": {
    "shieldz-swap": { "command": "npx", "args": ["-y", "@shieldz/swap-mcp"] }
  }
}
```

### Claude Desktop bundle

Download `shieldz-swap.mcpb` from the [latest release](https://github.com/ShieldZCash/shieldz-swap-mcp/releases/latest) and open it.

### Docker

```sh
docker run -i --rm ghcr.io/shieldzcash/shieldz-swap-mcp
```

## Configuration

| Variable | Default | Used by |
| --- | --- | --- |
| `SHIELDZ_SWAP_BASE_URL` | `https://swap.shieldz.cash` | stdio server: API base. |
| `PORT`, `HOST` | `8787`, `127.0.0.1` | `node dist/remote.js`: listen address. |
| `SWAP_API_BASE` | `https://swap.shieldz.cash` | `node dist/remote.js`: API base. |

The remote server serves `/mcp` (Streamable HTTP, stateless, JSON responses) and a static server card at `/.well-known/mcp/server-card.json`.

## Limits

The public API rate-limits per caller IP: about 20 quotes in a burst then one every 2 seconds, and about 6 swap creations in a burst then one every 20 seconds. Minimum and maximum amounts depend on the route; errors say what they are.

## Security and privacy

No keys, no custody, no stored conversations. See [SECURITY.md](SECURITY.md) and the [privacy policy](https://swap.shieldz.cash/privacy).

## Development

```sh
npm install
npm test          # unit tests + SDK client end-to-end tests over stdio and HTTP
./scripts/pack-mcpb.sh
```

## Related

- [@shieldz/mcp](https://github.com/ShieldZCash/shieldz-mcp): keyless crypto payment links, tip jars and pay-to-unlock for agents.

## License

MIT
