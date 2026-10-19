// Live dashboard: http://127.0.0.1:7788 (DASH_PORT). Served by the supervisor in engine.mjs, read-only: it only
// reads local files (live.json written by the engine every 5 s, trades.jsonl, data/*) and never calls the site API.
// GET / page, GET /api/state full state, GET /api/events SSE (state on every change, reload when dashboard.html changes).
import http from 'node:http';
import fs from 'node:fs';

const PORT = +(process.env.DASH_PORT || 7788);
const START_CASH = 60746; // balance before the first order on 17/10 (45560 after a 15186 buy)
const HOUR = 3600e3, DAY = 24 * HOUR;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// Incremental line reader: each call returns the lines appended since the last one (partial last line kept).
const tails = {};
function newLines(file) {
  let st; try { st = fs.statSync(file); } catch { return []; }
  const t = (tails[file] ||= { off: 0, rest: '' });
  if (st.size < t.off) { t.off = 0; t.rest = ''; } // rewritten
  if (st.size === t.off) return [];
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(st.size - t.off);
  fs.readSync(fd, buf, 0, buf.length, t.off); fs.closeSync(fd);
  t.off = st.size;
  const parts = (t.rest + buf.toString('utf8')).split('\n');
  t.rest = parts.pop();
  return parts.filter(Boolean);
}
const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };

// ---- trades.jsonl: orders, events, breadth, tuning
const orders = [], events = [], breadth = [], tunes = {}, kick = { ok: 0, err: 0, last: [] };
const QUIET = new Set(['scan', 'record', 'kick_say', 'dry']);
function readLog() {
  for (const l of newLines('trades.jsonl')) {
    const e = parse(l); if (!e) continue;
    const t = Date.parse(e.t);
    if (e.ev === 'scan') { if (e.stocks) { const m = Math.floor(t / 60e3) * 60e3; if (breadth.at(-1)?.[0] === m) breadth.at(-1)[1] = e.breadth; else breadth.push([m, e.breadth]); } continue; }
    if (/^stock-market\/(buy|sell)$/.test(e.ev)) orders.push({ t, side: e.ev.slice(13), name: e.name, why: String(e.why ?? ''), status: e.status, cash: e.res?.cash_cents ?? null, fee: e.res?.fee_cents ?? null, pb: e.res?.price_before_cents ?? null, pa: e.res?.price_after_cents ?? null, bal: e.res?.balance_after_cents ?? null, msg: e.res?.message ?? e.res?.error ?? null });
    if (e.ev?.startsWith('tune')) tunes[e.ev] = { t, ...e };
    if (e.ev === 'kick_say') {
      // kick_say.py prints {"slug", "status", "body"}: sent = HTTP 200 from Kick; anything else carries Kick's error code
      const out = String(e.out || ''), ok = !e.err && /"status":\s*200\b/.test(out);
      ok ? kick.ok++ : kick.err++;
      const code = out.match(/[A-Z][A-Z_]{5,}_ERROR|[A-Z]{2,}_[A-Z_]{3,}/)?.[0], st = out.match(/"status":\s*(\d{3})/)?.[1];
      kick.last.push({ t, name: e.name, ok, why: ok ? 'sent' : e.err ? 'script error' : `rejected${st ? ' ' + st : ''}${code ? ' ' + code : ''}` });
      if (kick.last.length > 20) kick.last.shift();
    }
    if (!QUIET.has(e.ev)) { events.push({ t, ev: e.ev, d: summarize(e) }); if (events.length > 2000) events.shift(); }
  }
  while (breadth.length && breadth[0][0] < Date.now() - DAY) breadth.shift();
}
function summarize(e) {
  const { t, ev, P, ...rest } = e;
  if (ev === 'start') return `engine started${e.dry ? ' (dry)' : ''}`;
  if (/^stock-market/.test(ev)) return `${e.name} ${e.why} ${e.status}`;
  return JSON.stringify(rest).slice(0, 220);
}

