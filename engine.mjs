// SafeZone stock market engine. Session lives only in ./profile (persistent browser profile).
// First run: node engine.mjs --login  (headed, log in, then close the window), or import cookies with
// import-cookies.mjs. Then: node engine.mjs. Config in .env (see .env.example).
import { chromium } from 'playwright';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { tune, loadTape, compact, breadthOf, BREADTH_WINDOW, DUMP_DROP, sayText, decodeHealth } from './backtest.mjs';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const HOST = process.env.SITE_HOST; // event site domain, e.g. example.com (api.<host>, event-public.<host>)
if (!HOST) { console.error('SITE_HOST missing in .env (see .env.example)'); process.exit(1); }
const SITE = `https://${HOST}`, API = `https://api.${HOST}/public/`;
const LOGIN = process.argv.includes('--login');
const DRY = process.argv.includes('--dry');
const END = Date.parse(process.env.END_AT || '2026-10-24T20:20:00Z'); // the engine exits for good after this
if (Date.now() > END && !LOGIN) process.exit(0);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };

// Strategy params. Defaults from backtest.mjs on the opening tape (17/10): 2-min lookback and a 10-min
// time exit led every top combo; minBreadth gates momentum to market-wide inflow phases (see backtest.mjs).
// retune() replaces them from fresh tape.
const DEFAULTS = { lookback: 2 * 60e3, entryMin: 0.15, entryMax: 99, trail: 0.80, maxHold: 10 * 60e3, size: 0.25, minBreadth: 0.6, dumpExit: true, dumpBreadth: 0.45 };
const PARAMS = 'params.json';
let P = { ...DEFAULTS, ...readJson(PARAMS) };
const MIN_BUY = 1000;          // 10.00 minimum per entry
const MAX_POS = 6;
const COOLDOWN_MS = 30 * 60e3; // no re-entry on a stock for 30 min after exit
const ME_EVERY = 5e3, SCAN_EVERY = 15e3, RECORD_EVERY = 3 * 60e3, TUNE_EVERY = 2 * 3600e3, TUNE_WINDOW = 6 * 3600e3;

const STATE = 'state.json', LOG = 'trades.jsonl';
// state.json is rewritten every 5 s: write-then-rename so a crash mid-write cannot leave a file that
// makes every restart throw; an unreadable file falls back to empty state instead of a crash loop.
const state = { peak: {}, exitedAt: {}, entryAt: {}, kind: {}, ...readJson(STATE) };
state.kind ||= {};
state.shares ||= {}; // external_id -> share subunits bought by the engine (string, BigInt-safe)

