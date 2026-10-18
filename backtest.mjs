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
// at 32), u32 + f64, then columns slot u16[n], status u8[n], badges u8[n] (1 kick shield, 2 faith shield), flags u16[n]
// (1 alive, 2 poisoned, 4 drone incoming, 8 outside), hp u8[n], max u8[n]. Kind 1 (live positions) is never read.
// Later kind-2 frames are updates, applied in order.
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
      const bd = b[48 + n * 3 + i];
      if (u) out[u] = { hp: b[48 + n * 6 + i], max: b[48 + n * 7 + i], alive: (fl & 1) !== 0, out: (fl & 8) !== 0 || b[48 + n * 2 + i] === 3,
        poison: (fl & 2) !== 0, drone: (fl & 4) !== 0, shield: (bd & 1 ? 'kick' : '') + (bd & 2 ? 'faith' : '') };
    }
  }
  return out;
}

// Stream pages: the engine pushes the current one every 2 s and moves to the next every 20 s (94 columns x 22 lines,
// 15 px DejaVu Mono on the left of a 1280x720 frame, drawn by ffmpeg on the streaming box; stream/run.sh has the
// layout). Colors are inline marks, \x01 + one of g (gain, healthy),
// r (loss, danger, death), y (warning, shield), c (titles) and \x02 to close; layers() splits a page into one
// space-padded text per color so ffmpeg can stack them, one drawtext per color. d = { me, names, health, roster
// { name: { sigil, live } }, breadth, startedAt, now, kindOf(id) -> strategy ('' = opened by hand), deaths
// [{ u, t, source }] newest last, movers [{ name, ret }], ranking [{ name, price }] highest first, strategies
// { prefix: { n, win, pnl } }, trips [{ t, name, k, pnl }] closed round trips, basket [{ name, price, calm, ch5, held }]
// by calm price, pumps [{ t, name, ratio }] newest last, revived { name: t } }.
const col = (k, x) => `\x01${k}${x}\x02`, vis = (x) => x.replace(/\x01.|\x02/g, '');
export const LAYERS = ['w', 'g', 'r', 'y', 'c'];
export const START_CASH = 60746; // balance before the first order on 17/10 (45560 after a 15186 buy)
export function layers(text, anchor = 140) {
  const out = Object.fromEntries(LAYERS.map((k) => [k, '']));
  let cur = 'w';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\x01') { cur = text[++i]; continue; }
    if (ch === '\x02') { cur = 'w'; continue; }
    for (const k of LAYERS) out[k] += ch === '\n' ? '\n' : k === cur ? ch : ' ';
  }
  // ffmpeg 4.4 drawtext places lines from the glyphs a text contains, so layers with different glyphs drift ~10 px
  // apart: the same "|" at column `anchor` of the first line in every layer gives them all the same extent; past the
  // right edge of the frame (140 columns from the page, 50 from the bot log) it is measured but never seen.
  for (const k of LAYERS) { const [first, ...rest] = out[k].split('\n'); out[k] = [first.padEnd(anchor) + '|', ...rest].join('\n'); }
  return out;
}
// dead since `since`: a death after it, with no revive after that death (revives exist since 18/10)
export const deadAfter = (died = 0, revived = 0, since = 0) => died > since && revived < died;