// ---- tape: per-stock minute closes (24 h), 10-min volume, live feed, last-hour trades
const minute = new Map(), vol = new Map(), feed = [], hourTrades = [];
function readTape() {
  const files = fs.existsSync('data') ? fs.readdirSync('data').filter((f) => /^tape-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort() : [];
  const since = Date.now() - DAY;
  for (const f of files) {
    if (Date.parse(f.slice(5, 15)) + DAY < since) { tails['data/' + f] ||= { off: fs.statSync('data/' + f).size, rest: '' }; continue; }
    for (const l of newLines('data/' + f)) {
      const r = parse(l); if (!r || r.t < since) continue;
      const m = Math.floor(r.t / 60e3) * 60e3;
      let s = minute.get(r.e); if (!s) minute.set(r.e, (s = new Map()));
      s.set(m, r.pa);
      const b = Math.floor(r.t / 600e3) * 600e3, v = vol.get(b) || { n: 0, cx: 0, users: new Set(), buys: 0 };
      v.n++; v.cx += r.c || 0; v.users.add(r.u); if (r.s === 'b') v.buys++; vol.set(b, v);
      feed.push(r);
      hourTrades.push(r);
    }
  }
  // the recorder writes per stock in batches every minute: order by trade time, not by file order
  feed.sort((a, b) => a.t - b.t); feed.splice(0, Math.max(0, feed.length - 80));
  const cut = Date.now() - HOUR;
  while (hourTrades.length && hourTrades[0].t < cut) hourTrades.shift();
  for (const k of vol.keys()) if (k < since) vol.delete(k);
  for (const s of minute.values()) for (const k of s.keys()) { if (k < since) s.delete(k); else break; }
}
// last known price of a stock at or before t, from the minute closes
function priceAt(id, t) {
  const s = minute.get(id); if (!s) return null;
  let best = null, bt = -1;
  for (const [m, p] of s) if (m <= t && m > bt) { bt = m; best = p; }
  return best;
}

// ---- small files
const dedupeDeaths = () => {
  const m = new Map();
  for (const l of (fs.existsSync('data/deaths.jsonl') ? fs.readFileSync('data/deaths.jsonl', 'utf8').split('\n') : [])) { const d = parse(l); if (d) m.set(d.u + d.t, d); }
  return [...m.values()].sort((a, b) => a.t - b.t);
};
const lines = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').map(parse).filter(Boolean) : [];

// strategy of an order = first word of its buy reason, folded: mom5m/mom2m -> mom
const strat = (why) => { const w = String(why).split(' ')[0]; return w.startsWith('mom') ? 'mom' : w; };
function roundTrips() {
  const open = {}, trips = [];
  for (const o of orders) {
    if (o.status !== 200) continue;
    if (o.side === 'buy') open[o.name] = o;
    else if (open[o.name]) { const b = open[o.name]; trips.push({ name: o.name, strat: strat(b.why), t0: b.t, t1: o.t, cost: b.cash, out: o.cash, pnl: o.cash - b.cash, pct: o.cash / b.cash - 1, exit: o.why.split(' ')[0] }); delete open[o.name]; }
    else trips.push({ name: o.name, strat: 'manuel', t0: null, t1: o.t, cost: null, out: o.cash, pnl: null, pct: null, exit: o.why.split(' ')[0] });
  }
  return trips;
}

function build() {
  readLog(); readTape();
  const now = Date.now(), live = readJson('live.json') || {}, me = live.me || null, st = live.state || {}, P = live.P || {};
  const market = live.market?.stocks || [], names = Object.fromEntries(market.map((s) => [s.id, s.name]));
  const deaths = dedupeDeaths(), revives = lines('data/revives.jsonl'), equity = lines('data/equity.jsonl'), settled = lines('data/settled.jsonl');
  const trips = roundTrips().filter((x) => x.pnl !== null);

  // positions
  const holdings = me?.holdings || [];
  const positions = holdings.map((h) => {
    const id = h.external_id, kind = st.kind?.[id] || (st.entryAt?.[id] ? 'mom' : 'manuel'), entry = live.entry?.[id] ?? null;
    const p = h.last_price_cents, hp = live.health?.[String(h.name).toLowerCase()] || null;
    // /me gives cost basis and current value per holding (cents); pnl is theirs, before the sell fee
    const cost = h.cost_basis_cents, value = h.current_value_cents;
    return { id, name: h.name, kind, entry, p, cost, value, pnl: value - cost, pct: cost ? value / cost - 1 : null, peak: st.peak?.[id] ?? null, since: st.entryAt?.[id] ?? null, hp };
  });
  const invested = me?.portfolio_value_cents ?? positions.reduce((a, x) => a + (x.value || 0), 0);
  // /me has no cash field: cash is the balance after the latest order (exact, orders are the only cash moves)
  const cash = [...orders].reverse().find((o) => o.bal != null)?.bal ?? null;
  const value = cash != null ? cash + invested : null;

  // strategies
  const byStrat = {};
  for (const x of trips) { const s = (byStrat[x.strat] ||= { n: 0, wins: 0, pnl: 0, best: -Infinity, worst: Infinity }); s.n++; if (x.pnl > 0) s.wins++; s.pnl += x.pnl; s.best = Math.max(s.best, x.pnl); s.worst = Math.min(s.worst, x.pnl); }
  const trial = {};
  for (const k of ['crash', 'surv', 'top']) {
    const offAt = events.findLast((e) => e.ev === `${k}_off`)?.t ?? 0, onAt = events.findLast((e) => e.ev === `${k}_on`)?.t ?? 0;
    const since = trips.filter((x) => x.strat === k && x.t1 > onAt);
    trial[k] = { off: !!live.trialOff?.[k] || offAt > onAt, n: since.length, pnl: since.reduce((a, x) => a + x.pnl, 0) };
  }
  trial.surv.disabled = P.survTop === 0; trial.top.disabled = P.topN === 0;

  // market views
  const ch = (s, ms) => { const p0 = priceAt(s.id, now - ms); return p0 ? s.p / p0 - 1 : null; };
  const stocks = market.map((s) => ({ ...s, dead: s.el || (live.diedAt?.[String(s.name).toLowerCase()] || 0) > (live.revivedAt?.[String(s.name).toLowerCase()] || 0), ch15: ch(s, 15 * 60e3), ch60: ch(s, HOUR), drop: s.prev ? s.p / s.prev - 1 : null, ch5: s.p5 ? s.p / s.p5 - 1 : null }));
  const held = new Set(holdings.map((h) => h.external_id));
  const ranked = stocks.filter((s) => s.st === 'active' && !s.dead && s.lt && now - s.lt < 30 * 60e3).sort((a, b) => b.p - a.p)
    .map((s, i) => ({ rank: i + 1, id: s.id, name: s.name, p: s.p, ch60: s.ch60, held: held.has(s.id), kind: st.kind?.[s.id] || null, spark: spark(s.id, now) }));
  const movers = stocks.filter((s) => !s.dead && s.ch15 != null);
  const volume = [...vol.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, n: v.n, cx: v.cx, users: v.users.size, buys: v.buys }));
  const lastMin = hourTrades.filter((r) => r.t > now - 5 * 60e3);

  // game
  const perHour = {};
  for (const d of deaths) { const h = Math.floor(d.t / HOUR) * HOUR; perHour[h] = (perHour[h] || 0) + 1; }
  const causes = {};
  for (const d of deaths) causes[d.source || d.cause || '?'] = (causes[d.source || d.cause || '?'] || 0) + 1;
  const health = Object.entries(live.health || {}).map(([u, h]) => ({ u, ...h })), roster = live.roster || {};
  // every alive contestant, weakest first (18/10: a list cut to the weakest hid a healthy one, FloridaBoy 110/110)
  const aliveAll = health.filter((h) => h.alive).sort((a, b) => a.hp / a.max - b.hp / b.max || a.u.localeCompare(b.u)).map((h) => ({ ...h, sigil: roster[h.u]?.sigil ?? null, live: !!roster[h.u]?.live, revived: !!live.revivedAt?.[h.u] }));

  // engine
  const age = (t) => (t ? now - t : null);
  const lastStart = events.findLast((e) => e.ev === 'start')?.t ?? null;
  const api = live.api || {};
  const status = !live.t || now - live.t > 60e3 ? 'down' : api.authLostAt ? 'auth' : api.blockedUntil > now ? 'blocked' : 'ok';
  const files = Object.fromEntries(['trades.jsonl', 'live.json', 'state.json', 'params.json'].concat(fs.existsSync('data') ? fs.readdirSync('data').map((f) => 'data/' + f) : []).map((f) => { try { return [f, fs.statSync(f).size]; } catch { return [f, 0]; } }));

  return {
    now, // deposits (cash_in, e.g. "double Cx Bucks") are not gains; the owner's own trades (manual_trade) are not deposits
    startCash: START_CASH + (st.deposits || 0) - Object.values(st.manual || {}).reduce((a, c) => a + c, 0),
    engine: { status, pid: live.pid, startedAt: live.startedAt, liveAge: age(live.t), lastStart, scanAge: age(live.market?.t), okAge: age(api.lastOk), blockedUntil: api.blockedUntil, backoff: api.backoff, authLostAt: api.authLostAt, hpFeed: live.hpFeed, end: live.end, dry: live.dry, lastReb: live.lastReb,
      restarts: events.filter((e) => /^(start|restart|watchdog)$/.test(e.ev) && e.t > now - DAY).map((e) => ({ t: e.t, ev: e.ev, d: e.d })),
      errors: events.filter((e) => /err|blocked|auth_lost|watchdog/.test(e.ev) && e.t > now - HOUR).length, kick, files },
    kpi: { value, cash, invested, realized: me?.realized_pnl_cents ?? null, unrealized: me?.unrealized_pnl_cents ?? null, trading: me?.trading_enabled ?? null, positions: positions.length, ordersToday: orders.filter((o) => o.t > now - DAY).length, tripsPnl: trips.reduce((a, x) => a + x.pnl, 0) },
    // points without cash (written before 18/10 05:40 by an engine that did not know it) are positions only: skipped
    equity: downsample(equity.filter((e) => e.cash != null && e.value != null).map((e) => [e.t, e.value]), 600), cashCurve: orders.filter((o) => o.bal != null).map((o) => [o.t, o.bal]),
    positions, byStrat, trial, P, tunes, orders: orders.slice(-120).reverse(), trips: trips.slice(-200).reverse(),
    market: { breadth: downsample(breadth, 720), lastBreadth: live.market?.breadth ?? null, ranked: ranked.slice(0, 30),
      crash: stocks.filter((s) => s.drop != null && !s.dead).sort((a, b) => a.drop - b.drop).slice(0, 10).map(pick),
      up: [...movers].sort((a, b) => b.ch15 - a.ch15).slice(0, 8).map(pick), down: [...movers].sort((a, b) => a.ch15 - b.ch15).slice(0, 8).map(pick),
      heat: stocks.filter((s) => !s.dead && s.st === 'active').sort((a, b) => b.p - a.p).map(pick),
      volume, tpm: lastMin.length / 5, wallets: new Set(hourTrades.map((r) => r.u)).size, cxHour: hourTrades.reduce((a, r) => a + (r.c || 0), 0),
      feed: feed.filter((r) => r.u !== me?.trades?.[0]?.user_id).slice(-20).reverse().map((r) => ({ t: r.t, name: names[r.e] || r.e.slice(-6), side: r.s, c: r.c, imp: r.pb ? r.pa / r.pb - 1 : 0 })),
      whales: [...hourTrades].sort((a, b) => (b.c || 0) - (a.c || 0)).slice(0, 10).map((r) => ({ t: r.t, name: names[r.e] || r.e.slice(-6), side: r.s, c: r.c, imp: r.pb ? r.pa / r.pb - 1 : 0 })),
      counts: { listed: market.length, active: stocks.filter((s) => s.st === 'active' && !s.dead).length, dead: stocks.filter((s) => s.dead).length, settled: settled.length } },
    game: { deaths: deaths.length, lastDeaths: [...deaths, ...revives].sort((a, b) => a.t - b.t).slice(-25).reverse(), revives: revives.length, perHour: Object.entries(perHour).map(([t, n]) => [+t, n]).sort((a, b) => a[0] - b[0]).slice(-36), causes,
      alive: health.filter((h) => h.alive).length, tracked: health.length, aliveAll, outside: health.filter((h) => h.alive && h.out).sort((a, b) => a.hp - b.hp),
      lowHp: health.filter((h) => h.alive && h.max).sort((a, b) => a.hp / a.max - b.hp / b.max).slice(0, 15), settled: settled.slice(-20).reverse() },
    events: events.slice(-300).reverse(),
  };
}
const pick = (s) => ({ id: s.id, name: s.name, p: s.p, ch15: s.ch15, ch60: s.ch60, ch5: s.ch5, drop: s.drop });
function spark(id, now) {
  const s = minute.get(id); if (!s) return [];
  return [...s.entries()].filter(([m]) => m > now - HOUR).sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}
