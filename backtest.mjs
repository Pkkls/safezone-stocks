// Pure helpers for engine.mjs (tape, replays and self-tuning, health decoder, chat and stream text). Tested by check.mjs.
import fs from 'node:fs';

const FEE = 0.015, R0 = 1e6; // fee per side; pool cash reserve at 10.00 (cents): reserve R = R0 * sqrt(price / 1000)
export const BREADTH_WINDOW = 5 * 60e3, DUMP_DROP = 0.05;

// Tape: one compact JSON row per public trade { e: stock, t, pb/pa: price before/after, u: user, s: b|s, c: cash },
// one file per UTC day in data/.
export const compact = (x) => ({ e: x.external_id, t: Date.parse(x.occurred_at), pb: x.price_before_cents, pa: x.price_after_cents, u: x.user_id, s: x.side === 'buy' ? 'b' : 's', c: x.cash_cents });
export function loadTape(since = 0) {
  const rows = [];
  for (const f of fs.existsSync('data') ? fs.readdirSync('data').filter((f) => /^tape-\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort() : []) {
    if (Date.parse(f.slice(5, 15)) + 86400e3 < since) continue;
    for (const l of fs.readFileSync('data/' + f, 'utf8').split('\n')) if (l) { const r = JSON.parse(l); if (r.t >= since) rows.push(r); }
  }
  return rows.sort((a, b) => a.t - b.t);
}

// Kick chat line. API cash_cents: buy = total debited, sell = net credited, so net = sell - last buy. Kick rejects
// lines with many symbols (MAX_SPECIAL_CHARS_ERROR): plain words only.
export function sayText(side, name, cash, lines) {
  const c = (x) => `${(x / 100).toFixed(2)} Cx`;
  if (side.endsWith('buy')) return `SafeZone stocks bought ${name} for ${c(cash)}`;
  const buy = lines.filter((l) => l.includes('"ev":"stock-market/buy"') && l.includes(`"name":${JSON.stringify(name)}`) && l.includes('"status":200')).at(-1);
  const cost = buy && JSON.parse(buy).res?.cash_cents;
  if (!cost) return `SafeZone stocks sold ${name} for ${c(cash)}`;
  const pnl = cash - cost;
  return `SafeZone stocks sold ${name} for ${c(cash)} net ${pnl >= 0 ? 'profit' : 'loss'} ${c(Math.abs(pnl))} ${(Math.abs(pnl) / cost * 100).toFixed(1)}%`;
}

// Map health, read as the site's own client does. Only binary kind 2: after the 36-byte header (record count n = u16
// at 32), u32 + f64, then columns slot u16[n], status u8[n], badges u8[n], flags u16[n] (1 alive, 8 outside), hp u8[n],
// max u8[n]. Kind 1 (live positions) is never read. Later kind-2 frames are updates, applied in order.
export function decodeHealth(frames) {
  const out = {};
  let slots = null;
  for (const f of frames) if (f.text?.includes('"contestants"')) slots = new Map(JSON.parse(f.text).data.slots.slots.map((s) => [s.slot, s.username.toLowerCase()]));
  if (!slots) return out;
  for (const f of frames) {
    if (!f.binary) continue;
    const b = Buffer.from(f.binary, 'base64'), v = new DataView(b.buffer, b.byteOffset, b.byteLength), n = b.length >= 48 ? v.getUint16(32, true) : 0;
    if (b[0] !== 2 || b.length < 48 + n * 8) continue;
    for (let i = 0; i < n; i++) {
      const u = slots.get(v.getUint16(48 + i * 2, true)), fl = v.getUint16(48 + n * 4 + i * 2, true);
      if (u) out[u] = { hp: b[48 + n * 6 + i], max: b[48 + n * 7 + i], alive: (fl & 1) !== 0, out: (fl & 8) !== 0 || b[48 + n * 2 + i] === 3 };
    }
  }
  return out;
}

// Stream pages: the engine pushes one every 10 s and moves to the next every PAGE_MS (all 96 columns x 22 lines, 1280x720
// at 20 px DejaVu Mono, drawn by ffmpeg on the streaming box). d = { me, names, health, breadth, startedAt, now,
// kindOf(id) -> strategy ('' = opened by hand), deaths [{ u, t, source }] newest last, movers [{ name, ret }],
// ranking [{ name, price }] highest first, strategies { prefix: { n, win, pnl } } }.
export function streamPages(d) {
  const { me, names = {}, health = {}, breadth = 0, startedAt = 0, now = Date.now(), kindOf = () => '', deaths = [], movers = [], ranking = [], strategies = {} } = d;
  const c = (x) => (x / 100).toFixed(2), s = (x) => (x >= 0 ? '+' : '') + c(x), pad = (x, n) => String(x).slice(0, n).padEnd(n);
  const hm = (t) => new Date(t).toISOString().slice(11, 16), pct = (r) => `${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%`;
  const up = Math.floor((now - startedAt) / 60e3), alive = Object.values(health).filter((h) => h.alive).length;
  const two = (a, b) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => ((a[i] || '').padEnd(50) + (b[i] || '')).trimEnd());
  const page = (i, title, body) => [`${i}/4  ${title}`.padEnd(75) + `data ${new Date(now).toISOString().slice(11, 19)} UTC`,
    `Realized ${s(me.realized_pnl_cents)} Cx   Open ${s(me.unrealized_pnl_cents)} Cx   Positions ${me.holdings.length}   Alive ${alive}   Bot up ${Math.floor(up / 60)}h${String(up % 60).padStart(2, '0')}`,
    '', ...body.slice(0, 19)].join('\n') + '\n';

  const pos = ['POSITION          TYPE       COST     VALUE       P/L      %'];
  for (const h of [...me.holdings].sort((a, b) => b.current_value_cents - a.current_value_cents).slice(0, 18)) {
    const pl = h.current_value_cents - h.cost_basis_cents;
    pos.push(`${pad(h.name, 17)} ${pad(kindOf(h.external_id) || 'yours', 6)} ${c(h.cost_basis_cents).padStart(9)} ${c(h.current_value_cents).padStart(9)} ${s(pl).padStart(9)} ${pct(h.cost_basis_cents ? pl / h.cost_basis_cents : 0).padStart(7)}`);
  }
  const orders = ['LAST ORDERS (UTC)'];
  for (const t of (me.trades || []).slice(0, 14)) orders.push(`${hm(t.occurred_at)}  ${pad(t.side, 4)}  ${pad(names[t.external_id] || '?', 16)} ${c(t.cash_cents).padStart(8)} Cx`);
  const strat = ['STRATEGY   TRIPS   WON        PNL'];
  for (const [k, r] of Object.entries(strategies)) strat.push(`${pad(k, 10)} ${String(r.n).padStart(5)} ${String(r.win).padStart(5)} ${s(r.pnl).padStart(10)}`);
  const mv = [...movers].sort((a, b) => b.ret - a.ret), rows = (v) => v.map((m) => `${pad(m.name, 20)} ${pct(m.ret).padStart(8)}`);
  const market = [`RISING 5 MIN (${Math.round(breadth * 100)} pct of the market)`, ...rows(mv.filter((m) => m.ret > 0).slice(0, 8)), '', 'FALLING 5 MIN', ...rows([...mv].reverse().filter((m) => m.ret < 0).slice(0, 8))];
  const rank = ['MOST EXPENSIVE        PRICE', ...ranking.slice(0, 18).map((r, i) => `${String(i + 1).padStart(2)}. ${pad(r.name, 17)} ${c(r.price).padStart(7)}`)];
  const danger = ['IN DANGER (hp < 35% or out)      HP'];
  for (const [u, h] of Object.entries(health).filter(([, h]) => h.alive && (h.out || h.hp < h.max * 0.35)).sort((a, b) => a[1].hp / a[1].max - b[1].hp / b[1].max).slice(0, 18))
    danger.push(`${pad(u, 26)} ${`${h.hp}/${h.max}`.padStart(7)}${h.out ? '  out' : ''}`);
  if (danger.length === 1) danger.push('nobody');
  const dead = ['LAST DEATHS (UTC)'];
  for (const x of deaths.slice(-18).reverse()) dead.push(`${hm(x.t)}  ${pad(x.u, 22)} ${pad(x.source || x.cause || '', 14)}`);
  return [page(1, 'PORTFOLIO', pos), page(2, 'ACTIVITY', two(orders, strat)), page(3, 'MARKET', two(market, rank)), page(4, 'CONTESTANTS', two(danger, dead))];
}

