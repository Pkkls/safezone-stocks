// SafeZone stock market engine. Config in .env (see .env.example). First run: node engine.mjs --login (log in, close
// the window) or import cookies with import-cookies.mjs; then node engine.mjs. Strategies, exits and numbers: README.
import { chromium } from 'playwright';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile, fork, spawn } from 'node:child_process';
import { tuneCrash, tuneSurv, tuneTop, loadTape, compact, breadthOf, BREADTH_WINDOW, DUMP_DROP, sayText, decodeHealth, trialTally, stuck, deadAfter, calmPrice, streamPages, streamTicker, layers, roundTrips } from './backtest.mjs';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const HOST = process.env.SITE_HOST;
if (!HOST) { console.error('SITE_HOST missing in .env (see .env.example)'); process.exit(1); }
const SITE = `https://${HOST}`, API = `https://api.${HOST}/public/`, MAP = `https://event-public.${HOST}/event/map-snapshot`;
const LOGIN = process.argv.includes('--login'), DRY = process.argv.includes('--dry');
const END = Date.parse(process.env.END_AT || '2026-10-24T20:20:00Z');
if (Date.now() > END && !LOGIN) process.exit(0);
const LOG = 'trades.jsonl', STATE = 'state.json', PARAMS = 'params.json';
// Supervisor: the scheduled task runs this file, which re-runs it as a child and restarts it when it dies (10 s after a
// long run, backing off to 10 min on a crash loop). The child exits with its IPC channel, so no orphan keeps trading.
if (!LOGIN && !process.env.SZ_CHILD) {
  // local dashboard (dashboard.mjs, http://127.0.0.1:7788): hosted here, it outlives engine restarts and cannot stop trading
  import('./dashboard.mjs').then((m) => m.serve()).catch((e) => fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ev: 'dashboard_err', msg: e.message }) + '\n'));
  for (let wait = 5e3; ;) {
    const t0 = Date.now(), code = await new Promise((ok) => fork(process.argv[1], process.argv.slice(2), { env: { ...process.env, SZ_CHILD: '1' } }).on('exit', ok));
    if (code === 0 || Date.now() > END) process.exit(0);
    wait = Date.now() - t0 > 30 * 60e3 ? 10e3 : Math.min(wait * 2, 10 * 60e3);
    fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ev: 'restart', code, wait_s: wait / 1e3 }) + '\n');
    await new Promise((r) => setTimeout(r, wait));
  }
}
if (process.env.SZ_CHILD) process.on('disconnect', () => process.exit(0));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const log = (o) => { const l = JSON.stringify({ t: new Date().toISOString(), ...o }); fs.appendFileSync(LOG, l + '\n'); console.log(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Params, self-tuned by retune() (params.json, hot-reloaded). size/maxImpact: share of cash / cap as share of the pool
// reserve. Crash: drop between two scans, max rise before, hold. Run mode: start and trail. Survivors and top basket:
// count, hold or exit rank, rebalance period, size, calm window (entry ranks by the lowest price over it: no pump). survTop/topN 0 = off.
const DEFAULTS = { size: 0.25, maxImpact: 0.015, dumpExit: true, crashDrop: 0.25, crashFlat: 0.10, dipHold: 10 * 60e3, runStart: 1.10, runTrail: 0.85,
  survTop: 2, survHold: 30 * 60e3, topN: 10, topExit: 20, topReb: 60 * 60e3, topSize: 0.15, topCalm: 5 * 60e3 };
let P = { ...DEFAULTS, ...readJson(PARAMS) }, paramsMtime = fs.existsSync(PARAMS) ? fs.statSync(PARAMS).mtimeMs : 0;
const MIN_BUY = 1000, MAX_POS = 6, COOLDOWN = 30 * 60e3, CRASH_COOLDOWN = 5 * 60e3, TRIAL = 10, SURV_DELAY = 20e3;
const RUN_HOLD = 120 * 60e3, MANUAL_TRAIL = 0.85, HP_MIN = 0.4, HP_EXIT = 0.25, R0 = 1e6;
const sizeCap = (price) => Math.floor(R0 * Math.sqrt(price / 1000) * P.maxImpact); // own impact ~ size / pool reserve
const state = { peak: {}, exitedAt: {}, entryAt: {}, kind: {}, shares: {}, manualPeak: {}, ...readJson(STATE) };
for (const k of ['kind', 'shares', 'manualPeak']) state[k] ||= {};
const save = () => { try { fs.writeFileSync(STATE + '.tmp', JSON.stringify(state)); fs.renameSync(STATE + '.tmp', STATE); } catch (e) { log({ ev: 'save_err', msg: e.message }); } };

async function notify(text) { // Telegram, only for what needs the operator
  const { TELEGRAM_BOT_TOKEN: tok, TELEGRAM_CHAT_ID: chat } = process.env;
  if (!tok || !chat) return log({ ev: 'notify_skipped', text });
  try { await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: `[safezone-stocks] ${text}` }) }); } catch {}
}

