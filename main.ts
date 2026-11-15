// Two-leg long-only cbBTC/USDC bot for agent-fun/bars-replay/v1.
//
// LEG A (trend): EMA(fast) above EMA(slow) and the close breaking the prior Donchian high,
//   taken only when realized volatility says the move can clear round-trip costs.
// LEG B (range / reversion): when the EMA gap is near zero, fade exhaustion: k consecutive down
//   closes or a fast RSI dip; sell into the bounce after a few bars.
// Shared: volatility gate, one position, size scaled by volatility, profit target, trailing and
//   hard stops, drawdown guard that halves size after a retreat from the equity peak.
//
// Dev window (falling ~4%): LEG B only fires on a deep, turned dip; LEG A carries the profit.
// Deterministic: no clock, no env, no randomness. Indicators run on float64 + - * / only;
// every money amount is a bigint of quote units.

import { createInterface } from 'node:readline';

// ---- parameters ----
const FAST = 13;
const SLOW = 55;
const DONCHIAN = 240;
const VOL_SPAN = 30; // EMA span of |log-ish return| in bps
const RSI_SPAN = 6;
const COST_BPS = 26; // full round trip
const MIN_VOL_BPS = 1.5; // per-bar mean abs move below this: too quiet
const MAX_VOL_BPS = 40; // above this: too wild
const FLAT_GAP_BPS = 12; // |emaF - emaS| / price considered flat for LEG B
const DOWN_RUN = 6;
const RSI_LO = 12;
const B_DIP_BPS = 30; // close at least this far under EMA(slow)
const B_TARGET_BPS = 60;
const B_MAX_HOLD = 30;
const B_STOP_BPS = 70;
let minRsi = 50;
const A_STOP_BPS = 120;
const A_TRAIL_BPS = 70;
const B_TRAIL_ARM_BPS = 40;
const B_TRAIL_BPS = 20;
const BASE_WEIGHT_BPS = 5500n;
const MIN_WEIGHT_BPS = 4000n;
const MAX_WEIGHT_BPS = 7000n;
const DD_GUARD_BPS = 200n;
const MAX_SLIP = 100;
const COOLDOWN = 30;

// ---- state ----
let hello: any = null;
let warmup = 0;
let emaF: number | null = null;
let emaS: number | null = null;
const warmF: number[] = [];
const warmS: number[] = [];
const closes: number[] = [];
let vol: number | null = null;
let rsiUp: number | null = null;
let rsiDn: number | null = null;
let downRun = 0;
let prev: number | null = null;
let peakEquity = 0n;
let leg: 'A' | 'B' | null = null;
let entryPx = 0;
let peakPx = 0;
let heldBars = 0;
let cooldown = 0;
let orderNo = 0;

function emaStep(v: number | null, warm: number[], span: number, x: number): number | null {
  if (v !== null) return v + (2 / (span + 1)) * (x - v);
  warm.push(x);
  if (warm.length === span) return warm.reduce((a, b) => a + b, 0) / span;
  return null;
}

function onBar(c: number): void {
  emaF = emaStep(emaF, warmF, FAST, c);
  emaS = emaStep(emaS, warmS, SLOW, c);
  if (prev !== null) {
    const r = ((c - prev) / prev) * 10000;
    const a = r < 0 ? -r : r;
    vol = vol === null ? a : vol + (2 / (VOL_SPAN + 1)) * (a - vol);
    const up = r > 0 ? r : 0;
    const dn = r < 0 ? -r : 0;
    const k = 1 / RSI_SPAN;
    rsiUp = rsiUp === null ? up : rsiUp + k * (up - rsiUp);
    rsiDn = rsiDn === null ? dn : rsiDn + k * (dn - rsiDn);
    if (c < prev) downRun++;
    else if (c > prev) downRun = 0;
  }
  prev = c;
  closes.push(c);
  if (closes.length > DONCHIAN + 1) closes.shift();
}

function rsi(): number {
  if (rsiUp === null || rsiDn === null) return 50;
  const t = rsiUp + rsiDn;
  return t === 0 ? 50 : (100 * rsiUp) / t;
}

function donchianHigh(): number | null {
  if (closes.length < DONCHIAN + 1) return null;
  let m = -Infinity;
  for (let i = 0; i < closes.length - 1; i++) if (closes[i] > m) m = closes[i];
  return m;
}