// Scrolling ticker line for the stream (same d as streamPages): PnL, top movers, last orders, alive count. ASCII only.
export function streamTicker(d) {
  const { me, names = {}, health = {}, movers = [] } = d;
  const c = (x) => (x / 100).toFixed(2), pct = (r) => `${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%`, mv = [...movers].sort((a, b) => b.ret - a.ret);
  const part = (label, v) => (v.length ? `${label}  ${v.join('   ')}` : '');
  return ['CX STOCK BOT', `REALIZED ${me.realized_pnl_cents >= 0 ? '+' : ''}${c(me.realized_pnl_cents)} Cx`,
    part('RISING', mv.filter((m) => m.ret > 0).slice(0, 5).map((m) => `${m.name} ${pct(m.ret)}`)),
    part('FALLING', [...mv].reverse().filter((m) => m.ret < 0).slice(0, 5).map((m) => `${m.name} ${pct(m.ret)}`)),
    part('LAST ORDERS', (me.trades || []).slice(0, 4).map((t) => `${t.occurred_at.slice(11, 16)} ${t.side} ${names[t.external_id] || '?'} ${c(t.cash_cents)} Cx`)),
    `ALIVE ${Object.values(health).filter((h) => h.alive).length}`, 'play money, automated'].filter(Boolean).join('     |     ').replace(/[^\x20-\x7e]/g, '');
}