// Browser profile holds the session. A profile still locked by the dying old process serves no cookie: reopen.
let ctx;
for (let i = 0; ; i++) {
  ctx = await chromium.launchPersistentContext('./profile', { headless: !LOGIN, viewport: null });
  const ok = (await ctx.cookies(`https://api.${HOST}`)).some((c) => c.name === 'token');
  if (ok || i >= 11 || LOGIN || fs.existsSync('.session.json')) { if (i) log({ ev: 'profile_retry', tries: i, ok }); break; }
  await ctx.close(); await sleep(5e3);
}
if (fs.existsSync('.session.json')) { // one-shot cookie import (import-cookies.mjs)
  await ctx.addCookies(readJson('.session.json').cookies.filter((c) => c.domain.replace(/^\./, '').endsWith(HOST)));
  fs.unlinkSync('.session.json');
}
if (LOGIN) {
  await (ctx.pages()[0] || await ctx.newPage()).goto(`${SITE}/safezone/stock-market`);
  console.log('Log in in the window, then close it.');
  setInterval(() => {}, 1e9); ctx.on('close', () => process.exit(0)); await new Promise(() => {});
}

// One queue at <= 2.5 req/s (6 req/s got the IP blocked). A block backs off 2 -> 30 min; 429 RATELIMITED is only the
// per-account order throttle: the order fails, the next tick retries.
const H = { origin: SITE, referer: `${SITE}/` };
let queue = Promise.resolve(), blockedUntil = 0, backoff = 0;
function api(path, body) {
  const run = queue.then(async () => {
    if (Date.now() < blockedUntil) return { s: 0, j: null, blocked: true };
    const t0 = Date.now(), res = await (body ? ctx.request.post(API + path, { headers: H, data: body }) : ctx.request.get(API + path, { headers: H }));
    let j = null; try { j = await res.json(); } catch {}
    const r = { s: res.status(), j };
    if ((r.s === 429 && j?.error !== 'RATELIMITED') || (r.s === 403 && j?.error === 'Blocked')) {
      backoff = Math.min(backoff ? backoff * 2 : 2 * 60e3, 30 * 60e3); blockedUntil = Date.now() + backoff; r.blocked = true;
      log({ ev: 'blocked', status: r.s, path, backoff_s: backoff / 1e3 });
      if (backoff >= 8 * 60e3) notify(`API blocked this IP (rate limit), pausing ${backoff / 60e3} min`);
    } else if (r.s < 500) backoff = 0;
    await sleep(400 - (Date.now() - t0));
    return r;
  });
  queue = run.catch(() => {});
  return run;
}

