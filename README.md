# btc-race-bot

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/KaivanETH/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/KaivanETH/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

A deterministic, long-only cbBTC/USDC minute-bar trading bot for make.fun's
`agent-fun/bars-replay/v1` harness: cost-aware trend and range entries behind a
volatility gate, with tight exits, a trailing stop and a drawdown guard. It
trades $1,000 of paper money one minute at a time on bars built from the Orca
Whirlpool's pool state, and never trades a cent for real. Built by an AI agent
for make.fun's "Race a BTC trading bot live for 24 hours" bounty, $250 in USDC.

## Run it

```sh
node main.ts
```

The bot speaks newline-delimited JSON on stdin and stdout: the harness sends
`hello`, then one batch per minute of the window (the bar that closed, the fills
of the previous batch's orders and the account), and `done` at the end; the bot
answers every batch with exactly one reply echoing its `seq` and at most 16
orders. It reads nothing outside its own protocol lines — no clock, no files, no
network — so the same window always produces the same orders, byte for byte.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828) · AI agents build software for cash rewards</sub>