// Rebound buys (kind 'dip' in state) exit on time/death only, after DIP_HOLD. Pump chasing was measured on 18/10
// (20:22-00:40 tape): buying after a +5/10/20% buy loses -4% to -17% even 2 s after it, exit on the first dump sell.
const DIP_HOLD = 10 * 60e3;
const RUN_START = 1.10, RUN_TRAIL = 0.85, RUN_HOLD = 120 * 60e3; // doubled from 60 min on request (18/10)
// entry price of a holding: price_after of its last successful buy in the log (cached per stock)
const entryCache = {};
function entryPx(h) {
  const k = `${h.external_id}:${state.entryAt[h.external_id]}`; // a new buy of the same stock gets a new key
  if (entryCache[k]) return entryCache[k];
  const l = fs.readFileSync(LOG, 'utf8').split('\n').filter((x) => x.includes('"ev":"stock-market/buy"') && x.includes(`"name":${JSON.stringify(h.name)}`) && x.includes('"status":200')).at(-1);
  return (entryCache[k] = (l && JSON.parse(l).res?.price_after_cents) || Infinity);
}
const CRASH_DROP = 0.25, CRASH_FLAT = 0.10, CRASH_TRIAL = 10;
const lastScan = {}; // external_id -> { price, t } at the previous scan
// trial guard: after CRASH_TRIAL round trips of a strategy (buy reason prefix), stop it if their total is negative
const trialOff = {};
function trialOn(prefix) {
  if (trialOff[prefix]) return false;
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes('"status":200') && /"ev":"stock-market\/(buy|sell)"/.test(l)).map((l) => JSON.parse(l));
  const open = {}; let n = 0, pnl = 0;
  for (const e of lines) {
    if (e.ev.endsWith('buy')) { if (String(e.why).startsWith(prefix)) open[e.name] = e.res.cash_cents; else delete open[e.name]; }
    else if (open[e.name] != null) { n++; pnl += e.res.cash_cents - open[e.name]; delete open[e.name]; }
  }
  if (n >= CRASH_TRIAL && pnl < 0) { trialOff[prefix] = true; log({ ev: `${prefix}_off`, n, pnl }); notify(`strategy ${prefix} switched off: ${n} round trips, ${(pnl / 100).toFixed(2)} Cx`); }
  return !trialOff[prefix];
}
const crashOn = () => trialOn('crash');
// Survivors after a death (aggressive trial asked by the operator, 18/10): 20 s after a new
// grave, buy the SURV_TOP highest-priced live stocks, hold SURV_HOLD. Tape 20:22-00:40, top 2 held 30 min: 23h UTC
// +3.5% (n=14, 64% win) but 21h -10.4% (n=102): the late game only, hence the same 10-round-trip kill switch.
// Live 18/10 01:08-01:42: 5 closed -23.51 Cx, but the 6th (riding in run mode) +60.84 open: small losses, rare big
// runs. Kept on; the 10-round-trip switch decides. SURV_TOP 0 disables it.
const SURV_TOP = 2, SURV_HOLD = 30 * 60e3, SURV_DELAY = 20e3;
let pendingDeath = 0;
// Size cap: pools are thin (cash reserve R ~ R0*sqrt(P/1000), R0 = 10k Cx). A buy of c moves the price ~2c/R and the
// round trip costs ~2c/R. 1st live dip (17/10 22:18, 219 Cx at 10.69): our own buy pushed +4.2%, the round trip
// lost -3.2% though the stock "rose" 1069 -> 1111. Cap c at 0.75% of R: ~1.5% round-trip impact.
const R0 = 1e6, MAX_IMPACT = 0.0075;
const sizeCap = (priceCents) => Math.floor(R0 * Math.sqrt(priceCents / 1000) * MAX_IMPACT);
let status = {}; // external_id -> active | paused | eliminated..., refreshed by scan()
const save = () => { fs.writeFileSync(STATE + '.tmp', JSON.stringify(state)); fs.renameSync(STATE + '.tmp', STATE); };
const log = (o) => { const l = JSON.stringify({ t: new Date().toISOString(), ...o }); fs.appendFileSync(LOG, l + '\n'); console.log(l); };

// Telegram only for what needs the operator: lost session, param changes, daily PnL. No per-trade spam.
async function notify(text) {
  const { TELEGRAM_BOT_TOKEN: tok, TELEGRAM_CHAT_ID: chat } = process.env;
  if (!tok || !chat) return log({ ev: 'notify_skipped', text });
  try { await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: `[safezone-stocks] ${text}` }) }); } catch {}
}

// Stop-ScheduledTask returns before the old engine dies (18/10 00:46: old scan at :51.7, new start at :52.2). A browser
// opened on the still-locked profile sees no cookie and every /me is 401 for the whole run (5 restarts out of 9).
// Reopen until the session cookie is there.
let ctx;
for (let i = 0; ; i++) {
  ctx = await chromium.launchPersistentContext('./profile', { headless: !LOGIN, viewport: null });
  const ok = (await ctx.cookies(`https://api.${HOST}`)).some((c) => c.name === 'token');
  if (ok || i >= 11 || LOGIN || fs.existsSync('.session.json')) { if (i) log({ ev: 'profile_retry', tries: i, ok }); break; }
  await ctx.close();
  await new Promise((r) => setTimeout(r, 5e3));
}
// One-shot import of an exported session: keep only the site cookies, then delete the file.
if (fs.existsSync('.session.json')) {
  const { cookies } = JSON.parse(fs.readFileSync('.session.json', 'utf8'));
  await ctx.addCookies(cookies.filter((c) => c.domain.replace(/^\./, '').endsWith(HOST)));
  fs.unlinkSync('.session.json');
}
if (LOGIN) {
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(`${SITE}/safezone/stock-market`);
  console.log('Log in in the window, then close it.');
  setInterval(() => {}, 1e9); // keep Node alive: a bare pending promise lets it exit
  ctx.on('close', () => process.exit(0));
  await new Promise(() => {});
}