// Map (public, cached 2 s): health, deaths from the roster and from graves. A death knocks the stock -20% 30 s to 2 min
// later. Known deaths are reloaded from data/deaths.jsonl: an in-game blackout hides graves and health.
const diedAt = {}, health = {}, roster = {}, recentDeaths = []; // roster (sigil, live) and recentDeaths (newest last): for the stream
if (fs.existsSync('data/deaths.jsonl')) for (const l of fs.readFileSync('data/deaths.jsonl', 'utf8').split('\n')) if (l) { const d = JSON.parse(l); if (d.t > (diedAt[d.u] || 0)) recentDeaths.push(d); diedAt[d.u] = Math.max(diedAt[d.u] || 0, d.t); }
// revives (18/10, new in the game): an eliminated contestant can come back, and its stock with it. The roster clears
// eliminated_at; that time is kept in revivedAt (data/revives.jsonl), and a death only counts while no revive follows it.
const revivedAt = {};
if (fs.existsSync('data/revives.jsonl')) for (const l of fs.readFileSync('data/revives.jsonl', 'utf8').split('\n')) if (l) { const d = JSON.parse(l); recentDeaths.push(d); revivedAt[d.u] = Math.max(revivedAt[d.u] || 0, d.t); }
recentDeaths.sort((a, b) => a.t - b.t).splice(0, recentDeaths.length - 20);
let pendingDeath = 0, mapLoaded = false;
async function readMap() {
  const r = await ctx.request.get(MAP, { headers: H });
  if (r.status() !== 200) return log({ ev: 'map_err', status: r.status() });
  const { frames } = await r.json();
  Object.assign(health, decodeHealth(frames));
  for (const f of frames) {
    if (!f.text) continue;
    const o = JSON.parse(f.text);
    for (const c of o.type === 'contestants' ? o.data.roster?.contestants || [] : []) {
      const n = String(c.name).toLowerCase();
      if (c.eliminated_at) { if (!deadAfter(diedAt[n], revivedAt[n])) diedAt[n] = Date.parse(c.eliminated_at); }
      else if (deadAfter(diedAt[n], revivedAt[n]) && Date.now() - diedAt[n] > 30e3) { // 30 s: a grave can show before the roster
        const d = { u: n, t: Date.now(), revive: true, died: diedAt[n] };
        fs.appendFileSync('data/revives.jsonl', JSON.stringify(d) + '\n'); log({ ev: 'revive', name: n, died_at: diedAt[n] });
        recentDeaths.push(d); if (recentDeaths.length > 20) recentDeaths.shift();
        revivedAt[n] = d.t;
      }
      roster[n] = { sigil: c.sigil, live: !!c.live }; // for the stream's status page
    }
    for (const it of o.type === 'game_items' ? o.data.items : []) {
      if (it.kind !== 'gravestone' || !it.grave) continue;
      const n = it.grave.username.toLowerCase(), t = Date.parse(it.grave.died_at);
      if ((diedAt[n] || 0) >= t) continue;
      fs.appendFileSync('data/deaths.jsonl', JSON.stringify({ u: n, t, cause: it.grave.cause, source: it.grave.source }) + '\n');
      recentDeaths.push({ u: n, t, cause: it.grave.cause, source: it.grave.source }); if (recentDeaths.length > 20) recentDeaths.shift();
      diedAt[n] = t;
      if (mapLoaded && Date.now() - t < 2 * 60e3) pendingDeath = Math.max(pendingDeath, t); // live, not a start replay
    }
  }
  mapLoaded = true;
}
const hpOf = (name) => health[name.toLowerCase()];
// never buy dead, outside the zone or under HP_MIN; a holding is sold under HP_EXIT (leaving the zone alone is not enough)
const risky = (name, frac = HP_MIN) => { const h = hpOf(name); return !!h && (!h.alive || (frac === HP_MIN && h.out) || h.hp < h.max * frac); };
const dead = (name, since = 0) => deadAfter(diedAt[name.toLowerCase()], revivedAt[name.toLowerCase()], since);
async function dumped(h, since) { // a sell knocking the price down >= DUMP_DROP since `since`
  const r = await api(`stock-market/stocks/${h.external_id}/trades?page=1&pageSize=20`);
  return (r.j?.data || []).some((t) => t.side === 'sell' && Date.parse(t.occurred_at) > since && (t.price_before_cents - t.price_after_cents) / t.price_before_cents >= DUMP_DROP);
}

