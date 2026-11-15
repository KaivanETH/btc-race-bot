// Robustness report for the trend leg (LEG A) of main.ts on the dev bars. Prints only; writes nothing.
// Usage: node tools/sweep.mjs <bars.ndjson.gz>
// Fill model: decide on close t, fill at open t+1; buy pays open*(1+2bps)*(1+impact), sell gets
// open*(1-2bps)/(1+impact); 4 bps fee + 4 bps pool fee per fill; impact ~7 bps per 1,000 USDC
// scaled by open depth relative to the first bar. Flatten at the last close. Trade PnL is
// attributed to the block of its entry bar.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const lines = gunzipSync(readFileSync(process.argv[2])).toString().trim().split('\n');
const bars = lines.map((l) => JSON.parse(l)).map((b) => ({
  o: Number(b.o), c: Number(b.c), od: Number(b.o_depth[0]), cd: Number(b.c_depth[0]),
}));
const N = bars.length, D0 = bars[0].od;
const impactBps = (usdc, depth) => 7 * (usdc / 1000) * (D0 / depth);

// current main.ts LEG A
const CUR = { don: 240, fast: 13, slow: 55, target: 75, trail: 70, stop: 120, size: 0.65, vgate: true, cool: 30, extra: null };

function sim(p, skip = new Set()) {
  let cash = 1000, qty = 0, peakEq = 1000, maxDD = 0;
  let emaF = null, emaS = null, vol = null, prev = null, prevF = null;
  const kF = 2 / (p.fast + 1), kS = 2 / (p.slow + 1), kV = 2 / 31;
  let pending = null, pendKind = null, entry = 0, peakPx = 0, held = 0, cool = 0, sigNo = 0;
  const trades = [];
  const rets = [];
  for (let i = 0; i < N; i++) {
    const b = bars[i];
    if (pending === 'buy') {
      const notional = cash * p.size, fee = notional * 0.0008;
      const px = b.o * 1.0002 * (1 + impactBps(notional, b.od) / 10000);
      qty = (notional - fee) / px; cash -= notional; entry = px; peakPx = b.o; held = 0;
      trades.push({ cost: notional, bar: i, kind: pendKind });
    } else if (pending === 'sell') {
      const px = b.o * 0.9998 / (1 + impactBps(qty * b.o, b.od) / 10000);
      const gross = qty * px; cash += gross * 0.9992;
      trades[trades.length - 1].pnl = gross * 0.9992 - trades[trades.length - 1].cost; qty = 0; cool = p.cool;
    }
    pending = null;
    const c = b.c;
    prevF = emaF;
    emaF = emaF === null ? c : emaF + kF * (c - emaF);
    emaS = emaS === null ? c : emaS + kS * (c - emaS);
    if (prev !== null) { const r = (c - prev) / prev * 10000; rets.push(r); const a = Math.abs(r); vol = vol === null ? a : vol + kV * (a - vol); }
    const prevC = prev;
    prev = c;
    const eq = cash + qty * c;
    if (eq > peakEq) peakEq = eq;
    maxDD = Math.max(maxDD, (peakEq - eq) / peakEq);
    if (i === N - 1) break;
    if (i < Math.max(p.don, p.slow)) continue;
    if (qty > 0) {
      held++;
      if (c > peakPx) peakPx = c;
      const gain = (c / entry - 1) * 10000, fromPeak = (1 - c / peakPx) * 10000, pg = (peakPx / entry - 1) * 10000;
      let ex = gain <= -p.stop || gain >= p.target;
      if (pg > 26 && fromPeak >= p.trail) ex = true;
      if (emaF < emaS && held > 3) ex = true;
      if (ex) pending = 'sell';
      continue;
    }
    if (cool > 0) { cool--; continue; }
    if (p.vgate && (vol < 1.5 || vol > 40)) continue;
    let hi = -Infinity;
    for (let j = i - p.don; j < i; j++) if (bars[j].c > hi) hi = bars[j].c;
    const gap = (emaF - emaS) / c * 10000;
    let kind = null;
    if (gap > 0 && c > hi && vol * 12 > 26) kind = 'A';
    else if (p.extra) kind = p.extra(p, { c, prevC, emaF, emaS, prevF, gap, vol, rets }) ? 'X' : null;
    if (kind !== null) {
      const k = sigNo++;
      if (!skip.has(k)) { pending = 'buy'; pendKind = kind; }
    }
  }
  if (qty > 0) {
    const b = bars[N - 1];
    const gross = qty * b.c * 0.9998 / (1 + impactBps(qty * b.c, b.cd) / 10000);
    cash += gross * 0.9992; trades[trades.length - 1].pnl = gross * 0.9992 - trades[trades.length - 1].cost;
  }
  return { net: cash - 1000, trades, maxDD };
}