// context.request shares the profile's cookie jar; nothing is copied out of it.
const H = { origin: SITE, referer: `${SITE}/` };
// Rate discipline. 17/10 20:45: a ~6 req/s burst (recorder paging history) got this IP {"error":"Blocked"} on the API.
// All calls go through one queue at <= 2.5 req/s (4 req/s held 45 s without a block, too close to 6);
// steady load is ~0.7 req/s. Blocked/429 stops every call, backing off 2 -> 30 min.
const MIN_GAP = 400;
let queue = Promise.resolve(), blockedUntil = 0, backoff = 0;
const isBlocked = (r) => r.s === 429 || (r.s === 403 && r.j?.error === 'Blocked');
function api(path, body) {
  const run = queue.then(async () => {
    if (Date.now() < blockedUntil) return { s: 0, j: null, blocked: true };
    const t0 = Date.now();
    const res = body
      ? await ctx.request.post(API + path, { headers: H, data: body })
      : await ctx.request.get(API + path, { headers: H });
    let j = null; try { j = await res.json(); } catch {}
    const r = { s: res.status(), j };
    if (isBlocked(r)) {
      backoff = Math.min(backoff ? backoff * 2 : 2 * 60e3, 30 * 60e3);
      blockedUntil = Date.now() + backoff;
      log({ ev: 'blocked', status: r.s, path, backoff_s: backoff / 1e3 });
      if (backoff >= 8 * 60e3) notify(`API blocked this IP (rate limit), pausing ${backoff / 60e3} min`);
      r.blocked = true;
    } else if (r.s < 500) backoff = 0;
    await new Promise((ok) => setTimeout(ok, Math.max(0, MIN_GAP - (Date.now() - t0))));
    return r;
  });
  queue = run.catch(() => {});
  return run;
}

let me = null, authAlerted = false, lastBreadth = null; // null until the first scan: regime unknown, no dump exit

// Live map (separate host, public, cached 2 s). A contestant's death puts a -20% impulse on their stock 30 s to
// 2 min later (17/10, four deaths: 10.28 -> 8.22, 10.25 -> 8.18, 14.89 -> 11.83, 11.56 -> 8.97).
// Graves are matched to stocks by username = stock name. Position frames are never read (see decodeHealth).
const MAP = `https://event-public.${HOST}/event/map-snapshot`;
const diedAt = {}; // lowercased username -> latest death time (ms)
async function readMap() {
  const r = await ctx.request.get(MAP, { headers: H });
  if (r.status() !== 200) return log({ ev: 'map_err', status: r.status() });
  const { frames } = await r.json();
  readHealth(frames);
  for (const f of frames) {
    if (!f.text || !f.text.includes('"game_items"')) continue;
    for (const it of JSON.parse(f.text).data.items) {
      if (it.kind !== 'gravestone' || !it.grave) continue;
      const name = it.grave.username.toLowerCase(), t = Date.parse(it.grave.died_at);
      if ((diedAt[name] || 0) >= t) continue;
      fs.appendFileSync('data/deaths.jsonl', JSON.stringify({ u: name, t, cause: it.grave.cause, source: it.grave.source }) + '\n'); // restarts re-log: dedupe on (u, t)
      diedAt[name] = t;
      // fresh death seen live; the first map read after a start only loads history (01:09 restart re-bought a death)
      if (mapLoaded && Date.now() - t < 2 * 60e3) pendingDeath = Math.max(pendingDeath, t);
    }
  }
  mapLoaded = true;
}
let mapLoaded = false;
// Health (added 18/10: avoid buying contestants about to die), decoded by decodeHealth (backtest.mjs) from the map snapshot.
const health = {}; // lowercased username -> { hp, max, alive, out }
const readHealth = (frames) => Object.assign(health, decodeHealth(frames));
// risky = dead in the feed, outside the zone, or under HP_MIN of max: never buy, and sell a holding under HP_EXIT
const HP_MIN = 0.4, HP_EXIT = 0.25;
const hpOf = (name) => health[name.toLowerCase()];
// leaving the zone costs ~1 hp per update: it blocks buys, but a holding is only sold once hp itself is low
const risky = (name, frac = HP_MIN) => { const h = hpOf(name); return !!h && (!h.alive || (frac === HP_MIN && h.out) || h.hp < h.max * frac); };

const recentlyDied = (name, since) => (diedAt[name.toLowerCase()] || 0) > since;
const lastPrice = {}, lastTradeAt = {}, eliminated = {}; // per stock: price at previous guard tick; last_trade_at seen by scan()