// Orders. Kick chat announcement when KICK_BEARER is set. The engine tracks its own shares: the operator may hold the same stock.
const say = (name, msg) => execFile('python', ['kick_say.py', name, msg], { timeout: 30e3 }, (err, out) => log({ ev: 'kick_say', name, out: String(out).trim(), err: err?.message?.slice(0, 120) }));
async function trade(side, h, payload, why) {
  const body = { stock_external_id: h.external_id, request_id: crypto.randomUUID(), ...payload };
  if (DRY) return log({ ev: 'dry', side, name: h.name, why, body });
  const r = await api(side, body), id = h.external_id;
  log({ ev: side, name: h.name, why, status: r.s, res: r.j });
  if (r.j?.balance_after_cents != null) lastCash = r.j.balance_after_cents;
  if (r.s === 200 && r.j?.shares) { if (side.endsWith('buy')) state.shares[id] = String(BigInt(state.shares[id] || 0) + BigInt(r.j.shares)); else delete state.shares[id]; }
  if (r.s === 200 && process.env.KICK_BEARER) say(h.name, sayText(side, h.name, r.j?.cash_cents ?? 0, fs.readFileSync(LOG, 'utf8').split('\n')));
  return r;
}
async function buy(s, amt, why, kind) {
  const t = await trade('stock-market/buy', s, { cash_cents: amt }, why);
  if (t?.s === 200) { state.peak[s.external_id] = s.last_price_cents; state.entryAt[s.external_id] = Date.now(); state.kind[s.external_id] = kind; save(); }
  return t;
}
async function sellOwn(h, why) {
  const id = h.external_id, own = state.shares[id] && BigInt(state.shares[id]) < BigInt(h.shares) ? state.shares[id] : h.shares;
  if ((await trade('stock-market/sell', h, { shares: own }, why))?.s !== 200) return;
  delete state.peak[id]; delete state.entryAt[id]; delete state.kind[id]; state.exitedAt[id] = Date.now();
  me.holdings = me.holdings.filter((x) => x.external_id !== id);
}
const cash = async () => (await api('cx-bucks/balance')).j?.balance_cents ?? 0;
const entryCache = {}; // entry price = price_after of the last successful buy of that stock in the log
function entryPx(h) {
  const k = `${h.external_id}:${state.entryAt[h.external_id]}`;
  if (entryCache[k]) return entryCache[k];
  const l = fs.readFileSync(LOG, 'utf8').split('\n').filter((x) => x.includes('"ev":"stock-market/buy"') && x.includes(`"name":${JSON.stringify(h.name)}`) && x.includes('"status":200')).at(-1);
  return (entryCache[k] = (l && JSON.parse(l).res?.price_after_cents) || Infinity);
}
// Kill switch: after TRIAL round trips of a strategy, it stops if their total is negative (retune can re-arm it).
const trialOff = {};
function trialOn(prefix) {
  if (trialOff[prefix]) return false;
  const { n, pnl } = trialTally(fs.readFileSync(LOG, 'utf8').split('\n'), prefix);
  if (n >= TRIAL && pnl < 0) { trialOff[prefix] = true; log({ ev: `${prefix}_off`, n, pnl }); notify(`strategy ${prefix} switched off: ${n} round trips, ${(pnl / 100).toFixed(2)} Cx`); }
  return !trialOff[prefix];
}

// Exits, every 5 s. Manual positions: trail, death, hp, elimination, dump; never on time. Engine positions: crash ('dip')
// and survivor buys sell on time unless in run mode (peak >= runStart x entry: runTrail trail, RUN_HOLD cap); the top
// basket sells on rank (scan). All: status, death, hp, elimination. /me 500s: last holdings, repriced one by one.
let me = null, authAlerted = false, lastOk = Date.now(), authLostAt = 0, lastBreadth = 0, names = {}, movers = [], ranking = [];
const lastPrice = {}, status = {}, eliminated = {}, lastTradeAt = {}, STARTED = Date.now();
async function guard() {
  const r = await api('stock-market/me');
  if (r.blocked) return;
  if (r.s === 401 || r.s === 403) {
    authLostAt ||= Date.now();
    if (!authAlerted) { authAlerted = true; log({ ev: 'auth_lost', status: r.s }); notify('session expired: run `node engine.mjs --login` (or import-cookies.mjs), then restart'); }
    return;
  }
  let holdings = [];
  if (r.s === 200) { if (authAlerted) log({ ev: 'auth_ok' }); authAlerted = false; authLostAt = 0; lastOk = Date.now(); me = r.j; holdings = me.holdings; }
  else {
    log({ ev: 'me_err', status: r.s });
    if (!me) return;
    for (const h of me.holdings) { const q = await api(`stock-market/stocks/${h.external_id}`); if (q.s === 200) holdings.push({ ...h, last_price_cents: q.j.last_price_cents }); }
  }
  for (const h of holdings) {
    const p = h.last_price_cents, id = h.external_id, gone = dead(h.name, state.entryAt[id] ? state.entryAt[id] - 60e3 : Date.now() - 10 * 60e3) || hpOf(h.name)?.alive === false;
    const common = status[id] && status[id] !== 'active' && status[id] !== 'paused' ? `status ${status[id]}` : gone ? `died ${p}`
      : risky(h.name, HP_EXIT) ? `hp ${hpOf(h.name).hp}/${hpOf(h.name).max} ${p}` : eliminated[id] ? `eliminated ${p}` : null;
    if (!state.entryAt[id]) {
      const pk = state.manualPeak[id] = Math.max(state.manualPeak[id] || 0, p);
      const why = p < pk * MANUAL_TRAIL ? `manual trail ${p}<${Math.round(pk * MANUAL_TRAIL)}` : common ? `manual ${common}`
        : P.dumpExit && p <= (lastPrice[id] ?? p) * (1 - DUMP_DROP) && await dumped(h, Date.now() - 60e3) ? `manual dump ${p}` : null;
      lastPrice[id] = p;
      if (why && (await trade('stock-market/sell', h, { shares: h.shares }, why))?.s === 200) { delete state.manualPeak[id]; me.holdings = me.holdings.filter((x) => x.external_id !== id); }
      continue;
    }
    state.peak[id] = Math.max(state.peak[id] || 0, p);
    const kind = state.kind[id], top = kind === 'top', run = !top && state.peak[id] >= entryPx(h) * P.runStart;
    const why = run && p < state.peak[id] * P.runTrail ? `runtrail ${p}<${Math.round(state.peak[id] * P.runTrail)}`
      : !top && Date.now() - state.entryAt[id] > (run ? RUN_HOLD : kind === 'surv' ? P.survHold : P.dipHold) ? `time ${p}` : common;
    lastPrice[id] = p;
    if (why) await sellOwn(h, why);
  }
  save();
  writeLive();
}

