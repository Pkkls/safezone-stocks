// Replay public trades (data/tape.json) through the engine's entry/exit rules.
// CLI: node backtest.mjs [hours]  -> grid over the last N hours (default: all tape)
// Engine: import { tune } for the periodic walk-forward retune.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const FEE = 0.015, R0 = 1e6; // pool cash reserve at start (cents), measured from trade slippage
const STEP = 30e3;           // engine scan cadence

// constant-product impact: price ~ R^2, buying c at price P (reserve R = R0*sqrt(P/1000)) fills near P*(1+c/R)
const fill = (P, c, side) => { const R = R0 * Math.sqrt(P / 1000); return side === 'buy' ? P * (1 + c / R) : P * (1 - c / R); };

// Tape rows are compact: { e: external_id, t: ms, pb/pa: price before/after (cents), u: user_id, s: 'b'|'s', c: cash cents },
// one JSON per line, one file per UTC day in data/. u/s/c identify pump & dump wallets. compact() converts an API trade.
export const compact = (x) => ({ e: x.external_id, t: Date.parse(x.occurred_at), pb: x.price_before_cents, pa: x.price_after_cents, u: x.user_id, s: x.side === 'buy' ? 'b' : 's', c: x.cash_cents });
export function loadTape(sinceMs = 0) {
  if (!fs.existsSync('data')) return [];
  const rows = [];
  for (const f of fs.readdirSync('data').filter((f) => /^tape-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
    if (Date.parse(f.slice(5, 15)) + 86400e3 < sinceMs) continue;
    for (const l of fs.readFileSync('data/' + f, 'utf8').split('\n')) if (l) { const r = JSON.parse(l); if (r.t >= sinceMs) rows.push(r); }
  }
  return rows.sort((a, b) => a.t - b.t);
}

// Kick chat line for a live trade. lines = trades.jsonl lines. API cash_cents: buy = total debited,
// sell = net credited (both checked against balance_after_cents, 18/10), so net pnl = sell - last buy.
// Kick rejects lines with too many symbols (MAX_SPECIAL_CHARS_ERROR on 18/10 for "₡..., net +₡... (+x%)"): plain words only.
export function sayText(side, name, cash, lines) {
  const c = (x) => `${(x / 100).toFixed(2)} Cx`;
  if (side.endsWith('buy')) return `SafeZone stocks bought ${name} for ${c(cash)}`;
  const buy = lines.filter((l) => l.includes('"ev":"stock-market/buy"') && l.includes(`"name":${JSON.stringify(name)}`) && l.includes('"status":200')).at(-1);
  const cost = buy && JSON.parse(buy).res?.cash_cents;
  if (!cost) return `SafeZone stocks sold ${name} for ${c(cash)}`;
  const pnl = cash - cost;
  return `SafeZone stocks sold ${name} for ${c(cash)} net ${pnl >= 0 ? 'profit' : 'loss'} ${c(Math.abs(pnl))} ${(Math.abs(pnl) / cost * 100).toFixed(1)}%`;
}

// Map snapshot health. Binary frames are the site's compact wire format, read the way its own client does (cx-client
// bundle, 18/10). Only kind 2 (health) is read: kind 1 carries positions and is deliberately skipped.
// Kind 2 after the 36-byte header (n = record count, u16 at byte 32): u32 def seq, f64 time base, then columns
// slot u16[n], status u8[n], badges u8[n], flags u16[n] (1 alive, 8 outside), hp u8[n], max_hp u8[n].
// Slots map to usernames through the 'contestants' text frame. The first kind-2 frame is full, later ones are updates,
// so applying them in order leaves the latest value. Returns { lowercased username: { hp, max, alive, out } }.
const HP_STATUS = ['disabled', 'paused', 'inside', 'outside', 'unavailable', 'eliminated'];
export function decodeHealth(frames) {
  const out = {};
  let slots = null;
  for (const f of frames) if (f.text && f.text.includes('"contestants"')) slots = new Map(JSON.parse(f.text).data.slots.slots.map((s) => [s.slot, s.username.toLowerCase()]));
  if (!slots) return out;
  for (const f of frames) {
    if (!f.binary) continue;
    const b = Buffer.from(f.binary, 'base64'), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.length < 48 || v.getUint8(0) !== 2) continue;
    const n = v.getUint16(32, true), w = 48;
    if (b.length < w + n * 8) continue;
    for (let i = 0; i < n; i++) {
      const u = slots.get(v.getUint16(w + i * 2, true)), fl = v.getUint16(w + n * 4 + i * 2, true);
      if (u) out[u] = { hp: v.getUint8(w + n * 6 + i), max: v.getUint8(w + n * 7 + i), alive: (fl & 1) !== 0, out: (fl & 8) !== 0 || HP_STATUS[v.getUint8(w + n * 2 + i)] === 'outside' };
    }
  }
  return out;
}