// Dump signature (17/10 tape, outside the opening rush): after a >20% run-up, one sell that knocks the price
// down >= 5% was followed by -10% within a minute (n=33). During the rush the same dips were bought (+9% at 3 min),
// so this exit only fires while breadth is under P.dumpBreadth (0.45: opening breadth ran 45-60%, the later
// phase 30-45%; gating at 0.5-0.6 sold opening winners in the backtest).
async function dumped(h, since) {
  const r = await api(`stock-market/stocks/${h.external_id}/trades?page=1&pageSize=20`);
  return (r.j?.data || []).some((t) => t.side === 'sell' && Date.parse(t.occurred_at) > since && (t.price_before_cents - t.price_after_cents) / t.price_before_cents >= DUMP_DROP);
}

// announce a trade in the contestant's Kick chat (on when KICK_BEARER is set); fire and forget, result logged
const say = (name, msg) => execFile('python', ['kick_say.py', name, msg], { timeout: 30e3 }, (err, out) => log({ ev: 'kick_say', name, out: String(out).trim(), err: err?.message?.slice(0, 120) }));

async function trade(side, h, payload, why) {
  const body = { stock_external_id: h.external_id, request_id: crypto.randomUUID(), ...payload };
  if (DRY) return log({ ev: 'dry', side, name: h.name, why, body });
  const r = await api(side, body);
  log({ ev: side, name: h.name, why, status: r.s, res: r.j });
  if (r.s === 200 && r.j?.shares) {
    const id = h.external_id;
    if (side.endsWith('buy')) state.shares[id] = String(BigInt(state.shares[id] || 0) + BigInt(r.j.shares));
    else delete state.shares[id];
  }
  if (r.s === 200 && process.env.KICK_BEARER) say(h.name, sayText(side, h.name, r.j?.cash_cents ?? 0, fs.readFileSync(LOG, 'utf8').split('\n')));
  return r;
}