// Dashboard feed: what only this process knows, rewritten every guard tick (live.json, write-then-rename), plus one total
// value point a minute (data/equity.jsonl). /me has no cash field: cash = balance after the latest order, seeded from the log.
let lastMarket = null, lastEquity = 0;
let lastCash = (() => { const l = fs.readFileSync(LOG, 'utf8').split('\n').findLast((x) => x.includes('"balance_after_cents"')); return l ? JSON.parse(l).res.balance_after_cents : null; })();
function writeLive() {
  const entry = {};
  for (const h of me?.holdings || []) if (state.entryAt[h.external_id]) entry[h.external_id] = entryPx(h);
  fs.writeFileSync('live.json.tmp', JSON.stringify({ t: Date.now(), pid: process.pid, startedAt: STARTED, dry: DRY, end: END, P, me, state, entry, market: lastMarket,
    health, roster, hpFeed: Object.keys(health).length > 0, trialOff, api: { blockedUntil, backoff, lastOk, authLostAt }, lastReb, diedAt, revivedAt }));
  fs.renameSync('live.json.tmp', 'live.json');
  if (me && Date.now() - lastEquity >= 60e3) {
    lastEquity = Date.now();
    fs.appendFileSync('data/equity.jsonl', JSON.stringify({ t: lastEquity, value: lastCash == null ? null : lastCash + me.portfolio_value_cents, cash: lastCash, held: me.portfolio_value_cents, realized: me.realized_pnl_cents, unrealized: me.unrealized_pnl_cents, n: me.holdings.length }) + '\n');
  }
}

// Stream, every 2 s: the ticker and the current page (a new one every 20 s) split into one text per color, each after
// an "@@name" line and closed by "@@end", written to ONE long-lived ssh to STREAM_SSH (no handshake per frame). There
// awk writes ticker.txt, dash.txt (white), g/r/y/c.txt and art.txt, each replaced whole at "@@end", drawn by
// stream/run.sh. A dead connection is reopened on the next tick.
const SPLIT = 'cd szdash && exec awk \'/^@@end$/ { for (k in seen) { close(k ".tmp"); system("mv -f " k ".tmp " k ".txt") } delete seen; next } /^@@[a-z]+$/ { f = substr($0, 3); seen[f] = 1; printf "" > (f ".tmp"); next } { print > (f ".tmp") }\'';
let pipe = null;
function pushStream() {
  if (!me || !process.env.STREAM_SSH) return;
  if (!pipe) {
    pipe = spawn(process.env.STREAM_SSH_BIN || 'ssh', ['-o', 'ServerAliveInterval=30', process.env.STREAM_SSH, SPLIT], { stdio: ['pipe', 'ignore', 'ignore'] });
    const drop = (e) => { if (e) log({ ev: 'stream_err', msg: String(e.message || e) }); pipe = null; };
    pipe.on('error', drop); pipe.on('exit', () => drop()); pipe.stdin.on('error', drop);
  }
  const d = { me, names, health, roster, revived: revivedAt, breadth: lastBreadth, startedAt: STARTED, kindOf: (id) => state.kind[id] || (state.entryAt[id] ? 'crash' : ''), deaths: recentDeaths, movers, ranking,
    strategies: roundTrips(fs.readFileSync(LOG, 'utf8').split('\n'), ['top', 'crash', 'surv', 'dip']) }, pages = streamPages(d);
  const i = Math.floor(Date.now() / 20e3) % pages.length, L = layers(pages[i]);
  // profit overlay: total PnL (realized + open) big in the header, green when positive (pg) or red (pr), detail in ps
  const cx = (x) => `${x >= 0 ? '+' : '-'}${(Math.abs(x) / 100).toFixed(2)}`, total = me.realized_pnl_cents + me.unrealized_pnl_cents;
  const P = { pg: total >= 0 ? `PROFIT ${cx(total)} Cx` : ' ', pr: total < 0 ? `PROFIT ${cx(total)} Cx` : ' ', ps: `realized ${cx(me.realized_pnl_cents)}   open ${cx(me.unrealized_pnl_cents)}` };
  pipe?.stdin.write(`@@ticker\n${streamTicker(d)}\n` + Object.entries({ dash: L.w, g: L.g, r: L.r, y: L.y, c: L.c, art: ARTS[i % ARTS.length], ...P }).map(([k, v]) => `@@${k}\n${v}\n`.replace(/\n\n$/, '\n')).join('') + '@@end\n');
}