function blocks(trades, n) {
  const out = Array.from({ length: n }, () => ({ pnl: 0, n: 0 }));
  for (const t of trades) { const k = Math.min(n - 1, Math.floor((t.bar * n) / N)); out[k].pnl += t.pnl; out[k].n++; }
  return out;
}
const fmtB = (bs) => bs.map((b) => `${b.pnl.toFixed(2)}(${b.n})`).join(' ');

function report(name, p) {
  const r = sim(p);
  const b4 = blocks(r.trades, 4), b12 = blocks(r.trades, 12);
  const wins = r.trades.filter((t) => t.pnl > 0).length;
  console.log(`== ${name}: net ${r.net.toFixed(3)} trades ${r.trades.length} wins ${wins} losses ${r.trades.length - wins} maxDD ${(r.maxDD * 100).toFixed(2)}% nonneg6h ${b4.filter((b) => b.pnl >= 0).length}/4`);
  console.log(`   6h : ${fmtB(b4)}`);
  console.log(`   2h : ${fmtB(b12)}`);
  console.log(`   entries: ${r.trades.map((t) => `${t.kind}@${t.bar}:${t.pnl.toFixed(2)}`).join(' ')}`);
  return { r, b4 };
}

const base = report('CURRENT leg A', CUR);
// entry offset: remove each entry signal in turn
const sigs = base.r.trades.length;
for (let k = 0; k < sigs + 1; k++) {
  const r = sim(CUR, new Set([k]));
  console.log(`   without entry-signal #${k}: net ${r.net.toFixed(3)} trades ${r.trades.length}`);
}

// candidate second entry types
const cands = [];
for (const G of [10, 20, 30]) for (const T of [4, 8])
  cands.push([`a pullback gap>${G} touch<${T}`, (p, s) => s.gap > G && s.prevC !== null && s.prevF !== null &&
    (s.prevC - s.prevF) / s.prevF * 10000 < T && s.c > s.prevC && s.c > s.emaF]);
for (const G of [10, 20, 30]) for (const K of [1.5, 2.5])
  cands.push([`b continuation gap>${G} 2 bars>${K}xvol`, (p, s) => { const n = s.rets.length; return s.gap > G && n >= 2 && s.rets[n - 1] > K * s.vol && s.rets[n - 2] > K * s.vol; }]);
for (const Q of [3, 5]) for (const J of [10, 20])
  cands.push([`c quiet30<${Q}bps jump>${J}`, (p, s) => { const n = s.rets.length; if (n < 31 || s.rets[n - 1] < J) return false; for (let j = n - 31; j < n - 1; j++) if (Math.abs(s.rets[j]) > Q) return false; return true; }]);

const ok = [];
for (const [name, fn] of cands) {
  const p = { ...CUR, extra: fn };
  const r = sim(p), b4 = blocks(r.trades, 4);
  const nn = b4.filter((b) => b.pnl >= 0).length;
  const pass = r.net > base.r.net && nn >= 3 && r.maxDD < 0.08;
  console.log(`${pass ? 'PASS' : 'fail'} ${name.padEnd(34)} net ${r.net.toFixed(3)} trades ${r.trades.length} maxDD ${(r.maxDD * 100).toFixed(2)}% 6h ${fmtB(b4)}`);
  if (pass) ok.push([name, p]);
}
for (const [name, p] of ok) report(`PASS ${name}`, p);