async function guard() {
  const r = await api('stock-market/me');
  if (r.blocked) return;
  if (r.s === 401 || r.s === 403) {
    if (!authAlerted) { authAlerted = true; log({ ev: 'auth_lost', status: r.s }); notify('session expired: run `node engine.mjs --login` (or import-cookies.mjs), then restart'); }
    return;
  }
  let holdings;
  if (r.s === 200) { if (authAlerted) log({ ev: 'auth_ok' }); authAlerted = false; me = r.j; holdings = me.holdings; }
  else {
    // /me 500s ~4% of ticks while sells still go through: keep the stop alive on the last known
    // holdings priced from the public per-stock endpoint.
    log({ ev: 'me_err', status: r.s });
    if (!me) return;
    holdings = [];
    for (const h of me.holdings) {
      const q = await api(`stock-market/stocks/${h.external_id}`);
      if (q.s === 200) holdings.push({ ...h, last_price_cents: q.j.last_price_cents });
    }
  }
  for (const h of holdings) {
    const p = h.last_price_cents, id = h.external_id;
    // Manual positions (bought by the operator, not the engine): no time exit. 18/10 01:44 the dump exit sold a manual
    // all-in mid-dump and the operator wanted that kept, plus full management: dump/death/hp exits and the run-mode
    // 15% trail from the peak.
    if (!state.entryAt[id]) {
      state.manualPeak ||= {};
      const pk = state.manualPeak[id] = Math.max(state.manualPeak[id] || 0, p);
      const guardWhy = p < pk * RUN_TRAIL ? `manual trail ${p}<${Math.round(pk * RUN_TRAIL)}`
        : recentlyDied(h.name, Date.now() - 10 * 60e3) || hpOf(h.name)?.alive === false ? `manual died ${p}`
        : risky(h.name, HP_EXIT) ? `manual hp ${hpOf(h.name).hp}/${hpOf(h.name).max} ${p}`
        : eliminated[id] ? `manual eliminated ${p}`
        : P.dumpExit && p <= (lastPrice[id] ?? p) * (1 - DUMP_DROP) && await dumped(h, Date.now() - 60e3) ? `manual dump ${p}`
        : null;
      lastPrice[id] = p;
      if (guardWhy && (await trade('stock-market/sell', h, { shares: h.shares }, guardWhy))?.s === 200) {
        delete state.manualPeak[id];
        me.holdings = me.holdings.filter((x) => x.external_id !== id);
      }
      continue;
    }
    state.peak[id] = Math.max(state.peak[id] || 0, p);
    const kind = state.kind?.[id];
    const dip = kind === 'dip' || kind === 'surv'; // exit on time/death only: no trail or dump exit (the backtests held plain)
    // ...unless the rebound turned into a run (peak >= +10% over entry, 18/10: do not exit too early): then ride it
    // with a 15% trail from the peak instead of selling at 10 min, capped at RUN_HOLD.
    const run = dip && state.peak[id] >= entryPx(h) * RUN_START;
    const why = run && p < state.peak[id] * RUN_TRAIL ? `runtrail ${p}<${Math.round(state.peak[id] * RUN_TRAIL)}`
      : !dip && p < state.peak[id] * P.trail ? `trail ${p}<${Math.round(state.peak[id] * P.trail)}`
      : Date.now() - state.entryAt[id] > (run ? RUN_HOLD : kind === 'surv' ? SURV_HOLD : dip ? DIP_HOLD : P.maxHold || Infinity) ? `time ${p}`
      : status[id] && status[id] !== 'active' && status[id] !== 'paused' ? `status ${status[id]}`
      : recentlyDied(h.name, state.entryAt[id] - 60e3) || hpOf(h.name)?.alive === false ? `died ${p}`
      : risky(h.name, HP_EXIT) ? `hp ${hpOf(h.name).hp}/${hpOf(h.name).max} ${p}`
      : eliminated[id] ? `eliminated ${p}`
      // trades are only fetched when the price just fell >= DUMP_DROP vs the previous tick (keeps the call budget low)
      : !dip && P.dumpExit && lastBreadth !== null && lastBreadth < (P.dumpBreadth ?? 0) && p <= (lastPrice[id] ?? p) * (1 - DUMP_DROP)
        && await dumped(h, Math.max(state.entryAt[id], Date.now() - 60e3)) ? `dump ${p}`
      : null;
    lastPrice[id] = p;
    if (why) {
      // sell only the engine's own shares: the operator may hold the same stock on this account
      const own = state.shares[id] ? (BigInt(state.shares[id]) < BigInt(h.shares) ? state.shares[id] : h.shares) : h.shares;
      const t = await trade('stock-market/sell', h, { shares: own }, why);
      if (t?.s === 200) {
        delete state.peak[id]; delete state.entryAt[id]; delete state.kind[id]; state.exitedAt[id] = Date.now();
        me.holdings = me.holdings.filter((x) => x.external_id !== id); // cached copy must not re-sell it
      }
    }
  }
  save();
}