// Entries, every 15 s, one order per scan. Top basket: hold the topN highest-priced live stocks, sell at rank topExit
// every topReb. Then (at most MAX_POS other positions): survivors 20 s after a fresh death, else the deepest crash.
const lastScan = {};
let lastReb = 0;
// one ASCII art per stream page (stream/art1-5.txt), drawn under the mascot
const ARTS = [1, 2, 3, 4, 5].map((n) => { try { return fs.readFileSync(`stream/art${n}.txt`, 'utf8'); } catch { return ' \n'; } });
async function scan() {
  const now = Date.now(), stocks = [], spark = {};
  for (let page = 1; page <= 3; page++) {
    const s = await api(`stock-market/stocks?page=${page}&pageSize=100&search=`), k = await api(`stock-market/sparklines?bucket_ms=60000&since_ms=${now - Math.max(BREADTH_WINDOW, P.topCalm || 0)}&page=${page}&pageSize=100`);
    stocks.push(...(s.j?.stocks || []));
    for (const x of k.j?.sparklines || []) spark[x.external_id] = x.points;
    if ((s.j?.stocks || []).length < 100) break;
  }
  if (stocks.length) lastOk = now;
  for (const s of stocks) { status[s.external_id] = s.status; eliminated[s.external_id] = !!s.eliminated_at; names[s.external_id] = s.name; if (s.last_trade_at) lastTradeAt[s.external_id] = Date.parse(s.last_trade_at); }
  const priceSince = (id, x) => (spark[id] || []).find((p) => p.t >= x - 60e3)?.price_cents; // 1-min buckets
  const prev = {};
  for (const s of stocks) { const p = lastScan[s.external_id]; if (p && now - p.t <= 30e3) prev[s.external_id] = p.price; lastScan[s.external_id] = { price: s.last_price_cents, t: now }; }
  const active = stocks.filter((s) => s.status === 'active'), fresh = (s) => s.last_trade_at && now - Date.parse(s.last_trade_at) < 30 * 60e3;
  if (active.length) lastBreadth = breadthOf(active.filter((s) => s.last_trade_at && !s.eliminated_at).map((s) => [s.last_price_cents, priceSince(s.external_id, now - BREADTH_WINDOW) ?? s.last_price_cents]));
  log({ ev: 'scan', breadth: +lastBreadth.toFixed(2), stocks: stocks.length });
  if (stocks.length) lastMarket = { t: now, breadth: lastBreadth, stocks: stocks.map((s) => ({ id: s.external_id, name: s.name, p: s.last_price_cents, st: s.status, el: !!s.eliminated_at,
    lt: s.last_trade_at ? Date.parse(s.last_trade_at) : 0, prev: prev[s.external_id] ?? null, p5: priceSince(s.external_id, now - BREADTH_WINDOW) ?? null })) };
  // for the stream: 5-min moves and price ranking of the live, recently traded stocks
  const listed = active.filter((s) => !s.eliminated_at && fresh(s));
  if (listed.length) {
    movers = listed.map((s) => { const p5 = priceSince(s.external_id, now - BREADTH_WINDOW); return { name: s.name, ret: p5 ? s.last_price_cents / p5 - 1 : 0 }; }).filter((m) => m.ret);
    ranking = listed.map((s) => ({ name: s.name, price: s.last_price_cents })).sort((a, b) => b.price - a.price);
  }
  if (!me || !me.trading_enabled) return;
  const live = active.filter((s) => !s.eliminated_at && !dead(s.name) && !risky(s.name));
  if (P.topN > 0) {
    const ranked = live.filter(fresh).sort((a, b) => b.last_price_cents - a.last_price_cents), rank = new Map(ranked.map((s, i) => [s.external_id, i]));
    if (now - lastReb >= P.topReb) {
      lastReb = now;
      for (const h of me.holdings.filter((x) => state.kind[x.external_id] === 'top' && !(rank.get(x.external_id) < P.topExit))) await sellOwn(h, `toprank ${rank.get(h.external_id) ?? 'out'} ${h.last_price_cents}`);
    }
    // entry by calm price (the lowest of now, topCalm/2 and topCalm ago; no sparkline point = no trade = calm): a 30 s pump never ranks
    const calm = (x) => P.topCalm ? calmPrice(x.last_price_cents, priceSince(x.external_id, now - P.topCalm / 2) ?? x.last_price_cents, priceSince(x.external_id, now - P.topCalm) ?? x.last_price_cents) : x.last_price_cents;
    const mine = new Set(me.holdings.map((h) => h.external_id)), s = ranked.toSorted((a, b) => calm(b) - calm(a)).slice(0, P.topN).find((x) => !mine.has(x.external_id));
    if (s && trialOn('top')) {
      const c = await cash(), amt = Math.min(Math.floor(c * P.topSize), sizeCap(s.last_price_cents));
      const t = amt >= MIN_BUY && amt <= c && await buy(s, amt, `top #${rank.get(s.external_id) + 1} @${s.last_price_cents}`, 'top');
      if (t?.s === 200) return me.holdings.push({ external_id: s.external_id, name: s.name, shares: t.j.shares, last_price_cents: s.last_price_cents }); // until the next /me
    }
  }
  if (me.holdings.filter((h) => state.kind[h.external_id] !== 'top').length >= MAX_POS) return;
  const held = new Set(me.holdings.map((h) => h.external_id)), cooled = (ms) => live.filter((s) => !held.has(s.external_id) && now - (state.exitedAt[s.external_id] || 0) > ms);
  if (pendingDeath && now - pendingDeath >= SURV_DELAY) {
    pendingDeath = 0;
    const room = P.survTop - me.holdings.filter((h) => state.kind[h.external_id] === 'surv').length;
    if (room > 0 && trialOn('surv')) {
      for (const s of cooled(COOLDOWN).filter(fresh).sort((a, b) => b.last_price_cents - a.last_price_cents).slice(0, room)) {
        const c = await cash(), amt = Math.min(Math.floor(c * P.size), sizeCap(s.last_price_cents));
        if (amt < MIN_BUY || amt > c) break;
        await buy(s, amt, `surv @${s.last_price_cents}`, 'surv');
      }
      return;
    }
  }
  if (!trialOn('crash')) return;
  const d = cooled(CRASH_COOLDOWN).map((s) => { const p = prev[s.external_id], p3 = priceSince(s.external_id, now - 3 * 60e3); return { s, ret: p && p3 && p / p3 - 1 < P.crashFlat ? s.last_price_cents / p - 1 : 0 }; })
    .filter((x) => x.ret <= -P.crashDrop).sort((a, b) => a.ret - b.ret)[0];
  if (!d) return;
  const c = await cash(), amt = Math.min(Math.floor(c * P.size), sizeCap(d.s.last_price_cents));
  if (amt >= MIN_BUY && amt <= c) await buy(d.s, amt, `crash ${(d.ret * 100).toFixed(0)}% @${d.s.last_price_cents}`, 'dip');
}

