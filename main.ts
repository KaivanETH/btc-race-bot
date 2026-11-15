// =====================================================================================================
// btc-race-bot — long-only intraday cbBTC/USDC bot for the agent-fun/bars-replay/v1 harness.
//
// Self-contained: this file speaks the JSON line protocol itself (hello, one batch per minute, done),
// using only node:readline. It answers every batch with exactly one reply echoing its seq.
//
// STRATEGY IN PLAIN LANGUAGE
//
// A full-size round trip costs ~26 bps (4 bps fee each way, the pool's 4 bps fee, 2 bps slippage each
// way, plus price impact that grows with size). So the bot only trades when the market is moving
// enough for a move to clear that cost, and it sizes below full equity to cut impact.
//
// 1. Volatility gate. An ATR-like measure (EMA of each bar's true range in bps) estimates the typical
//    minute range. If sqrt(HORIZON) * ATR is below what a round trip costs times a safety factor, no
//    new entry is taken: the market is too quiet for any move to pay.
//
// 2. Trend leg (Donchian + EMA breakout). When the close breaks above the highest close of the last
//    DON bars, the fast EMA is above the slow EMA and the slow EMA is rising, the bot buys and rides
//    the move with a trailing stop.
//
// 3. Mean-reversion leg (ranging fade). When the market is ranging (fast and slow EMA close together,
//    measured in ATRs) and the close drops far below the slow EMA (a z-score below -Z_ENTRY of the
//    rolling standard deviation), it buys the dip and takes profit when price returns toward the mean.
//
// 4. Risk controls. One position at most. Every position has a hard stop (a multiple of ATR, floored),
//    a trailing stop once in profit, and a time stop. After an exit there is a cooldown. A drawdown
//    guard shrinks the entry size as equity falls below its peak and stops new entries entirely when
//    drawdown passes a hard limit, keeping max drawdown far under 25%.
//
// Money is integer quote units (bigint) everywhere an order is built; floats are only used for the
// indicators. No clock, no randomness, no files, no environment: same input -> same replies.
// =====================================================================================================

import { createInterface } from 'node:readline';

const PROTOCOL = 'agent-fun/bars-replay/v1';

// ---------------------------------------------------------------- parameters
const EMA_FAST = 20;
const EMA_SLOW = 90;
const ATR_LEN = 30;
const DON = 240;          // Donchian lookback (bars) for the breakout leg
const SD_LEN = 240;       // rolling window for the mean-reversion z-score
const Z_ENTRY = 2.6;      // buy dips below mean by this many standard deviations
const RANGE_MAX = 1.5;    // |emaFast - emaSlow| / ATR below this = ranging
const HORIZON = 60;       // bars a trade is expected to need
const COST_BPS = 26;      // full round-trip cost estimate
const GATE_MULT = 2.0;    // expected move must be GATE_MULT x cost
const STOP_ATR = 4.0;     // hard stop distance in ATRs
const STOP_MIN_BPS = 35;  // ... but never tighter than this
const TRAIL_ATR = 7.0;    // trailing stop distance from peak, in ATRs
const TRAIL_ARM_BPS = 40; // trailing stop arms once peak gain clears this
const MR_TP_BPS = 40;     // mean-reversion: minimum gain before a take-profit on mean touch
const MAX_HOLD = 360;     // time stop, bars
const COOLDOWN = 20;      // bars after an exit before a new entry
const BASE_SIZE_BPS = 6000n; // 60% of equity per entry
const MIN_SIZE_BPS = 2500n;  // floor after losses
const DD_HALT = 0.12;     // no new entries past a 12% drawdown from peak
const MAX_SLIP = 150;     // max_slippage_bps on every order
const WARM = Math.max(DON, SD_LEN, EMA_SLOW) + 1;

// ---------------------------------------------------------------- state
let symbol = 'CBBTC';
let minNotional = 1_000_000n;
let warmupBars = 0;
let lastSeq = -1;
let nextId = 1;