// Round trips per strategy (buy reason prefix) over trades.jsonl lines: matched buy -> next sell of the same name.
export function roundTrips(lines, prefixes) {
  const open = {}, out = Object.fromEntries(prefixes.map((p) => [p, { n: 0, win: 0, pnl: 0 }]));
  for (const l of lines) {
    if (!l.includes('"status":200') || !/"ev":"stock-market\/(buy|sell)"/.test(l)) continue;
    const e = JSON.parse(l), k = String(e.why).split(' ')[0];
    if (e.ev.endsWith('buy')) { if (out[k]) open[e.name] = { k, c: e.res.cash_cents }; else delete open[e.name]; }
    else if (open[e.name]) { const o = open[e.name], r = out[o.k]; r.n++; r.pnl += e.res.cash_cents - o.c; if (e.res.cash_cents > o.c) r.win++; delete open[e.name]; }
  }
  return out;
}

// share of traded stocks up > 2% over BREADTH_WINDOW; pairs = [now, then]
export const breadthOf = (pairs) => { const v = pairs.filter(([a, b]) => a && b); return v.length ? v.filter(([a, b]) => a > b * 1.02).length / v.length : 0; };

// Price paths per stock. deathAt: the server's -15..-25% knock between two trades, over 20 s apart (a death).
export function prepare(tape) {
  const paths = {};
  for (const r of tape) {
    const p = (paths[r.e] ||= { ts: [], pa: [] }), gap = p.pa.length ? r.pb / p.pa.at(-1) - 1 : 0;
    if (gap < -0.15 && gap > -0.25 && r.t - p.ts.at(-1) > 20e3) p.deathAt ??= r.t;
    p.ts.push(r.t); p.pa.push(r.pa);
  }
  return { paths, t0: tape[0].t, t1: tape.at(-1).t };
}
function priceAt(p, t) {
  let lo = 0, hi = p.ts.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (p.ts[m] <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  return k < 0 ? null : p.pa[k];
}
// net return of a round trip of 100 Cx: fees both sides plus own price impact both sides
const net = (pe, px) => px / pe * (1 - FEE) ** 2 * (1 - 1e4 / (R0 * Math.sqrt(pe / 1000))) * (1 - 1e4 / (R0 * Math.sqrt(px / 1000))) - 1;
// hold from u0 (age counted from t): sold after `hold`, unless the peak reaches runStart x entry (run mode): then a
// runTrail trail from the peak, 2 h cap. null = still open at the end of the tape.
function ride(p, pe, u0, t, t1, hold, { runStart, runTrail }) {
  let pk = pe, run = false;
  for (let u = u0; u <= t1; u += 5e3) {
    const x = priceAt(p, u); pk = Math.max(pk, x);
    if (pk >= pe * runStart) run = true;
    if ((!run && u - t >= hold) || (run && (x < pk * runTrail || u - t >= 2 * 3600e3))) return { px: x, u };
  }
  return null;
}
const halves = (t0, t1) => { const h = [[], []], tm = (t0 + t1) / 2; return { add: (t, r) => h[t < tm ? 0 : 1].push(r), get: () => { const s = (v) => v.reduce((a, b) => a + b, 0); return { n: h[0].length + h[1].length, h1: s(h[0]), h2: s(h[1]), total: s(h[0]) + s(h[1]) }; } }; };

// Crash rebound as traded: a drop >= crashDrop between two 15 s scans with < crashFlat rise over the 3 min before,
// bought 3 s later, sold by ride(dipHold); 5 min cooldown. Returns summed per-trade returns per half of the window.
export function simulateCrash({ paths, t0, t1 }, Q) {
  const H = halves(t0, t1);
  for (const p of Object.values(paths)) {
    for (let t = t0 + 180e3, free = -Infinity; t <= t1; t += 15e3) {
      if (t < free) continue;
      const now = priceAt(p, t), prev = priceAt(p, t - 15e3), p3 = priceAt(p, t - 180e3);
      if (!now || !prev || !p3 || now / prev - 1 > -Q.crashDrop || prev / p3 - 1 >= Q.crashFlat) continue;
      const pe = priceAt(p, t + 3e3), x = ride(p, pe, t + 3e3, t, t1, Q.dipHold, Q);
      if (!x) break;
      H.add(t, net(pe, x.px)); free = x.u + 5 * 60e3;
    }
  }
  return H.get();
}
// Survivors as traded: 20 s after each death, the survTop highest-priced stocks traded in the last 30 min (never the
// dead one: names = id -> lowercased name), sold by ride(survHold).
export function simulateSurv({ paths, t0, t1 }, Q, deaths, names = {}) {
  const H = halves(t0, t1), busy = {};
  for (const d of deaths) {
    const t = d.t + 20e3;
    if (t < t0 + 30 * 60e3 || t > t1) continue;
    const pick = Object.entries(paths).filter(([id, p]) => names[id] !== d.u && p.ts.some((x) => x > t - 30 * 60e3 && x <= t) && !(busy[id] > t))
      .map(([id, p]) => ({ id, p, pe: priceAt(p, t) })).filter((x) => x.pe).sort((a, b) => b.pe - a.pe).slice(0, Q.survTop);
    for (const { id, p, pe } of pick) { const x = ride(p, pe, t, t, t1, Q.survHold, Q); if (x) { busy[id] = x.u; H.add(t, net(pe, x.px)); } }
  }
  return H.get();
}
// Top basket as traded: every topReb hold the topN highest-priced live stocks (min(topSize x cash, 1.5% of the
// reserve) each), sell at rank topExit or at the death knock. From 866 Cx; Cx PnL of the window and of each half.
export function simulateTop({ paths, t0, t1 }, Q) {
  const { topN, topExit, topReb, topSize = 0.15 } = Q, imp = (p, c) => c / (R0 * Math.sqrt(p / 1000));
  const run = (from, to) => {
    let cash = 86580, n = 0; const pos = {};
    const sell = (id, px) => { const v = pos[id] * px; cash += v * (1 - FEE) * (1 - imp(px, v)); delete pos[id]; };
    for (let t = from; t <= to && topN > 0; t += 60e3) {
      for (const id of Object.keys(pos)) if (paths[id].deathAt <= t) sell(id, priceAt(paths[id], t));
      if ((t - from) % topReb) continue;
      const ranked = Object.entries(paths).filter(([, p]) => !(p.deathAt <= t) && (p.ts.findLast((x) => x <= t) ?? 0) > t - 30 * 60e3)
        .map(([id, p]) => ({ id, now: priceAt(p, t) })).sort((a, b) => b.now - a.now);
      const rank = new Map(ranked.map((x, i) => [x.id, i]));
      for (const id of Object.keys(pos)) if (!(rank.get(id) < topExit)) sell(id, priceAt(paths[id], t));
      for (const x of ranked.slice(0, topN)) {
        if (pos[x.id]) continue;
        const c = Math.min(cash * topSize, R0 * Math.sqrt(x.now / 1000) * 0.015);
        if (c < 1000) break;
        cash -= c; n++; pos[x.id] = c * (1 - FEE) * (1 - imp(x.now, c)) / x.now;
      }
    }
    for (const [id, sh] of Object.entries(pos)) { const px = priceAt(paths[id], to); cash += sh * px * (1 - FEE) * (1 - imp(px, sh * px)); }
    return { pnl: (cash - 86580) / 100, n };
  };
  const from = t0 + 3600e3, mid = (from + t1) / 2; // the first hour builds the "traded in 30 min" history
  if (from >= t1) return { n: 0, h1: 0, h2: 0, total: 0 };
  const all = run(from, t1);
  return { n: all.n, h1: run(from, mid).pnl, h2: run(mid, t1).pnl, total: all.pnl };
}

// Self-tuning: the best grid setting with >= minTrades and a profit in both halves is adopted if it beats the
// current one by max(floor, 20%); with none and a losing current one, `off` (strategy off) is adopted.
function pick(grid, sim, cur, minTrades, floor, off) {
  let best = null;
  for (const Q of grid) { const r = sim(Q); if (r.n >= minTrades && r.h1 > 0 && r.h2 > 0 && (!best || r.total > best.r.total)) best = { Q, r }; }
  if (best && best.r.total > cur.total + Math.max(floor, Math.abs(cur.total) * 0.2)) return { cur, best, adopt: best.Q };
  return { cur, best, adopt: !best && off && cur.n >= minTrades && cur.total < 0 ? off : null };
}
const grid = (axes) => Object.entries(axes).reduce((acc, [k, vs]) => acc.flatMap((o) => vs.map((v) => ({ ...o, [k]: v }))), [{}]);
const CRASH_GRID = grid({ crashDrop: [0.2, 0.25, 0.3], crashFlat: [0.05, 0.1, 0.2], dipHold: [5, 10, 20].map((m) => m * 60e3), runStart: [1.1, 1.2], runTrail: [0.8, 0.85, 0.9] });
export function tuneCrash(tape, cur, minTrades = 8) {
  const d = prepare(tape);
  return pick(CRASH_GRID, (Q) => simulateCrash(d, Q), simulateCrash(d, cur), minTrades, 0.10, null);
}
export function tuneSurv(tape, cur, deaths, names, minTrades = 8) {
  const d = prepare(tape), sim = (Q) => simulateSurv(d, { ...cur, ...Q }, deaths, names);
  return pick(grid({ survTop: [1, 2, 3], survHold: [10, 20, 30, 60].map((m) => m * 60e3) }), sim, sim({}), minTrades, 0.10, cur.survTop > 0 && { survTop: 0 });
}
export function tuneTop(tape, cur, minTrades = 8) {
  const d = prepare(tape), sim = (Q) => simulateTop(d, { ...cur, ...Q });
  const g = grid({ topN: [3, 5, 10], topReb: [15, 60].map((m) => m * 60e3) }).map((q) => ({ topN: q.topN, topExit: 2 * q.topN, topReb: q.topReb }));
  return pick(g, sim, sim({}), minTrades, 10, cur.topN > 0 && { topN: 0 });
}

// Kill-switch tally: closed round trips of a strategy (buy reason prefix) since its last `<prefix>_on` re-arm.
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
// Watchdog: stuck when nothing worked for 5 min outside an API block, or the session is lost for 3 min.
export const stuck = (now, lastOk, blockedUntil, authLostAt) => ({ stale: now - Math.max(lastOk, blockedUntil) > 5 * 60e3, lost: authLostAt > 0 && now - authLostAt > 3 * 60e3 });
