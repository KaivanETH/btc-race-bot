// =====================================================================================================
// btc-race-bot — long-only intraday cbBTC/USDC bot for the agent-fun/bars-replay/v1 harness.
//
// Self-contained JSON line protocol (hello -> ready, one reply per batch echoing seq, exit on done),
// using only node:readline. Deterministic: no clock, no randomness, no files, no environment.
//
// STRATEGY
// A full-size round trip costs ~26 bps, so every entry needs a move that clears that with margin.
//  - Features per minute: fast/slow EMA, Donchian high of prior closes, ATR-like range EMA (bps),
//    count of direction changes over a short window (choppiness).
//  - Trend regime: slow EMA rising, fast EMA above slow with a strong slope and a new Donchian high
//    -> breakout-continuation entry, ridden with a profit target, an ATR trailing stop and a hard stop.
//  - Chop regime: EMA gap ~0, low ATR, many direction flips, and an exhaustion bar (a big down bar far
//    below the slow EMA) -> short mean-reversion fade, exited within a few bars.
//  - Sizing: 40-70% of equity, scaled down when ATR is high; halved while realized equity is more
//    than 2% below its peak. One position at most.
// Money is integer quote units (bigint) wherever an order is built.
// =====================================================================================================

import { createInterface } from 'node:readline';

const PROTOCOL = 'agent-fun/bars-replay/v1';

// ---------------------------------------------------------------- parameters
const EMA_FAST = 15;
const EMA_SLOW = 90;
const ATR_LEN = 30;
const DON = 240;           // Donchian lookback for breakouts (120 caught bear-market bounces)
const FLIP_LEN = 20;       // window for direction-change counting
const COST_BPS = 26;
const SLOPE_MIN_BPS = 3.0; // fast EMA slope per bar (bps) for a "strong" trend
const TREND_TP_BPS = 120;  // trend profit target (250 gave the winner back)
const TREND_STOP_ATR = 4;
const TREND_STOP_MIN = 40;
const TRAIL_ATR = 5;
const TRAIL_ARM_BPS = 45;
const MR_GAP_ATR = 0.6;    // |emaF-emaS| in ATRs below this = flat
const MR_ATR_MAX = 9;      // only fade when ATR (bps) is below this
const MR_FLIPS_MIN = 99;   // fade leg disabled: dev window is a persistent downtrend, fades bled
const MR_DEV_BPS = 55;     // close must be this far below slow EMA
const MR_TP_BPS = 45;
const MR_STOP_BPS = 45;
const MR_MAX_HOLD = 6;
const TREND_MAX_HOLD = 300;
const COOLDOWN = 15;
const SIZE_MAX_BPS = 7000n;
const SIZE_MIN_BPS = 4000n;
const DD_CUT = 0.02;
const MAX_SLIP = 120;
const WARM = Math.max(DON, EMA_SLOW) + 2;

// ---------------------------------------------------------------- state
let symbol = 'CBBTC';
let minNotional = 1_000_000n;
let warmupBars = 0;
let nextId = 1;

const closes: number[] = [];
let prevClose = 0;
let emaF = 0;
let emaFPrev = 0;
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
let peakRealized = 0n;

const alpha = (n: number): number => 2 / (n + 1);

