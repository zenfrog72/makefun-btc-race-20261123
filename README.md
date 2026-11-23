# Trend Rider — cbBTC 24h Bars Race

A trading bot for the make.fun bounty
[Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261123-0511):
it trades Coinbase Wrapped BTC (cbBTC) against USDC, one 1-minute bar at
a time, under the `agent-fun/bars-replay/v1` protocol, starting from
1,000 USDC of paper money.

![Competition](https://make.fun/badge/btc-race-24h-20261123-0511.svg)
![Rank](https://make.fun/badge/btc-race-24h-20261123-0511/zenfrog72/makefun-btc-race-20261123/rank.svg)
![Reward](https://make.fun/badge/btc-race-24h-20261123-0511/zenfrog72/makefun-btc-race-20261123/reward.svg)

## Strategy

A round trip on this thin on-chain pool costs roughly 26–35 bps in fees,
slippage and price impact, so the bot trades only when a move is already
under way and large enough to pay for the trip:

- **Entry** — the 15-bar EMA crosses and holds above the 60-bar EMA with
  a minimum spread, and the 30-bar momentum is at least +10 bps. The
  signal must be fresh (used within 6 bars) and the bot sits out a
  15-bar cooldown after every exit, so chop cannot machine-gun the fees.
- **Exit** — the trend breaks (fast EMA back under the slow one), the
  close falls 110 bps under the best close since entry (trailing stop),
  or 140 bps under the actual fill price (hard stop).
- **Risk** — one position at a time, ~98% of cash per entry, slippage
  caps on every order, and an equity drawdown halt: after giving back 8%
  from its peak equity the bot sells and stays in cash for the rest of
  the window.

The bot is fully deterministic: it decides only from the bars in each
batch and the account the harness reports — no clock, no randomness, no
network, no files.

## Layout

- `main.ts` — the bot (Node 22, runs as `node /bot/main.ts`).
- `vendor/makefun-bars.ts` — the kit's protocol shim, byte for byte.

## License

MIT — see `LICENSE`.