export function streamPages(d) {
  const { me, names = {}, health = {}, roster = {}, revived = {}, breadth = 0, now = Date.now(), kindOf = () => '', deaths = [], movers = [], ranking = [], strategies = {},
    trips = [], basket = [], pumps = [], entryAt = {} } = d;
  const c = (x) => (x / 100).toFixed(2), s = (x) => (x >= 0 ? '+' : '') + c(x), pad = (x, n) => String(x).slice(0, n).padEnd(n);
  const gr = (v, x) => col(v >= 0 ? 'g' : 'r', x), hm = (t) => new Date(t).toISOString().slice(11, 16), pct = (r) => `${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%`;
  const age = (t) => { const m = Math.floor((now - t) / 60e3); return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`; };
  // every alive contestant gets a status line, 34 per page: 18/10 the page kept only the 34 weakest of 67 alive, so a
  // healthy one (FloridaBoy, 110/110) never showed. One STATUS page per 34, weakest first across them.
  const PER = 34, aliveN = Object.values(health).filter((h) => h.alive).length, statusN = Math.max(1, Math.ceil(aliveN / PER)), N = 5 + statusN;
  const two = (a, b) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => { const l = a[i] || ''; return (l + ' '.repeat(Math.max(0, 48 - vis(l).length)) + (b[i] || '')).trimEnd(); });
  // header: page k/N and title, a bar that fills until the next page (20 s), data time; then one line for viewers
  const fill = Math.floor((now % 20e3) / 2e3);
  const page = (i, title, sub, body) => [col('c', `${i}/${N}  ${title}`.padEnd(54)) + `next [${'='.repeat(fill)}${' '.repeat(10 - fill)}]   data ${new Date(now).toISOString().slice(11, 19)} UTC`,
    col('y', sub), '', ...body.slice(0, 19)].join('\n') + '\n';
  const hpCol = (h) => (h.hp < h.max * 0.35 ? 'r' : h.hp < h.max * 0.7 ? 'y' : 'g');
  const bar = (h) => col(hpCol(h), '#'.repeat(Math.round((10 * h.hp) / h.max))) + '-'.repeat(10 - Math.round((10 * h.hp) / h.max));
  const hpTxt = (n) => { const h = health[String(n).toLowerCase()]; return h ? col(h.alive ? hpCol(h) : 'r', (h.alive ? `${h.hp}/${h.max}` : 'dead').padStart(7)) : '      -'; };

  const pos = [col('c', 'POSITION          TYPE       COST     VALUE       P/L      %     HP   HELD')];
  for (const h of [...me.holdings].sort((a, b) => b.current_value_cents - a.current_value_cents).slice(0, 18)) {
    const pl = h.current_value_cents - h.cost_basis_cents, at = entryAt[h.external_id];
    pos.push(`${pad(h.name, 17)} ${pad(kindOf(h.external_id) || 'yours', 6)} ${c(h.cost_basis_cents).padStart(9)} ${c(h.current_value_cents).padStart(9)} ${gr(pl, s(pl).padStart(9))} ${gr(pl, pct(h.cost_basis_cents ? pl / h.cost_basis_cents : 0).padStart(7))} ${hpTxt(h.name)} ${(at ? age(at) : '-').padStart(6)}`);
  }
  const orders = [col('c', 'LAST ORDERS (UTC)')];
  for (const t of (me.trades || []).slice(0, 14)) orders.push(`${hm(t.occurred_at)}  ${col(t.side === 'buy' ? 'g' : 'r', pad(t.side, 4))}  ${pad(names[t.external_id] || '?', 16)} ${c(t.cash_cents).padStart(8)} Cx`);
  const strat = [col('c', 'STRATEGY   TRIPS   WON        PNL')];
  for (const [k, r] of Object.entries(strategies)) strat.push(`${pad(k, 10)} ${String(r.n).padStart(5)} ${String(r.win).padStart(5)} ${gr(r.pnl, s(r.pnl).padStart(10))}`);
  const byPnl = [...trips].sort((a, b) => b.pnl - a.pnl), trip = (x) => `${hm(x.t)}  ${pad(x.name, 16)} ${pad(x.k, 5)} ${gr(x.pnl, s(x.pnl).padStart(9))}`;
  if (trips.length) strat.push('', col('c', 'BEST TRADES'), ...byPnl.slice(0, 4).filter((x) => x.pnl > 0).map(trip), '', col('c', 'WORST TRADES'), ...byPnl.slice(-4).reverse().filter((x) => x.pnl < 0).map(trip));
  const mv = [...movers].sort((a, b) => b.ret - a.ret), rows = (v) => v.map((m) => `${pad(m.name, 20)} ${gr(m.ret, pct(m.ret).padStart(8))}`);
  const market = [col('c', `RISING 5 MIN (${Math.round(breadth * 100)} pct of the market)`), ...rows(mv.filter((m) => m.ret > 0).slice(0, 8)), '', col('c', 'FALLING 5 MIN'), ...rows([...mv].reverse().filter((m) => m.ret < 0).slice(0, 8))];
  const rank = [col('c', 'MOST EXPENSIVE        PRICE'), ...ranking.slice(0, 18).map((r, i) => `${String(i + 1).padStart(2)}. ${pad(r.name, 17)} ${c(r.price).padStart(7)}`)];
  // top basket tracker: the ranking the bot buys from (calm price), what it holds, and the pumps it refused
  const bk = [col('c', ' #  BASKET RANK      CALM     NOW   5 MIN')];
  basket.slice(0, 18).forEach((x, i) => bk.push(`${String(i + 1).padStart(2)}  ${pad(x.name, 14)} ${c(x.calm).padStart(7)} ${c(x.price).padStart(7)} ${x.ch5 == null ? '      -' : gr(x.ch5, pct(x.ch5).padStart(7))} ${x.held ? col('g', 'HELD') : i < 10 ? col('y', 'NEXT') : ''}`));
  if (bk.length === 1) bk.push('no ranking yet');
  const pw = [col('c', 'PUMPS IGNORED (UTC)       PUMP'), ...pumps.slice(-14).reverse().map((x) => `${hm(x.t)}  ${pad(x.name, 16)} ${col('y', `x${x.ratio.toFixed(1)}`.padStart(6))}`)];
  if (pw.length === 1) pw.push(col('g', 'none so far'));
  pw.push('', col('c', 'A pump: price far above its own'), col('c', '5 min low. The bot ranks on that'), col('c', 'low, so a pump never gets in.'));
  const danger = [col('c', 'IN DANGER (hp < 35% or out)      HP')];
  for (const [u, h] of Object.entries(health).filter(([, h]) => h.alive && (h.out || h.hp < h.max * 0.35)).sort((a, b) => a[1].hp / a[1].max - b[1].hp / b[1].max).slice(0, 18))
    danger.push(`${pad(u, 26)} ${col('r', `${h.hp}/${h.max}`.padStart(7))}${h.out ? col('r', '  out') : ''}`);
  if (danger.length === 1) danger.push(col('g', 'nobody'));
  const dead = [col('c', 'DEATHS AND REVIVES (UTC)')];
  for (const x of deaths.slice(-18).reverse()) dead.push(`${hm(x.t)}  ${pad(x.u, 22)} ${x.revive ? col('g', 'REVIVED') : col('r', pad(x.source || x.cause || '', 14))}`);
  // status: the alive contestants, weakest first, two per line: hp bar, sigil (class), shield, poison, drone, out, live
  const st = Object.entries(health).filter(([, h]) => h.alive).sort((a, b) => a[1].hp / a[1].max - b[1].hp / b[1].max || a[0].localeCompare(b[0])).map(([u, h]) => {
    const r = roster[u] || {}, flag = (on, k, ch) => (on ? col(k, ch) : '.');
    return `${pad(u, 13)} ${bar(h)} ${String(h.hp).padStart(3)} ${pad(r.sigil || '-', 10)} ${flag(h.shield, 'y', 'S')}${flag(h.poison, 'r', 'P')}${flag(h.drone, 'r', 'D')}${flag(h.out, 'r', 'O')}${flag(r.live, 'g', 'L')}${flag(revived[u], 'g', 'R')}`;
  });
  const head = col('c', 'NAME          HP BAR      HP SIGIL      SPDOLR');
  const legend = col('c', 'S') + ' shield  ' + col('c', 'P') + ' poisoned  ' + col('c', 'D') + ' drone incoming  ' + col('c', 'O') + ' outside the zone  ' + col('c', 'L') + ' live  ' + col('c', 'R') + ' revived';
  const status = Array.from({ length: statusN }, (_, k) => {
    const part = st.slice(k * PER, (k + 1) * PER);
    return page(6 + k, `STATUS${statusN > 1 ? ` ${k + 1}/${statusN}` : ''} (${aliveN} alive)`, 'Every contestant still in the game, weakest first: HP, class and what is happening to them',
      [...two([head, ...part.slice(0, 17)], [head, ...part.slice(17)]), legend]);
  });
  return [page(1, 'PORTFOLIO', 'What the bot holds right now, biggest first (type = strategy that bought it)', pos),
    page(2, 'ACTIVITY', 'Every order it placed, and what each strategy made once sold', two(orders, strat)),
    page(3, 'MARKET', 'Who moves in the last 5 minutes, and the most expensive stocks', two(market, rank)),
    page(4, 'TOP BASKET TRACKER', 'The bot holds the 10 priciest live stocks, ranked on a calm price', two(bk, pw)),
    page(5, 'CONTESTANTS', 'A death knocks the stock about 20% down: the bot sells first', two(danger, dead)), ...status];
}

// Right panel of the stream. Total value over `span` as block characters, w columns x h rows (the last value of each
// column's time slice, carried over gaps); null with under 2 points. ASCII-free on purpose: one color, one drawtext.
export function equityChart(points, now, w = 44, h = 6, span = 24 * 3600e3) {
  const v = points.filter((p) => p.value != null && p.t > now - span && p.t <= now);
  if (v.length < 2) return null;
  const cols = []; let k = 0, last = null;
  for (let i = 0; i < w; i++) { const end = now - span + ((i + 1) * span) / w; while (k < v.length && v[k].t <= end) last = v[k++].value; cols.push(last); }
  const vals = cols.filter((x) => x != null), lo = Math.min(...vals), hi = Math.max(...vals), lev = h * 8;
  const q = cols.map((x) => (x == null ? -1 : hi === lo ? lev / 2 : Math.round(((x - lo) / (hi - lo)) * (lev - 1)) + 1));
  const B = ' ▁▂▃▄▅▆▇█', rows = [];
  for (let r = h - 1; r >= 0; r--) rows.push(q.map((n) => (n < 0 ? ' ' : B[Math.max(0, Math.min(8, n - r * 8))])).join(''));
  return { rows, lo, hi, first: vals[0], last: vals.at(-1) };
}
// The CX mascot, in a Houston cowboy hat. Mood from the total value 15 min ago: happy (up 0.5%+), sad (down 0.5%+),
// cool otherwise. Four poses each, cycled 4 times a second by run.sh.
const HAT = ['     .-^-.', '  __/_____\\__'];
const POSES = {
  happy: [['\\  (8^_^8)  /', ' \\_| CX |_/', '   |____|', '   /    \\', '  /      \\'], ['   (8^o^8)', ' __| CX |__/', '   |____|', '   /    \\', '  |      \\'],
    ['   (8^_^8)', '  /| CX |\\', ' / |____| \\', '   /    \\', '  /      |'], ['\\__(8^_^8)', '   | CX |__', '   |____|  \\', '   /    \\', '  /      |']],
  cool: [['\\  (8-_-8)  /', ' \\_| CX |_/', '   |____|', '   /    \\', '  /      \\'], ['   (8-_-8)', ' __| CX |__/', '   |____|', '   /    \\', '  |      \\'],
    ['   (8-_-8)', '  /| CX |\\', ' / |____| \\', '   /    \\', '  /      |'], ['   (8-_-8)', '\\__| CX |__', '   |____|', '   /    \\', '  /      |']],
  sad: [["   (8;_;8) '", '   | CX |', '  /|____|\\', '   /    \\', '  |      |'], ['   (8T_T8)', '   | CX |', '  /|____|\\', '   /    \\', '  |      |'],
    ["   (8;_;8)  '", '   | CX |', '  /|____|\\', '   /    \\', '  |      |'], ['   (8T_T8) ,', '   | CX |', '  /|____|\\', '   /    \\', '  |      |']],
};
export const moodOf = (points, now) => {
  const v = points.filter((p) => p.value != null && p.t <= now), last = v.at(-1), then = v.findLast((p) => p.t <= now - 15 * 60e3);
  if (!last || !then) return 'cool';
  const r = last.value / then.value - 1;
  return r >= 0.005 ? 'happy' : r <= -0.005 ? 'sad' : 'cool';
};
export const mascot = (mood) => POSES[mood].map((p) => [...HAT, ...p.map((x) => ' ' + x)].join('\n') + '\n');
// What the mascot says: the bot's last move within 2 min, else a line for its mood. Two lines of at most w chars.
export function bubble(text, w = 22) {
  const words = String(text).split(' '), l = [''];
  for (const x of words) { if ((l.at(-1) + ' ' + x).trim().length > w && l.at(-1)) l.push(''); l[l.length - 1] = (l.at(-1) + ' ' + x).trim().slice(0, w); }
  const L = l.slice(0, 2).map((x) => x.padEnd(w));
  return [` .${'-'.repeat(w + 1)}.`, ...L.map((x, i) => `${i === 0 ? '<' : '|'} ${x} |`), ` '${'-'.repeat(w + 1)}'`].join('\n') + '\n';
}
// Bot log for the right panel, newest first, at most 42 columns: own orders (sells with their net PnL), deaths,
// revives and refused pumps. orders [{ t, side, name, cash, pnl? }].
export function botLog(orders, deaths, pumps, n = 6) {
  const hm = (t) => new Date(t).toISOString().slice(11, 16), pad = (x, k) => String(x).slice(0, k).padEnd(k), c = (x) => (x / 100).toFixed(2);
  const ev = [...orders.map((o) => ({ t: o.t, l: o.side === 'buy' ? `${hm(o.t)} BUY  ${pad(o.name, 16)} ${c(o.cash).padStart(8)}`
      : `${hm(o.t)} ${col(o.pnl == null || o.pnl >= 0 ? 'g' : 'r', `SELL ${pad(o.name, 16)} ${o.pnl == null ? c(o.cash).padStart(8) : ((o.pnl >= 0 ? '+' : '') + c(o.pnl)).padStart(8)}`)}` })),
    ...deaths.map((x) => ({ t: x.t, l: `${hm(x.t)} ${x.revive ? col('g', `BACK ${pad(x.u, 16)}  revived`) : col('r', `RIP  ${pad(x.u, 16)} ${pad(x.source || x.cause || '', 8)}`)}` })),
    ...pumps.map((x) => ({ t: x.t, l: `${hm(x.t)} ${col('y', `SKIP ${pad(x.name, 16)} pump x${x.ratio.toFixed(1)}`)}` }))];
  return ev.sort((a, b) => b.t - a.t).slice(0, n).map((x) => x.l).join('\n') + '\n';
}
// Own orders and closed round trips from trades.jsonl lines (buy reason prefix = strategy), for the log and the pages.
export function ownOrders(lines) {
  const out = [], trips = [], open = {};
  for (const l of lines) {
    if (!l.includes('"status":200') || !/"ev":"stock-market\/(buy|sell)"/.test(l)) continue;
    const e = JSON.parse(l), t = Date.parse(e.t), cash = e.res?.cash_cents ?? 0;
    if (e.ev.endsWith('buy')) { open[e.name] = { cash, k: String(e.why).split(' ')[0] }; out.push({ t, side: 'buy', name: e.name, cash }); continue; }
    const b = open[e.name], pnl = b ? cash - b.cash : null;
    out.push({ t, side: 'sell', name: e.name, cash, pnl });
    if (b) { trips.push({ t, name: e.name, k: b.k, pnl }); delete open[e.name]; }
  }
  return { orders: out, trips };
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
function lastAt(p, t) { // time of the last trade at or before t (0: none)
  let lo = 0, hi = p.ts.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (p.ts[m] <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  return k < 0 ? 0 : p.ts[k];
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
// Top basket as traded: one buy per scan (every `step`) of the first not-held stock of the topN by calm price, sold at
// rank topExit every topReb or at the death knock; min(topSize x cash, 1.5% of the reserve) each. Calm price =
// min(now, topCalm/2 ago, topCalm ago): 18/10 a pump took a 22 Cx stock to 227 for 30 s, the basket bought it at the
// top and it was back at 22 (-84 Cx). From 866 Cx; Cx PnL of the window and of each half.
export const calmPrice = (now, half, full) => Math.min(now, half ?? 0, full ?? 0);
export function simulateTop({ paths, t0, t1 }, Q, step = 60e3) {
  const { topN, topExit, topReb, topSize = 0.15, topCalm = 0 } = Q, imp = (p, c) => c / (R0 * Math.sqrt(p / 1000));
  const run = (from, to) => {
    let cash = 86580, n = 0, reb = -Infinity; const pos = {};
    const sell = (id, px) => { const v = pos[id] * px; cash += v * (1 - FEE) * (1 - imp(px, v)); delete pos[id]; };
    for (let t = from; t <= to && topN > 0; t += step) {
      for (const id of Object.keys(pos)) if (paths[id].deathAt <= t) sell(id, priceAt(paths[id], t));
      const ranked = Object.entries(paths).filter(([, p]) => !(p.deathAt <= t) && lastAt(p, t) > t - 30 * 60e3)
        .map(([id, p]) => { const now = priceAt(p, t); return { id, now, calm: topCalm ? calmPrice(now, priceAt(p, t - topCalm / 2), priceAt(p, t - topCalm)) : now }; }).sort((a, b) => b.now - a.now);
      const rank = new Map(ranked.map((x, i) => [x.id, i]));
      if (t - reb >= topReb) { reb = t; for (const id of Object.keys(pos)) if (!(rank.get(id) < topExit)) sell(id, priceAt(paths[id], t)); }
      const x = ranked.toSorted((a, b) => b.calm - a.calm).slice(0, topN).find((y) => !pos[y.id]);
      if (!x) continue;
      const c = Math.min(cash * topSize, R0 * Math.sqrt(x.now / 1000) * 0.015);
      if (c >= 1000) { cash -= c; n++; pos[x.id] = c * (1 - FEE) * (1 - imp(x.now, c)) / x.now; }
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