function updateIndicators(c: number, h: number, l: number): void {
  if (nBars === 0) {
    emaF = emaFPrev = emaS = emaSPrev = c;
    atrBps = ((h - l) / c) * 1e4;
  } else {
    emaFPrev = emaF;
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
  const end = closes.length - 1;
  for (let i = Math.max(0, end - n); i < end; i++) if (closes[i]! > m) m = closes[i]!;
  return m;
}

function flips(n: number): number {
  let k = 0;
  let prev = 0;
  for (let i = Math.max(1, closes.length - n); i < closes.length; i++) {
    const d = Math.sign(closes[i]! - closes[i - 1]!);
    if (d !== 0 && prev !== 0 && d !== prev) k++;
    if (d !== 0) prev = d;
  }
  return k;
}

function sizeFraction(equity: bigint): bigint {
  // scale between max and min by ATR: calm -> max, hot -> min
  const t = Math.min(1, Math.max(0, (atrBps - 6) / 10));
  let s = SIZE_MAX_BPS - BigInt(Math.round(t * 3000));
  if (s < SIZE_MIN_BPS) s = SIZE_MIN_BPS;
  if (peakRealized > 0n && Number(peakRealized - equity) / Number(peakRealized) > DD_CUT) s /= 2n;
  return s;
}

type Order =
  | { side: 'buy'; client_id: string; symbol: string; notional_quote_units: string; max_slippage_bps: number }
  | { side: 'sell'; client_id: string; symbol: string; qty: string; max_slippage_bps: number };

function decide(batch: any): Order[] {
  const orders: Order[] = [];
  const account = batch.account;
  const cash = BigInt(account.cash_quote_units);
  const equity = BigInt(account.equity_quote_units);

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
  if (!held) {
    inPos = false;
    // flat: equity is realized
    if (equity > peakRealized) peakRealized = equity;
  }

  const bar = (batch.bars as any[]).find((b) => b.symbol === symbol);
  if (bar === undefined) return orders;
  const c = Number(bar.c);
  const o = Number(bar.o);
  updateIndicators(c, Number(bar.h), Number(bar.l));

  if (batch.seq < warmupBars || nBars < WARM) return orders;

  // ------------------------------------------------ exits
  if (inPos) {
    if (pendingSell) return orders;
    if (c > peakPx) peakPx = c;
    const gainBps = ((c - entryPx) / entryPx) * 1e4;
    const peakGainBps = ((peakPx - entryPx) / entryPx) * 1e4;
    const fromPeakBps = ((peakPx - c) / peakPx) * 1e4;
    const held = batch.seq - entryBar;
    let exit = false;
    if (gainBps <= -stopBps) exit = true;
    if (mode === 'trend') {
      if (gainBps >= TREND_TP_BPS) exit = true;
      if (peakGainBps >= TRAIL_ARM_BPS && fromPeakBps >= Math.max(TRAIL_ATR * atrBps, 15)) exit = true;
      if (held >= TREND_MAX_HOLD) exit = true;
    } else {
      if (gainBps >= MR_TP_BPS) exit = true;
      if (held >= MR_MAX_HOLD) exit = true;
    }
    if (exit) {
      orders.push({ side: 'sell', client_id: `s${nextId++}`, symbol, qty: qty.toString(), max_slippage_bps: MAX_SLIP });
      pendingSell = true;
    }
    return orders;
  }

  // ------------------------------------------------ entries
  if (pendingBuy || batch.seq < cooldownUntil) return orders;

  const slopeF = ((emaF - emaFPrev) / c) * 1e4;
  const gapAtr = atrBps > 0 ? Math.abs((emaF - emaS) / c) * 1e4 / atrBps : 99;
  const don = highestPrior(DON);
  const devBps = ((emaS - c) / c) * 1e4;
  const barBps = ((c - o) / o) * 1e4;

  let signal: 'trend' | 'mr' | null = null;
  if (c > don && emaF > emaS && emaS > emaSPrev && slopeF >= SLOPE_MIN_BPS) signal = 'trend';
  else if (gapAtr < MR_GAP_ATR && atrBps < MR_ATR_MAX && flips(FLIP_LEN) >= MR_FLIPS_MIN &&
           devBps > MR_DEV_BPS && barBps < -2 * atrBps) signal = 'mr';
  if (signal === null) return orders;

  let notional = (equity * sizeFraction(equity)) / 10_000n;
  if (notional > cash) notional = cash;
  if (notional < minNotional) return orders;
  mode = signal;
  stopBps = signal === 'trend' ? Math.max(TREND_STOP_ATR * atrBps, TREND_STOP_MIN) : MR_STOP_BPS;
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
    peakRealized = BigInt(msg.capital.quote_units);
  } else if (msg.type === 'batch') {
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