const closes: number[] = [];
let prevClose = 0;
let emaF = 0;
let emaS = 0;
let emaSPrev = 0;
let atrBps = 0;
let nBars = 0;

let inPos = false;
let pendingBuy = false;
let pendingSell = false;
let mode: 'trend' | 'mr' = 'trend';
let entryPx = 0;
let peakPx = 0;
let entryBar = 0;
let stopBps = 0;
let cooldownUntil = 0;
let peakEquity = 0n;

function alpha(n: number): number {
  return 2 / (n + 1);
}

function updateIndicators(c: number, h: number, l: number): void {
  if (nBars === 0) {
    emaF = emaS = emaSPrev = c;
    atrBps = ((h - l) / c) * 1e4;
  } else {
    emaSPrev = emaS;
    emaF += alpha(EMA_FAST) * (c - emaF);
    emaS += alpha(EMA_SLOW) * (c - emaS);
    const tr = Math.max(h, prevClose) - Math.min(l, prevClose);
    atrBps += alpha(ATR_LEN) * ((tr / c) * 1e4 - atrBps);
  }
  prevClose = c;
  closes.push(c);
  if (closes.length > 1000) closes.splice(0, closes.length - 600);
  nBars++;
}

function highestPrior(n: number): number {
  let m = -Infinity;
  const end = closes.length - 1; // exclude the current bar
  for (let i = Math.max(0, end - n); i < end; i++) if (closes[i]! > m) m = closes[i]!;
  return m;
}

function meanSd(n: number): [number, number] {
  const start = Math.max(0, closes.length - n);
  let s = 0;
  let s2 = 0;
  const k = closes.length - start;
  for (let i = start; i < closes.length; i++) {
    s += closes[i]!;
    s2 += closes[i]! * closes[i]!;
  }
  const m = s / k;
  const v = Math.max(0, s2 / k - m * m);
  return [m, Math.sqrt(v)];
}

function sizeFraction(equity: bigint): bigint {
  if (peakEquity === 0n) return BASE_SIZE_BPS;
  // drawdown in bps of peak, integer math
  const ddBps = ((peakEquity - equity) * 10_000n) / peakEquity;
  if (ddBps <= 0n) return BASE_SIZE_BPS;
  // lose 1000 bps of size per 100 bps of drawdown, down to the floor
  const s = BASE_SIZE_BPS - ddBps * 10n;
  return s < MIN_SIZE_BPS ? MIN_SIZE_BPS : s;
}

type Order =
  | { side: 'buy'; client_id: string; symbol: string; notional_quote_units: string; max_slippage_bps: number }
  | { side: 'sell'; client_id: string; symbol: string; qty: string; max_slippage_bps: number };

