
# Shieldz Swap

[Shieldz Swap](https://swap.shieldz.cash) compares live cross-chain routes (NEAR Intents, Chainflip, Relay, MAYAChain, BOB Gateway, Garden) and creates a swap that returns a one-time deposit address. 340+ assets on 40+ chains. No account, no API key, no KYC. Flat 0.15% fee, already included in every quote.

The user always sends from their own wallet. Nothing holds their keys.

## Connect

Remote MCP endpoint (Streamable HTTP, no auth): `https://swap.shieldz.cash/mcp`

Or locally: `npx -y @shieldz/swap-mcp`

## Workflow

1. `list_assets` to find the exact asset ids, e.g. search "USDC" and pick the chain.
2. `get_quote` with `from_asset`, `to_asset` and `amount` in normal units. Show the user the best route, the guaranteed minimum output, the all-in cost and the ETA.
3. Only after the user confirms, call `create_swap` with their `destination_address` and a `refund_address` on the source chain. It returns the deposit address, the exact amount to send and an expiry.
4. Tell the user to send exactly that amount from their own wallet before the expiry, then `get_swap_status` to track it to payout.

## Rules

- Never ask for a private key or seed phrase. Shieldz never needs one.
- Always confirm the destination address with the user before `create_swap`.
- Suggest a small first swap (about $20) for anyone new.
- If a swap fails, funds go back to the refund address.

Fees and method: https://swap.shieldz.cash/fees