// Tape recorder (feeds the tuning): new public trades of the stocks that traded since their watermark, <= 5 pages each.
const mark = {};
for (const r of loadTape(Date.now() - 2 * 86400e3)) mark[r.e] = Math.max(mark[r.e] || 0, r.t);
async function record() {
  let added = 0, failed = 0, capped = 0; const out = {};
  for (const id of Object.keys(status)) {
    const since = mark[id] || 0; let newest = since, page = 1;
    if ((lastTradeAt[id] || 0) <= since) continue;
    for (; page <= 5; page++) {
      const r = await api(`stock-market/stocks/${id}/trades?page=${page}&pageSize=100`);
      if (r.s !== 200) { failed++; break; }
      const rows = (r.j.data || []).map(compact), fresh = rows.filter((x) => x.t > since);
      for (const x of fresh) { (out[new Date(x.t).toISOString().slice(0, 10)] ||= []).push(JSON.stringify(x)); newest = Math.max(newest, x.t); added++; }
      if (fresh.length < rows.length || page * 100 >= r.j.total) break;
    }
    if (page > 5) capped++;
    mark[id] = newest;
  }
  fs.mkdirSync('data', { recursive: true });
  for (const [day, lines] of Object.entries(out)) fs.appendFileSync(`data/tape-${day}.jsonl`, lines.join('\n') + '\n');
  log({ ev: 'record', added, failed, capped });
}