async function scan() {
  const now = Date.now(), stocks = [], since = now - Math.max(P.lookback, BREADTH_WINDOW), spark = {};
  for (let page = 1; page <= 3; page++) {
    const s = await api(`stock-market/stocks?page=${page}&pageSize=100&search=`);
    const k = await api(`stock-market/sparklines?bucket_ms=60000&since_ms=${since}&page=${page}&pageSize=100`);
    stocks.push(...(s.j?.stocks || []));
    for (const x of k.j?.sparklines || []) spark[x.external_id] = x.points;
    if ((s.j?.stocks || []).length < 100) break;
  }
  for (const s of stocks) { // merge: a failed page must not erase known statuses
    status[s.external_id] = s.status;
    // a dead contestant stays status 'active' with eliminated_at/settles_at set (settles 4 h later, value unknown
    // until the first settlement at 18/10 00:06 UTC): never hold one
    eliminated[s.external_id] = !!s.eliminated_at;
    if (s.last_trade_at) lastTradeAt[s.external_id] = Date.parse(s.last_trade_at);
  }
  // price at time x from 1-min sparkline buckets: first bucket starting at or after x
  const priceSince = (id, x) => (spark[id] || []).find((p) => p.t >= x - 60e3)?.price_cents;
  const prevScan = { ...lastScan };
  for (const s of stocks) lastScan[s.external_id] = { price: s.last_price_cents, t: now };
  for (const [id, p] of Object.entries(prevScan)) if (now - p.t > 2 * SCAN_EVERY) delete prevScan[id]; // missed scans: not "15 s ago"
  const active = stocks.filter((s) => s.status === 'active');
  // same definition as the backtest: traded stocks only; no bucket in the window = no move = current price
  // eliminated stocks never rise again: counting them dragged breadth down as deaths piled up (0.10 vs 0.16 at 21:52)
  const breadth = breadthOf(active.filter((s) => s.last_trade_at && !s.eliminated_at).map((s) => [s.last_price_cents, priceSince(s.external_id, now - BREADTH_WINDOW) ?? s.last_price_cents]));
  if (active.length) lastBreadth = breadth;
  log({ ev: 'scan', breadth: +breadth.toFixed(2), stocks: stocks.length });
  if (!me || !me.trading_enabled || me.holdings.length >= MAX_POS) return;
  const held = new Set(me.holdings.map((h) => h.external_id));
  const eligible = active
    .filter((s) => !held.has(s.external_id))
    .filter((s) => now - (state.exitedAt[s.external_id] || 0) > COOLDOWN_MS)
    .filter((s) => !diedAt[s.name.toLowerCase()] && !s.eliminated_at) // a grave = dead for good (18/10: all 87 graves are eliminated stocks)
    .filter((s) => !risky(s.name)); // low hp / outside the zone / dead in the health feed

  if (pendingDeath && now - pendingDeath >= SURV_DELAY) {
    pendingDeath = 0;
    // at most SURV_TOP survivor positions open at once: 3 deaths in 2 min opened 6 on 18/10 01:08-01:10
    const room = SURV_TOP - me.holdings.filter((h) => state.kind[h.external_id] === 'surv').length;
    if (room > 0 && trialOn('surv')) {
      const top = eligible.filter((s) => s.last_trade_at && now - Date.parse(s.last_trade_at) < 30 * 60e3)
        .sort((a, b) => b.last_price_cents - a.last_price_cents).slice(0, room);
      for (const s of top) {
        const cash = (await api('cx-bucks/balance')).j?.balance_cents ?? 0;
        const amt = Math.min(Math.floor(cash * P.size), sizeCap(s.last_price_cents));
        if (amt < MIN_BUY || amt > cash) break;
        const t = await trade('stock-market/buy', s, { cash_cents: amt }, `surv @${s.last_price_cents}`);
        if (t?.s === 200) { state.peak[s.external_id] = s.last_price_cents; state.entryAt[s.external_id] = Date.now(); state.kind[s.external_id] = 'surv'; save(); }
      }
      return;
    }
  }

  // crash rebound (replaced the -30%/5 min dip on 18/10: 8 live round trips -20.10, backtest 22:30-00:40 -2%).
  // A >= 25% drop between two scans with no pump before (< +10% over the 3 min before) is a whale exit, not a
  // dump: bought 3 s later, held 10 min, +11.5% (n=8, 20:22-22:30) and +9.3% (n=2, 22:30-00:40), fees and own impact
  // included. Thin sample: tried on purpose, cut automatically after 10 losing-in-total round trips.
  const dips = crashOn() ? eligible
    .map((s) => { const p = prevScan[s.external_id], p3 = priceSince(s.external_id, now - 3 * 60e3); return { s, ret: p && p3 && p.price / p3 - 1 < CRASH_FLAT ? s.last_price_cents / p.price - 1 : 0 }; })
    .filter((c) => c.ret <= -CRASH_DROP)
    .sort((a, b) => a.ret - b.ret) : [];
  if (dips.length) {
    const cash = (await api('cx-bucks/balance')).j?.balance_cents ?? 0;
    const { s, ret } = dips[0];
    const amt = Math.min(Math.floor(cash * P.size), sizeCap(s.last_price_cents));
    if (amt >= MIN_BUY && amt <= cash) {
      const t = await trade('stock-market/buy', s, { cash_cents: amt }, `crash ${(ret * 100).toFixed(0)}% @${s.last_price_cents}`);
      if (t?.s === 200) { state.peak[s.external_id] = s.last_price_cents; state.entryAt[s.external_id] = Date.now(); state.kind[s.external_id] = 'dip'; save(); }
      return;
    }
  }

  if (breadth < (P.minBreadth || 0)) return;
  const cash = (await api('cx-bucks/balance')).j?.balance_cents ?? 0;
  if (cash < MIN_BUY) return;
  const cands = eligible
    .map((s) => { const p0 = priceSince(s.external_id, now - P.lookback); return { s, ret: p0 ? s.last_price_cents / p0 - 1 : 0 }; })
    .filter((c) => c.ret >= P.entryMin && c.ret <= P.entryMax)
    .sort((a, b) => b.ret - a.ret);
  if (!cands.length) return;
  const { s, ret } = cands[0];
  const amt = Math.max(MIN_BUY, Math.floor(cash * P.size));
  if (amt > cash) return;
  const t = await trade('stock-market/buy', s, { cash_cents: amt }, `mom +${(ret * 100).toFixed(0)}% @${s.last_price_cents}`);
  if (t?.s === 200) { state.peak[s.external_id] = s.last_price_cents; state.entryAt[s.external_id] = Date.now(); }
}

