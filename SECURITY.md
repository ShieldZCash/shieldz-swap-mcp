# Security

## Model

- The server never holds private keys, never signs transactions and never custodies funds. A swap is a one-time deposit address; the user sends funds from their own wallet.
- Refunds go to the `refund_address` the user supplied. `create_swap` refuses to return a deposit whose amounts differ from the quote it just took.
- No API keys or secrets are needed or stored. The server only calls the public Shieldz Swap API (`https://swap.shieldz.cash/v1/...`).
- The remote endpoint is stateless: no sessions, no stored conversations. It logs only the tool name, whether it failed, and timing.

## Reporting a vulnerability

Email support@shieldz.cash or open a private security advisory on this repository. Please do not open a public issue for security problems.