// Self-tuning on the last 24 h of tape (adopts a setting only if it wins in both halves; may switch a strategy off),
// and re-arms a kill-switched strategy whose setting wins again.
async function retune() {
  const tape = loadTape(Date.now() - 24 * 3600e3);
  if (tape.length < 500) return log({ ev: 'tune_skip', trades: tape.length });
  const deaths = [...new Map(fs.readFileSync('data/deaths.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((d) => [d.u + d.t, d])).values()].sort((a, b) => a.t - b.t);
  const c = tuneCrash(tape, P), lower = Object.fromEntries(Object.entries(names).map(([id, n]) => [id, n.toLowerCase()]));
  const sv = tuneSurv(tape, { ...P, runStart: c.adopt?.runStart ?? P.runStart, runTrail: c.adopt?.runTrail ?? P.runTrail }, deaths, lower), tp = tuneTop(tape, P);
  for (const [ev, x] of [['tune_crash', c], ['tune_surv', sv], ['tune_top', tp]]) log({ ev, cur: x.cur, best: x.best && { ...x.best.r, Q: x.best.Q }, adopt: x.adopt });
  for (const [prefix, r] of [['crash', c.adopt ? c.best.r : c.cur], ['surv', sv.adopt?.survTop ? sv.best.r : sv.cur], ['top', tp.adopt?.topN ? tp.best.r : tp.cur]]) {
    if (trialOn(prefix) || !r || r.n < 8 || r.h1 <= 0 || r.h2 <= 0) continue;
    delete trialOff[prefix]; log({ ev: `${prefix}_on`, ...r }); notify(`strategy ${prefix} switched back on: replay ${r.n} trades, ${r.total.toFixed(2)}`);
  }
  if (!c.adopt && !sv.adopt && !tp.adopt) return;
  P = { ...P, ...c.adopt, ...sv.adopt, ...tp.adopt };
  fs.writeFileSync(PARAMS, JSON.stringify(P)); paramsMtime = fs.statSync(PARAMS).mtimeMs;
  notify(`new params ${JSON.stringify(P)}`);
}
async function reloadParams() { // edit params.json: picked up within 30 s, no restart
  const m = fs.existsSync(PARAMS) ? fs.statSync(PARAMS).mtimeMs : 0;
  if (m !== paramsMtime) { paramsMtime = m; P = { ...DEFAULTS, ...readJson(PARAMS) }; log({ ev: 'params_reload', P }); }
}
const daily = async () => me && notify(`portfolio ${(me.portfolio_value_cents / 100).toFixed(2)}, realized PnL ${(me.realized_pnl_cents / 100).toFixed(2)}, unrealized ${(me.unrealized_pnl_cents / 100).toFixed(2)}`);

const loop = (fn, ms) => { let busy = false; setInterval(async () => { if (busy) return; busy = true; try { await fn(); } catch (e) { log({ ev: 'err', fn: fn.name, msg: e.message }); } finally { busy = false; } }, ms); };
setInterval(() => { if (Date.now() > END) { log({ ev: 'end' }); daily().finally(() => process.exit(0)); } }, 60e3);
setInterval(() => { const s = stuck(Date.now(), lastOk, blockedUntil, authLostAt); if (s.stale || s.lost) { log({ ev: 'watchdog', ...s }); process.exit(1); } }, 30e3); // the supervisor restarts us
log({ ev: 'start', dry: DRY, P });
await guard().catch((e) => log({ ev: 'err', fn: 'guard', msg: e.message }));
// map: the site caches it 2 s; stream: near real time. One call per line: on 18/10 a comment in the middle of this
// line swallowed record, retune, daily and reloadParams for 8 h (check.mjs now fails on a call hidden that way).
loop(guard, 5e3);
loop(scan, 15e3);
loop(readMap, 3e3);
loop(pushStream, 2e3);
loop(record, 3 * 60e3);
loop(retune, 2 * 3600e3);
loop(daily, 24 * 3600e3);
loop(reloadParams, 30e3);
setTimeout(() => retune().catch((e) => log({ ev: 'err', fn: 'retune', msg: e.message })), 60e3); // after the first scans: names known