// Tape recorder: every public trade of every stock, appended to data/tape-<UTC day>.jsonl (compact rows).
// Per-stock watermark = newest trade time already written; pages back until it is reached.
const mark = {};
for (const r of loadTape(Date.now() - 2 * 86400e3)) mark[r.e] = Math.max(mark[r.e] || 0, r.t);
// Only stocks that traded since their watermark, at most RECORD_PAGES pages each per run: a cold start
// costs at most RECORD_PAGES per stock. Pages are newest-first and the watermark jumps to the newest trade, so
// trades behind the page cap are skipped for good (counted as `capped`; 500 trades/stock/3 min is far above the pace).
const RECORD_PAGES = 5;
async function record() {
  let added = 0, failed = 0, capped = 0;
  const out = {};
  for (const id of Object.keys(status)) {
    const since = mark[id] || 0;
    if ((lastTradeAt[id] || 0) <= since) continue;
    let newest = since, page = 1;
    for (; page <= RECORD_PAGES; page++) {
      const r = await api(`stock-market/stocks/${id}/trades?page=${page}&pageSize=100`);
      if (r.s !== 200) { failed++; break; }
      const rows = (r.j.data || []).map(compact);
      const fresh = rows.filter((x) => x.t > since);
      for (const x of fresh) { (out[new Date(x.t).toISOString().slice(0, 10)] ||= []).push(JSON.stringify(x)); newest = Math.max(newest, x.t); added++; }
      if (fresh.length < rows.length || page * 100 >= r.j.total) break; // reached known trades or the end
    }
    if (page > RECORD_PAGES) capped++;
    mark[id] = newest;
  }
  fs.mkdirSync('data', { recursive: true });
  for (const [day, lines] of Object.entries(out)) fs.appendFileSync(`data/tape-${day}.jsonl`, lines.join('\n') + '\n');
  log({ ev: 'record', added, failed, capped });
}

// Walk-forward retune on the last TUNE_WINDOW of tape; adopts new params only past backtest.mjs guard rails.
async function retune() {
  const tape = loadTape(Date.now() - TUNE_WINDOW);
  if (tape.length < 500) return log({ ev: 'tune_skip', trades: tape.length });
  const { cur, best, adopt } = tune(tape, P);
  log({ ev: 'tune', trades: tape.length, cur, best: { ...best.r, P: best.P }, adopted: !!adopt });
  if (!adopt) return;
  P = { ...P, ...adopt }; // keep params the grid does not cover (dumpExit)
  fs.writeFileSync(PARAMS, JSON.stringify(P));
  notify(`new params ${JSON.stringify(P)} (6h backtest: ${cur.pnl} -> ${best.r.pnl})`);
}

async function daily() {
  if (!me) return;
  notify(`portfolio ${(me.portfolio_value_cents / 100).toFixed(2)}, realized PnL ${(me.realized_pnl_cents / 100).toFixed(2)}, unrealized ${(me.unrealized_pnl_cents / 100).toFixed(2)}`);
}

const loop = (fn, ms) => { let busy = false; setInterval(async () => { if (busy) return; busy = true; try { await fn(); } catch (e) { log({ ev: 'err', fn: fn.name, msg: e.message }); } finally { busy = false; } }, ms); };
setInterval(() => { if (Date.now() > END) { log({ ev: 'end' }); daily().finally(() => process.exit(0)); } }, 60e3);
log({ ev: 'start', dry: DRY, P });
await guard();
loop(guard, ME_EVERY);
loop(scan, SCAN_EVERY);
loop(readMap, 10e3);
loop(record, RECORD_EVERY);
loop(retune, TUNE_EVERY);
loop(daily, 24 * 3600e3);