function weightBps(equity: bigint): bigint {
  let w = BASE_WEIGHT_BPS;
  if (vol !== null && vol > 0) {
    // target ~4 bps/bar: calmer -> bigger, wilder -> smaller
    const scaled = Math.floor((Number(BASE_WEIGHT_BPS) * 4) / vol);
    w = BigInt(scaled);
  }
  if (w < MIN_WEIGHT_BPS) w = MIN_WEIGHT_BPS;
  if (w > MAX_WEIGHT_BPS) w = MAX_WEIGHT_BPS;
  if (peakEquity > 0n && equity * 10000n < peakEquity * (10000n - DD_GUARD_BPS)) w = w / 2n;
  return w;
}

function decide(batch: any): any[] {
  const sym = hello.symbols[0].symbol as string;
  const bar = (batch.bars as any[]).find((b) => b.symbol === sym);
  const acct = batch.account;
  const equity = BigInt(acct.equity_quote_units);
  const cash = BigInt(acct.cash_quote_units);
  if (equity > peakEquity) peakEquity = equity;
  if (bar === undefined) return [];
  const c = Number(bar.c);
  const prevBar = prev;
  const runBefore = downRun;
  onBar(c);
  // exhaustion seen on the bars just before a turn up
  const lastRun = runBefore;
  const r = rsi();
  minRsi = r < minRsi + 3 ? r : minRsi + 3; // recent low of RSI, relaxing 3 points a bar
  if (batch.seq < warmup) return [];
  if (cooldown > 0) cooldown--;

  const pos = (acct.positions as any[]).find((p) => p.symbol === sym);
  const qty = pos ? BigInt(pos.qty) : 0n;

  if (qty > 0n) {
    if (leg === null) {
      leg = 'B';
      entryPx = c;
      peakPx = c;
      heldBars = 0;
    }
    heldBars++;
    if (c > peakPx) peakPx = c;
    const gain = ((c - entryPx) / entryPx) * 10000;
    const fromPeak = ((peakPx - c) / peakPx) * 10000;
    const peakGain = ((peakPx - entryPx) / entryPx) * 10000;
    let exit = false;
    if (leg === 'A') {
      if (gain <= -A_STOP_BPS) exit = true;
      if (peakGain > COST_BPS && fromPeak >= A_TRAIL_BPS) exit = true;
      if (emaF !== null && emaS !== null && emaF < emaS && heldBars > 3) exit = true;
    } else {
      if (gain <= -B_STOP_BPS) exit = true;
      if (gain >= B_TARGET_BPS) exit = true;
      if (peakGain >= B_TRAIL_ARM_BPS && fromPeak >= B_TRAIL_BPS) exit = true;
      if (heldBars >= B_MAX_HOLD) exit = true;
    }
    if (exit) {
      return [{ side: 'sell', client_id: `s${orderNo++}`, symbol: sym, qty: qty.toString(), max_slippage_bps: MAX_SLIP }];
    }
    return [];
  }

  if (leg !== null) {
    leg = null;
    cooldown = COOLDOWN;
  }
  if (cooldown > 0 || emaF === null || emaS === null || vol === null) return [];
  if (vol < MIN_VOL_BPS || vol > MAX_VOL_BPS) return [];

  const gapBps = ((emaF - emaS) / c) * 10000;
  let want: 'A' | 'B' | null = null;
  const dh = donchianHigh();
  if (gapBps > 0 && dh !== null && c > dh && vol * 12 > COST_BPS) want = 'A';
  else if (
    (gapBps < 0 ? -gapBps : gapBps) < FLAT_GAP_BPS &&
    (lastRun >= DOWN_RUN || minRsi < RSI_LO) &&
    prevBar !== null && c > prevBar && ((emaS - c) / c) * 10000 > B_DIP_BPS
  ) want = 'B';
  if (want === null) return [];

  let notional = (equity * weightBps(equity)) / 10000n;
  if (notional > cash) notional = cash;
  if (notional < BigInt(hello.fees.min_notional_quote_units)) return [];
  leg = want;
  entryPx = c;
  peakPx = c;
  heldBars = 0;
  return [{ side: 'buy', client_id: `b${orderNo++}`, symbol: sym, notional_quote_units: notional.toString(), max_slippage_bps: MAX_SLIP }];
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');

rl.on('line', (line) => {
  if (line.trim() === '') return;
  const msg = JSON.parse(line);
  if (msg.type === 'hello') {
    hello = msg;
    warmup = msg.warmup_bars ?? 0; // hello takes no reply in bars-replay/v1
  } else if (msg.type === 'batch') {
    let orders: any[] = [];
    // A buy that was rejected leaves no position; leg resets on the next flat batch.
    orders = decide(msg);
    out({ type: 'reply', seq: msg.seq, orders });
  } else if (msg.type === 'done') {
    rl.close();
    process.exit(0);
  }
});