function decide(batch: any): Order[] {
  const orders: Order[] = [];
  const account = batch.account;
  const cash = BigInt(account.cash_quote_units);
  const equity = BigInt(account.equity_quote_units);
  if (equity > peakEquity) peakEquity = equity;

  // fold fills of last reply
  for (const f of batch.fills as any[]) {
    if (f.side === 'buy') {
      pendingBuy = false;
      if (f.status !== 'filled') cooldownUntil = batch.seq + 2;
    } else {
      pendingSell = false;
      if (f.status === 'filled') cooldownUntil = batch.seq + COOLDOWN;
    }
  }
  let qty = 0n;
  for (const p of account.positions as any[]) if (p.symbol === symbol) qty += BigInt(p.qty);
  const held = qty > 0n;
  if (held && !inPos) {
    inPos = true;
    peakPx = entryPx = prevClose;
    entryBar = batch.seq;
  }
  if (!held) inPos = false;

  const bar = (batch.bars as any[]).find((b) => b.symbol === symbol);
  if (bar === undefined) return orders; // no bar this minute: no fresh information
  const c = Number(bar.c);
  updateIndicators(c, Number(bar.h), Number(bar.l));

  if (batch.seq < warmupBars || nBars < WARM) return orders;

  // ------------------------------------------------ exits
  if (inPos) {
    if (pendingSell) return orders;
    if (c > peakPx) peakPx = c;
    const gainBps = ((c - entryPx) / entryPx) * 1e4;
    const peakGainBps = ((peakPx - entryPx) / entryPx) * 1e4;
    const fromPeakBps = ((peakPx - c) / peakPx) * 1e4;
    let exit = false;
    if (gainBps <= -stopBps) exit = true;
    if (peakGainBps >= TRAIL_ARM_BPS && fromPeakBps >= Math.max(TRAIL_ATR * atrBps, 15)) exit = true;
    if (mode === 'mr' && gainBps >= MR_TP_BPS && c >= emaS) exit = true;
    if (mode === 'trend' && emaF < emaS && gainBps > COST_BPS) exit = true;
    if (batch.seq - entryBar >= MAX_HOLD) exit = true;
    if (exit) {
      orders.push({ side: 'sell', client_id: `s${nextId++}`, symbol, qty: qty.toString(), max_slippage_bps: MAX_SLIP });
      pendingSell = true;
    }
    return orders;
  }

  // ------------------------------------------------ entries
  if (pendingBuy || batch.seq < cooldownUntil) return orders;
  if (peakEquity > 0n && Number(peakEquity - equity) / Number(peakEquity) > DD_HALT) return orders;
  const expectedMove = atrBps * Math.sqrt(HORIZON);
  if (expectedMove < COST_BPS * GATE_MULT) return orders; // volatility gate

  const don = highestPrior(DON);
  const [mean, sd] = meanSd(SD_LEN);
  const z = sd > 0 ? (c - mean) / sd : 0;
  const spreadAtr = atrBps > 0 ? Math.abs((emaF - emaS) / c) * 1e4 / atrBps : 99;

  let signal: 'trend' | 'mr' | null = null;
  if (c > don && emaF > emaS && emaS > emaSPrev) signal = 'trend';
  else if (spreadAtr < RANGE_MAX && z < -Z_ENTRY && ((mean - c) / c) * 1e4 > COST_BPS * 1.5) signal = 'mr';
  if (signal === null) return orders;

  let notional = (equity * sizeFraction(equity)) / 10_000n;
  if (notional > cash) notional = cash;
  if (notional < minNotional * 5n) return orders;
  mode = signal;
  stopBps = Math.max(STOP_ATR * atrBps, STOP_MIN_BPS);
  orders.push({ side: 'buy', client_id: `b${nextId++}`, symbol, notional_quote_units: notional.toString(), max_slippage_bps: MAX_SLIP });
  pendingBuy = true;
  return orders;
}

// ---------------------------------------------------------------- line loop
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let done = false;
for await (const line of rl) {
  if (line.trim() === '') continue;
  const msg = JSON.parse(line);
  if (msg.type === 'hello') {
    if (msg.protocol !== PROTOCOL) throw new Error(`unexpected protocol ${msg.protocol}`);
    symbol = msg.symbols[0].symbol;
    minNotional = BigInt(msg.fees.min_notional_quote_units);
    warmupBars = msg.warmup_bars ?? 0;
    peakEquity = BigInt(msg.capital.quote_units);
  } else if (msg.type === 'batch') {
    lastSeq = msg.seq;
    let orders = decide(msg);
    if (orders.length > 16) orders = orders.slice(0, 16);
    const text = JSON.stringify({ type: 'reply', seq: msg.seq, orders });
    if (!process.stdout.write(text + '\n')) await new Promise<void>((r) => process.stdout.once('drain', () => r()));
  } else if (msg.type === 'done') {
    done = true;
    break;
  } else {
    throw new Error(`unknown message type ${msg.type}`);
  }
}
rl.close();
process.stdin.destroy();
if (!done) process.exitCode = 1;
void lastSeq;