export function prepare(tape) {
  const paths = {};
  for (const r of tape) {
    const p = (paths[r.e] ||= { ts: [], pa: [], pb0: r.pb, dumps: [] });
    p.ts.push(r.t); p.pa.push(r.pa);
    if (r.s === 's' && (r.pb - r.pa) / r.pb >= DUMP_DROP) p.dumps.push(r.t);
  }
  return { paths, t0: tape[0].t, t1: tape.at(-1).t };
}

// last known price at time t (binary search)
function priceAt(p, t) {
  let lo = 0, hi = p.ts.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (p.ts[m] <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  return k < 0 ? null : p.pa[k];
}

// Market breadth: share of stocks up > 2% over 5 min. Momentum paid only in the market-wide opening rush
// (17/10 tape: +21% mean 3 min after a signal in the first 15 min, +2% after, under the 3% round-trip fee).
// After the rush the same rules lose at minBreadth 0/0.4/0.5 and stand aside at 0.6.
export const BREADTH_WINDOW = 5 * 60e3;
export const DUMP_DROP = 0.05; // one sell knocking the price down >= 5% (see engine.mjs dumped())
// pairs = [price now, price 5 min ago] for stocks traded at least once by now; a stock first traded inside the
// window uses its pre-trade price as "then". Never-traded stocks are left out: counting them as flat kept
// breadth under 40% even during the profitable opening.
export const breadthOf = (pairs) => { const v = pairs.filter(([now, then]) => now && then); return v.length ? v.filter(([now, then]) => now > then * 1.02).length / v.length : 0; };

export function simulate({ paths, t0, t1 }, P) {
  const { lookback, entryMin, entryMax, trail, maxHold, size, minBreadth = 0, dumpExit = false, dumpBreadth = minBreadth } = P;
  let cash = 50000; const pos = {}, exited = {}; let n = 0, wins = 0;
  const ids = Object.keys(paths);
  const breadthAt = (t) => breadthOf(ids.map((id) => [priceAt(paths[id], t), priceAt(paths[id], t - BREADTH_WINDOW) ?? (paths[id].ts[0] <= t ? paths[id].pb0 : null)]));
  for (let t = t0 + lookback; t <= t1; t += STEP) {
    const br = minBreadth || dumpExit ? breadthAt(t) : 1;
    for (const id of Object.keys(pos)) {
      const h = pos[id], p = priceAt(paths[id], t); h.peak = Math.max(h.peak, p);
      const dump = dumpExit && br < dumpBreadth && paths[id].dumps.some((d) => d > Math.max(h.t, t - STEP) && d <= t);
      if (!(p < h.peak * trail || (maxHold && t - h.t > maxHold) || dump)) continue;
      const out = h.sh * fill(p, h.sh * p, 'sell') * (1 - FEE);
      cash += out; n++; if (out > h.cost) wins++; delete pos[id]; exited[id] = t;
    }
    if (Object.keys(pos).length >= 6) continue;
    if (br < minBreadth) continue;
    let best = null;
    for (const id of ids) {
      if (pos[id] || t - (exited[id] || -Infinity) < 30 * 60e3) continue;
      const now = priceAt(paths[id], t), then = priceAt(paths[id], t - lookback);
      if (!now || !then) continue;
      const ret = now / then - 1;
      if (ret >= entryMin && ret <= entryMax && (!best || ret > best.ret)) best = { id, ret, now };
    }
    const amt = Math.floor(cash * size);
    if (best && amt >= 1000) {
      pos[best.id] = { sh: amt * (1 - FEE) / fill(best.now, amt, 'buy'), peak: best.now, cost: amt, t };
      cash -= amt;
    }
  }
  let value = cash;
  for (const id of Object.keys(pos)) value += pos[id].sh * priceAt(paths[id], t1) * (1 - FEE);
  return { pnl: Math.round(value - 50000), n, wins };
}

// Crash rebound + run mode, as the engine trades it: a drop >= crashDrop between two 15 s scans with less than
// crashFlat of rise over the 3 min before, bought 3 s later; sold after dipHold, unless the peak reaches runStart x
// entry, then a runTrail trailing stop from the peak, capped at 2 h. Returns per-trade net returns (fees + own impact)
// split into the two halves of the window, so tuning can demand a result that holds in both.
export function simulateCrash({ paths, t0, t1 }, Q) {
  const { crashDrop, crashFlat, dipHold, runStart, runTrail } = Q;
  const net = (pe, px) => px / pe * (1 - FEE) ** 2 * (1 - 1e4 / (R0 * Math.sqrt(pe / 1000))) * (1 - 1e4 / (R0 * Math.sqrt(px / 1000))) - 1;
  const tm = (t0 + t1) / 2, halves = [[], []];
  for (const p of Object.values(paths)) {
    let free = -Infinity;
    for (let t = t0 + 180e3; t <= t1; t += STEP / 2) {
      if (t < free) continue;
      const now = priceAt(p, t), prev = priceAt(p, t - 15e3), p3 = priceAt(p, t - 180e3);
      if (!now || !prev || !p3 || now / prev - 1 > -crashDrop || prev / p3 - 1 >= crashFlat) continue;
      const pe = priceAt(p, t + 3e3);
      let pk = pe, run = false, px = null, u;
      for (u = t + 3e3; u <= t1; u += 5e3) {
        const x = priceAt(p, u); pk = Math.max(pk, x);
        if (pk >= pe * runStart) run = true;
        if ((!run && u - t >= dipHold) || (run && (x < pk * runTrail || u - t >= 2 * 3600e3))) { px = x; break; }
      }
      if (px === null) break; // still open at the end of the tape: not counted
      halves[t < tm ? 0 : 1].push(net(pe, px));
      free = u + 5 * 60e3; // crash cooldown
    }
  }
  const sum = (v) => v.reduce((a, b) => a + b, 0);
  return { n: halves[0].length + halves[1].length, h1: sum(halves[0]), h2: sum(halves[1]), total: sum(halves[0]) + sum(halves[1]) };
}

export const CRASH_GRID = [];
for (const crashDrop of [0.2, 0.25, 0.3]) for (const crashFlat of [0.05, 0.1, 0.2]) for (const dipHold of [5, 10, 20])
  for (const runStart of [1.1, 1.2]) for (const runTrail of [0.8, 0.85, 0.9])
    CRASH_GRID.push({ crashDrop, crashFlat, dipHold: dipHold * 60e3, runStart, runTrail });

// Adopt a crash/run param set only if: >= minTrades trades, positive in BOTH halves, and beats the current set's
// total by max(0.10, 20%) (sums of per-trade returns, so 0.10 = +10 points over the window).
export function tuneCrash(tape, current, minTrades = 8) {
  const d = prepare(tape);
  const cur = simulateCrash(d, current);
  let best = null;
  for (const Q of CRASH_GRID) { const r = simulateCrash(d, Q); if (r.n >= minTrades && r.h1 > 0 && r.h2 > 0 && (!best || r.total > best.r.total)) best = { Q, r }; }
  const ok = best && best.r.total > cur.total + Math.max(0.10, Math.abs(cur.total) * 0.2);
  return { cur, best, adopt: ok ? best.Q : null };
}

// Survivors after a death, as traded: 20 s after each death, buy the survTop highest-priced stocks traded in the
// last 30 min (never the dead one), hold survHold, run mode as in simulateCrash. deaths = [{ u, t }] from
// data/deaths.jsonl; names maps external_id -> lowercased contestant name (to skip the dead).
export function simulateSurv({ paths, t0, t1 }, Q, deaths, names = {}) {
  const { survTop, survHold, runStart, runTrail } = Q;
  const net = (pe, px) => px / pe * (1 - FEE) ** 2 * (1 - 1e4 / (R0 * Math.sqrt(pe / 1000))) * (1 - 1e4 / (R0 * Math.sqrt(px / 1000))) - 1;
  const tm = (t0 + t1) / 2, halves = [[], []], busyUntil = {};
  for (const d of deaths) {
    const t = d.t + 20e3;
    if (t < t0 + 30 * 60e3 || t > t1) continue;
    const alive = Object.entries(paths).filter(([id, p]) => names[id] !== d.u && p.ts.some((x) => x > t - 30 * 60e3 && x <= t) && !(busyUntil[id] > t))
      .map(([id, p]) => ({ id, p, price: priceAt(p, t) })).filter((x) => x.price).sort((a, b) => b.price - a.price).slice(0, survTop);
    for (const { id, p, price: pe } of alive) {
      let pk = pe, run = false, px = null, u;
      for (u = t; u <= t1; u += 5e3) {
        const x = priceAt(p, u); pk = Math.max(pk, x);
        if (pk >= pe * runStart) run = true;
        if ((!run && u - t >= survHold) || (run && (x < pk * runTrail || u - t >= 2 * 3600e3))) { px = x; break; }
      }
      if (px === null) continue;
      busyUntil[id] = u;
      halves[t < tm ? 0 : 1].push(net(pe, px));
    }
  }
  const sum = (v) => v.reduce((a, b) => a + b, 0);
  return { n: halves[0].length + halves[1].length, h1: sum(halves[0]), h2: sum(halves[1]), total: sum(halves[0]) + sum(halves[1]) };
}

// survTop 0 = strategy off: adopted when no setting is profitable in both halves and the current one loses
export function tuneSurv(tape, current, deaths, names, minTrades = 8) {
  const d = prepare(tape);
  const cur = simulateSurv(d, current, deaths, names);
  let best = null;
  for (const survTop of [1, 2, 3]) for (const survHold of [10, 20, 30, 60]) {
    const Q = { survTop, survHold: survHold * 60e3, runStart: current.runStart, runTrail: current.runTrail };
    const r = simulateSurv(d, Q, deaths, names);
    if (r.n >= minTrades && r.h1 > 0 && r.h2 > 0 && (!best || r.total > best.r.total)) best = { Q: { survTop, survHold: Q.survHold }, r };
  }
  if (best && best.r.total > cur.total + Math.max(0.10, Math.abs(cur.total) * 0.2)) return { cur, best, adopt: best.Q };
  if (!best && current.survTop > 0 && cur.n >= minTrades && cur.total < 0) return { cur, best, adopt: { survTop: 0 } };
  return { cur, best, adopt: null };
}

// Kill-switch tally: closed round trips of a strategy (buy reason prefix) in trades.jsonl lines, counted from its
// last re-arm (a `<prefix>_on` event), so a strategy the tuner switched back on starts a fresh trial.
export function trialTally(lines, prefix) {
  const open = {}; let n = 0, pnl = 0;
  for (const l of lines.slice(lines.findLastIndex((x) => x.includes(`"ev":"${prefix}_on"`)) + 1)) {
    if (!l.includes('"status":200') || !/"ev":"stock-market\/(buy|sell)"/.test(l)) continue;
    const e = JSON.parse(l);
    if (e.ev.endsWith('buy')) { if (String(e.why).startsWith(prefix)) open[e.name] = e.res.cash_cents; else delete open[e.name]; }
    else if (open[e.name] != null) { n++; pnl += e.res.cash_cents - open[e.name]; delete open[e.name]; }
  }
  return { n, pnl };
}

// Engine watchdog: stuck when nothing worked for 5 min outside an API block, or the session is lost for 3 min.
export const stuck = (now, lastOk, blockedUntil, authLostAt) => ({ stale: now - Math.max(lastOk, blockedUntil) > 5 * 60e3, lost: authLostAt > 0 && now - authLostAt > 3 * 60e3 });

export const GRID = [];
for (const lookback of [2, 5]) for (const entryMin of [0.05, 0.15, 0.3]) for (const entryMax of [0.6, 99])
  for (const trail of [0.7, 0.8, 0.9]) for (const maxHold of [0, 10, 30]) for (const minBreadth of [0, 0.4, 0.6])
    GRID.push({ lookback: lookback * 60e3, entryMin, entryMax, trail, maxHold: maxHold * 60e3, size: 0.25, minBreadth, dumpExit: true, dumpBreadth: 0.45 });

// Walk-forward retune over the tape window. Returns the best params, or null if none clearly beats `current`.
export function tune(tape, current, minTrades = 10) {
  const d = prepare(tape);
  const cur = simulate(d, current);
  let best = null;
  for (const P of GRID) { const r = simulate(d, P); if (!best || r.pnl > best.r.pnl) best = { P, r }; }
  // guard rails: enough trades to mean something, and a clear margin over what runs now
  const ok = best.r.n >= minTrades && best.r.pnl > 0 && best.r.pnl > cur.pnl + Math.max(2500, Math.abs(cur.pnl) * 0.2);
  return { cur, best, adopt: ok ? best.P : null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hours = Number(process.argv[2]);
  const tape = loadTape(hours ? Date.now() - hours * 3600e3 : 0);
  const d = prepare(tape);
  const res = GRID.map((P) => ({ ...P, lookback: P.lookback / 60e3, maxHold: P.maxHold / 60e3, ...simulate(d, P) })).sort((a, b) => b.pnl - a.pnl);
  console.log(`tape ${tape.length} trades, ${((d.t1 - d.t0) / 60e3).toFixed(0)} min, ${res.length} combos, profitable ${res.filter((r) => r.pnl > 0).length}`);
  res.slice(0, 8).forEach((r) => console.log(JSON.stringify(r)));
  console.log('WORST', JSON.stringify(res.at(-1)));
}
