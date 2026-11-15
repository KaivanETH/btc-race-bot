// Parameter sweep for the trend leg (LEG A) of main.ts on the dev bars.
// Usage: node tools/sweep.mjs <bars.ndjson.gz>   (prints a ranked table to stdout; writes nothing)
// Fill model: decide on close t, fill at open t+1; buy pays open*(1+2bps)*(1+impact), sell gets
// open*(1-2bps)/(1+impact); 4 bps fee + 4 bps pool fee per fill; impact ~7 bps per 1,000 USDC
// (the RULES.txt calibration at the frozen depth), scaled by depth relative to the first bar.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const lines = gunzipSync(readFileSync(process.argv[2])).toString().trim().split('\n');
const bars = lines.map((l) => JSON.parse(l)).map((b) => ({
  o: Number(b.o), c: Number(b.c), od: Number(b.o_depth[0]), cd: Number(b.c_depth[0]),
}));
const D0 = bars[0].od;

function impactBps(usdc, depth) { return 7 * (usdc / 1000) * (D0 / depth); }

function sim(p) {
  let cash = 1000, qty = 0, peakEq = 1000, maxDD = 0;
  let emaF = null, emaS = null, vol = null, prev = null;
  const kF = 2 / (p.fast + 1), kS = 2 / (p.slow + 1), kV = 2 / 31;
  let pending = null, entry = 0, peakPx = 0, held = 0, cool = 0;
  const trades = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    // fill pending order at this bar's open
    if (pending === 'buy') {
      const notional = cash * p.size;
      const fee = notional * 0.0008;
      const px = b.o * 1.0002 * (1 + impactBps(notional, b.od) / 10000);
      qty = (notional - fee) / px; cash -= notional; entry = px; peakPx = b.o; held = 0;
      trades.push({ cost: notional });
    } else if (pending === 'sell') {
      const val = qty * b.o;
      const px = b.o * 0.9998 / (1 + impactBps(val, b.od) / 10000);
      const gross = qty * px; cash += gross * (1 - 0.0008);
      const t = trades[trades.length - 1]; t.pnl = gross * 0.9992 - t.cost; qty = 0; cool = p.cool;
    }
    pending = null;
    const c = b.c;
    emaF = emaF === null ? c : emaF + kF * (c - emaF);
    emaS = emaS === null ? c : emaS + kS * (c - emaS);
    if (prev !== null) { const a = Math.abs((c - prev) / prev) * 10000; vol = vol === null ? a : vol + kV * (a - vol); }
    prev = c;
    const eq = cash + qty * c;
    if (eq > peakEq) peakEq = eq;
    maxDD = Math.max(maxDD, (peakEq - eq) / peakEq);
    if (i === bars.length - 1) break;
    if (i < Math.max(p.don, p.slow)) continue;
    if (qty > 0) {
      held++;
      if (c > peakPx) peakPx = c;
      const gain = (c / entry - 1) * 10000, fromPeak = (1 - c / peakPx) * 10000, pg = (peakPx / entry - 1) * 10000;
      let ex = gain <= -p.stop;
      if (p.target > 0 && gain >= p.target && (p.trail === 0 || fromPeak >= p.trail / 2)) ex = true;
      if (p.trail > 0 && pg > 26 && fromPeak >= p.trail) ex = true;
      if (emaF < emaS && held > 3) ex = true;
      if (ex) pending = 'sell';
      continue;
    }
    if (cool > 0) { cool--; continue; }
    if (p.vgate && (vol < 1.5 || vol > 40 || vol * 12 <= 26)) continue;
    let hi = -Infinity;
    for (let j = i - p.don; j < i; j++) if (bars[j].c > hi) hi = bars[j].c;
    const gap = (emaF - emaS) / c * 10000;
    if (gap > p.gap && c > hi && (!p.confirm || c > bars[i - 1].c)) pending = 'buy';
  }
  // flatten at last close
  if (qty > 0) {
    const b = bars[bars.length - 1], val = qty * b.c;
    const gross = qty * b.c * 0.9998 / (1 + impactBps(val, b.cd) / 10000);
    cash += gross * 0.9992; const t = trades[trades.length - 1]; t.pnl = gross * 0.9992 - t.cost;
  }
  const pn = trades.map((t) => t.pnl ?? 0);
  const net = cash - 1000;
  const best = pn.length ? Math.max(...pn) : 0;
  return { net, n: pn.length, win: pn.length ? pn.filter((x) => x > 0).length / pn.length : 0, maxDD, best };
}

const rows = [];
for (const don of [60, 120, 240, 480])
  for (const [fast, slow] of [[5, 20], [8, 34], [13, 55], [21, 89]])
    for (const confirm of [false, true])
      for (const target of [0, 40, 60, 90, 150])
        for (const trail of [0, 40, 70, 110])
          for (const stop of [60, 120])
            for (const size of [0.35, 0.55, 0.7])
              for (const vgate of [false, true])
                for (const gap of [0, 10]) {
                  const p = { don, fast, slow, confirm, target, trail, stop, size, vgate, gap, cool: 30 };
                  rows.push({ p, r: sim(p) });
                }
rows.sort((a, b) => b.r.net - a.r.net);
console.log(`combos ${rows.length}`);
console.log('net     n  win   maxDD  best  | don f/s conf tgt trail stop size vg gap');
for (const { p, r } of rows.slice(0, 40))
  console.log(`${r.net.toFixed(3).padStart(7)} ${String(r.n).padStart(2)} ${r.win.toFixed(2)} ${(r.maxDD * 100).toFixed(2)}% ${r.best.toFixed(2).padStart(5)} | ${p.don} ${p.fast}/${p.slow} ${p.confirm ? 'Y' : 'N'} ${p.target} ${p.trail} ${p.stop} ${p.size} ${p.vgate ? 'Y' : 'N'} ${p.gap}`);
const robust = rows.filter(({ r }) => r.n >= 3 && r.net > 0 && r.best < 0.6 * r.net && r.maxDD < 0.08);
console.log(`robust (n>=3, best trade <60% of net, maxDD<8%): ${robust.length}`);
for (const { p, r } of robust.slice(0, 15))
  console.log(`${r.net.toFixed(3).padStart(7)} ${String(r.n).padStart(2)} ${r.win.toFixed(2)} ${(r.maxDD * 100).toFixed(2)}% ${r.best.toFixed(2).padStart(5)} | ${p.don} ${p.fast}/${p.slow} ${p.confirm ? 'Y' : 'N'} ${p.target} ${p.trail} ${p.stop} ${p.size} ${p.vgate ? 'Y' : 'N'} ${p.gap}`);
// current main.ts leg-A setting for reference
const cur = sim({ don: 240, fast: 13, slow: 55, confirm: false, target: 0, trail: 70, stop: 120, size: 0.55, vgate: true, gap: 0, cool: 30 });
console.log(`current-legA net ${cur.net.toFixed(3)} n ${cur.n} win ${cur.win.toFixed(2)} maxDD ${(cur.maxDD * 100).toFixed(2)}%`);