function downsample(pts, max) {
  if (pts.length <= max) return pts;
  const step = pts.length / max, out = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
  out.push(pts.at(-1));
  return out;
}

// ---- server
let state = null, stamp = '';
const clients = new Set();
const fingerprint = () => ['live.json', 'trades.jsonl', 'data/deaths.jsonl', 'dashboard.html'].map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(':');
function tick() {
  const fp = fingerprint();
  if (fp === stamp) return;
  const htmlChanged = stamp && fp.split(':')[3] !== stamp.split(':')[3];
  stamp = fp;
  try { state = build(); } catch (e) { state = { error: e.message, now: Date.now() }; }
  const msg = `event: state\ndata: ${JSON.stringify(state)}\n\n` + (htmlChanged ? 'event: reload\ndata: 1\n\n' : '');
  for (const c of clients) c.write(msg);
}

export function serve() {
  const safeTick = () => { try { tick(); } catch {} };
  safeTick();
  setInterval(safeTick, 2e3);
  setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20e3);
  // the supervisor hosts this server: nothing in a request may throw out of it
  const server = http.createServer((req, res) => { try { route(req, res); } catch (e) { res.writeHead(500); res.end(e.message); } });
  // a port still held by the previous supervisor (restart race): retry instead of dying
  server.on('error', (e) => { if (e.code === 'EADDRINUSE') setTimeout(() => server.listen(PORT, '127.0.0.1'), 5e3); });
  server.listen(PORT, '127.0.0.1');
  return server;
}
function route(req, res) {
    const url = req.url.split('?')[0];
    if (url === '/api/state') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(state)); }
    if (url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
      clients.add(res); req.on('close', () => clients.delete(res));
      return;
    }
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync('dashboard.html'));
    }
    res.writeHead(404); res.end();
}

if (process.argv[1]?.endsWith('dashboard.mjs')) serve(); // node dashboard.mjs: standalone, for working on the page
