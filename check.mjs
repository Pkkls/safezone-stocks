// Self-check of the pure helpers (backtest.mjs, import-cookies.mjs): node check.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import { prepare, compact, sayText, decodeHealth, simulateCrash, tuneCrash, simulateSurv, tuneSurv, trialTally, stuck, simulateTop, tuneTop, calmPrice, deadAfter, streamPages, streamTicker, layers, roundTrips, equityChart, moodOf, mascot, bubble, botLog, ownOrders } from './backtest.mjs';
import { sortCookies, setEnv } from './import-cookies.mjs';

assert.deepStrictEqual(compact({ external_id: 'x', occurred_at: '2026-10-17T20:00:00.000Z', price_before_cents: 1, price_after_cents: 2, user_id: 'u1', side: 'buy', cash_cents: 500 }), { e: 'x', t: Date.parse('2026-10-17T20:00:00.000Z'), pb: 1, pa: 2, u: 'u1', s: 'b', c: 500 });
// Kick line: pnl is taken from the LAST successful buy of that name (11775 -> 14840 on 18/10)
{
  const buy = (n, c, s = 200) => JSON.stringify({ ev: 'stock-market/buy', name: n, status: s, res: { cash_cents: c } });
  const lines = [buy('Alpha', 5000), buy('Other', 9999), buy('Alpha', 11775), buy('Alpha', 1, 500)];
  assert.strictEqual(sayText('stock-market/sell', 'Alpha', 14840, lines), 'SafeZone stocks sold Alpha for 148.40 Cx net profit 30.65 Cx 26.0%');
  assert.strictEqual(sayText('stock-market/sell', 'Other', 8734, lines), 'SafeZone stocks sold Other for 87.34 Cx net loss 12.65 Cx 12.7%');
  assert.strictEqual(sayText('stock-market/sell', 'Nobody', 100, lines), 'SafeZone stocks sold Nobody for 1.00 Cx');
  assert.strictEqual(sayText('stock-market/buy', 'Alpha', 10865, lines), 'SafeZone stocks bought Alpha for 108.65 Cx');
}
// health decode: a full frame then a sparse update for one slot; a kind-1 (positions) frame must be ignored
{
  const frame = (kind, recs) => {
    const n = recs.length, b = Buffer.alloc(48 + n * 28), v = new DataView(b.buffer);
    v.setUint8(0, kind); v.setUint16(32, n, true);
    recs.forEach(([slot, status, flags, hp, max, badges = 0], i) => { v.setUint16(48 + i * 2, slot, true); v.setUint8(48 + n * 2 + i, status); v.setUint8(48 + n * 3 + i, badges); v.setUint16(48 + n * 4 + i * 2, flags, true); v.setUint8(48 + n * 6 + i, hp); v.setUint8(48 + n * 7 + i, max); });
    return { binary: b.toString('base64') };
  };
  const text = { text: JSON.stringify({ type: 'contestants', data: { slots: { slots: [{ slot: 0, username: 'Aa' }, { slot: 1, username: 'Bb' }, { slot: 2, username: 'Cc' }] } } }) };
  const h = decodeHealth([text, frame(2, [[0, 2, 1, 90, 100], [1, 3, 9, 50, 110], [2, 2, 1 | 2 | 4, 70, 100, 1]]), frame(2, [[0, 2, 0, 0, 100]]), frame(1, [[1, 2, 1, 7, 100]])]);
  const base = { poison: false, drone: false, shield: '' };
  assert.deepStrictEqual(h, { aa: { hp: 0, max: 100, alive: false, out: false, ...base }, bb: { hp: 50, max: 110, alive: true, out: true, ...base },
    cc: { hp: 70, max: 100, alive: true, out: false, poison: true, drone: true, shield: 'kick' } }, 'health decode, with shield, poison and drone');
  assert.deepStrictEqual(decodeHealth([frame(2, [[0, 2, 1, 90, 100]])]), {}, 'control: no contestants frame, no names');
}
// cookie import: keep only kick session_token (URL-decoded) and the site's token cookies; fake values only
{
  const list = [
    { domain: '.kick.com', name: '__cf_bm', value: 'x' },
    { domain: '.kick.com', name: 'session_token', value: '123%7Cabc' },
    { domain: 'kick.com', name: 'KP_UIDz', value: 'y' },
    { domain: '.example.com', name: 'token', value: 't1', expirationDate: 1800000000.5, sameSite: 'no_restriction', secure: true },
    { domain: '.example.com', name: 'analytics', value: 'z' },
  ];
  const r = sortCookies(list, 'example.com');
  assert.strictEqual(r.kickBearer, '123|abc');
  assert.deepStrictEqual(r.ice, [{ name: 'token', value: 't1', domain: '.example.com', path: '/', expires: 1800000000, httpOnly: false, secure: true, sameSite: 'None' }]);
  assert.strictEqual(r.dropped, 3);
  assert.strictEqual(sortCookies(list).ice.length, 0, 'control: no SITE_HOST, no site cookie kept');
  assert.strictEqual(setEnv('A=1\nKICK_BEARER=old\n', 'KICK_BEARER', 'new'), 'A=1\nKICK_BEARER=new\n');
  assert.throws(() => sortCookies({}), /JSON array/);
}
// crash simulator: a flat stock crashing -40% in one trade then rebounding is one winning trade; the same tape
// without the crash trades nothing; the tuner never adopts from a single trade
{
  const t = 1e12, row = (dt, pb, pa) => ({ e: 'x', t: t + dt, pb, pa, s: pa < pb ? 's' : 'b' });
  const flat = [row(0, 1000, 1000), row(200e3, 1000, 1000)];
  // 600 -> 1000 starts run mode, 840 < 1000 * 0.85 closes it: entry 600, exit 840
  const crashTape = [...flat, row(210e3, 1000, 600), row(400e3, 600, 1000), row(1000e3, 1000, 840), row(2000e3, 840, 840)];
  const Q = { crashDrop: 0.25, crashFlat: 0.1, dipHold: 600e3, runStart: 1.1, runTrail: 0.85 };
  const r = simulateCrash(prepare(crashTape), Q);
  assert.strictEqual(r.n, 1, 'crash not traded');
  assert.ok(Math.abs(r.total - 0.3262) < 0.001, 'entry 600, run-mode exit at 840 (not at the 1000 peak): ' + r.total);
  assert.strictEqual(simulateCrash(prepare([...flat, row(210e3, 1000, 1000), row(2000e3, 1000, 1000)]), Q).n, 0, 'control: no crash, no trade');
  assert.strictEqual(tuneCrash(crashTape, Q).adopt, null, 'one trade must never be enough to adopt');
}
// survivors: after a death the highest-priced live stock is bought (never the dead one), held survHold;
// the tuner switches the strategy off when it loses and no setting wins in both halves
{
  const t = 1e12, row = (e, dt, pb, pa) => ({ e, t: t + dt, pb, pa, s: 'b' });
  const tape = [];
  for (let k = 0; k <= 200; k++) tape.push(row('top', k * 30e3, 2000, 2000 - k * 5), row('low', k * 30e3, 1000, 1000), row('dead', k * 30e3, 3000 + k * 20, 3000 + k * 20)); // rising: buying it would win
  tape.sort((a, b) => a.t - b.t);
  const Q = { survTop: 1, survHold: 10 * 60e3, runStart: 1.2, runTrail: 0.8 };
  const deaths = [{ u: 'deadname', t: t + 40 * 60e3 }];
  const r = simulateSurv(prepare(tape), Q, deaths, { dead: 'deadname' });
  assert.strictEqual(r.n, 1, 'one death, one survivor buy');
  assert.ok(r.total < 0, 'bought "top" (falling), not the dead stock');
  assert.strictEqual(simulateSurv(prepare(tape), { ...Q, survTop: 0 }, deaths).n, 0, 'control: survTop 0 trades nothing');
  const many = Array.from({ length: 10 }, (_, i) => ({ u: 'deadname', t: t + (35 + i * 5) * 60e3 }));
  assert.deepStrictEqual(tuneSurv(tape, { ...Q, survTop: 2, survHold: 600e3 }, many, { dead: 'deadname' }).adopt, { survTop: 0 }, 'losing strategy must be switched off');
}
// kill switch: round trips are counted from the last re-arm marker only
{
  const tr = (side, name, why, c) => JSON.stringify({ ev: `stock-market/${side}`, name, why, status: 200, res: { cash_cents: c } });
  const lines = [tr('buy', 'A', 'crash -30%', 1000), tr('sell', 'A', 'time', 500), tr('buy', 'B', 'mom +20%', 1000), tr('sell', 'B', 'time', 3000)];
  assert.deepStrictEqual(trialTally(lines, 'crash'), { n: 1, pnl: -500 }, 'tally counts only the crash round trip');
  const rearmed = [...lines, JSON.stringify({ ev: 'crash_on' }), tr('buy', 'C', 'crash -40%', 1000), tr('sell', 'C', 'time', 1200)];
  assert.deepStrictEqual(trialTally(rearmed, 'crash'), { n: 1, pnl: 200 }, 'control: trips before crash_on must be forgotten');
}
// top basket: holds the highest-priced live stock; a rise wins, a fall loses, a death knock is sold and never rebought
{
  const t = 1e12, row = (e, dt, pb, pa) => ({ e, t: t + dt, pb, pa, s: 'b' });
  const mk = (f) => { const v = []; for (let k = 0; k <= 400; k++) v.push(row('a', k * 30e3, f(k), f(k)), row('b', k * 30e3 + 1, 1000, 1000)); return v; };
  const Q = { topN: 1, topExit: 1, topReb: 15 * 60e3, topSize: 0.15 };
  const up = simulateTop(prepare(mk((k) => 2000 + k * 5)), Q);
  assert.ok(up.n === 1 && up.total > 0, 'rising top stock: one buy, a win');
  assert.ok(simulateTop(prepare(mk((k) => 2000 - k * 2)), Q).total < 0, 'control: falling top stock loses');
  assert.strictEqual(simulateTop(prepare(mk((k) => 2000 + k * 5)), { ...Q, topN: 0 }).n, 0, 'control: topN 0 trades nothing');
  // death knock: a -20% gap after 5 min without trades; the basket sells and then buys 'b', never 'a' again
  const dead = mk((k) => 2000).filter((r) => r.e !== 'a' || r.t < t + 200 * 30e3 || r.t >= t + 210 * 30e3).map((r) => r.e === 'a' && r.t >= t + 210 * 30e3 ? { ...r, pb: 1600, pa: 1600 } : r);
  const r = simulateTop(prepare(dead), Q);
  assert.strictEqual(r.n, 2, 'after the death knock: sold a, bought b, a never again');
  assert.ok(r.total < 0, 'the death knock costs about 20% of the position');
  assert.deepStrictEqual(tuneTop(mk((k) => 2000 + k * 5), Q).adopt, null, 'one buy must never be enough to adopt');
  // 30 s pump (18/10: 22 -> 227 -> 22 Cx): with topCalm the pumped stock never ranks; control: without it, bought at the top, a loss
  const pump = []; for (let k = 0; k <= 400; k++) pump.push(row('a', k * 30e3, 2000, 2000), row('p', k * 30e3 + 1, k === 200 || k === 201 ? 20000 : 500, k === 200 || k === 201 ? 20000 : 500));
  const calm = simulateTop(prepare(pump), { ...Q, topCalm: 5 * 60e3 }), raw = simulateTop(prepare(pump), Q);
  assert.strictEqual(calm.n, 1, 'calm: only the steady leader is bought');
  assert.ok(raw.n === 2 && raw.total < calm.total - 10, 'control: without topCalm the pump is bought and loses');
  assert.strictEqual(calmPrice(22700, 2200, 2200), 2200, 'calm price = the lowest of the three');
}
// watchdog: stale after 5 min without success, never during an API block; lost after 3 min of 401
{
  const t = 1e12, m = 60e3;
  assert.deepStrictEqual(stuck(t + 6 * m, t, 0, 0), { stale: true, lost: false }, 'stale not detected');
  assert.deepStrictEqual(stuck(t + 6 * m, t, t + 5 * m, 0), { stale: false, lost: false }, 'control: a block is not a hang');
  assert.deepStrictEqual(stuck(t + 4 * m, t + 4 * m, 0, t), { stale: false, lost: true }, 'lost session not detected');
  assert.deepStrictEqual(stuck(t + 2 * m, t + 2 * m, 0, t), { stale: false, lost: false }, 'control: 2 min of 401 is tolerated');
}
// stream pages: 6 pages of at most 94 x 22, color layers on one grid, each with its content; positions sorted by value, yours labelled
{
  const me = { realized_pnl_cents: 50580, unrealized_pnl_cents: -120, holdings: [
    { external_id: 'a', name: 'Small', cost_basis_cents: 1000, current_value_cents: 900 },
    { external_id: 'b', name: 'Big', cost_basis_cents: 2000, current_value_cents: 2500 }],
    trades: [{ occurred_at: '2026-10-18T04:29:15Z', side: 'buy', external_id: 'b', cash_cents: 2000 }] };
  const raw = streamPages({ me, names: { b: 'Big' }, health: { x: { alive: true, hp: 20, max: 100, out: false }, y: { alive: false, hp: 0, max: 100 }, z: { alive: true, hp: 90, max: 100, out: false, shield: 'kick' } },
    roster: { z: { sigil: 'healing', live: true } },
    breadth: 0.13, startedAt: 0, now: 3 * 3600e3 + 5 * 60e3, kindOf: (id) => (id === 'b' ? 'crash' : ''),
    deaths: [{ u: 'old', t: 1e12, cause: 'damage', source: 'zone' }, { u: 'newest', t: 2e12, cause: 'damage', source: 'knife' }],
    movers: [{ name: 'Up', ret: 0.2 }, { name: 'Down', ret: -0.1 }], ranking: [{ name: 'Top', price: 9000 }, { name: 'Next', price: 5000 }],
    strategies: { top: { n: 3, win: 2, pnl: 1500 } } });
  const Lay = raw.map(layers), plain = raw.map((p) => p.replace(/\x01.|\x02/g, '')), P = plain; // plain: what a viewer reads
  assert.strictEqual(raw.length, 6);
  for (const p of plain) { const l = p.trimEnd().split('\n'); assert.ok(l.length <= 22 && l.every((x) => x.length <= 94), 'page fits 94 x 22: ' + l[0]); }
  for (const [i, L] of Lay.entries()) for (const k of ['g', 'r', 'y', 'c']) assert.deepStrictEqual(L[k].split('\n').map((x) => x.length), L.w.split('\n').map((x) => x.length), `layer ${k} of page ${i + 1} on the same grid`);
  assert.match(Lay[0].g, /\n {49}\+5\.00 +\+25\.0%/, 'a gain is drawn in green, at its column');
  assert.match(Lay[0].r, /\n {49}-1\.00 +-10\.0%/, 'a loss is drawn in red');
  assert.doesNotMatch(Lay[0].g, /-1\.00/, 'control: a loss is never green');
  assert.match(plain[5], /6\/6 {2}STATUS[\s\S]*\nx +##-{8} +20 - +\.\.\.\.\.[\s\S]*\nz +#{9}- +90 healing +S\.\.\.L/, 'status: weakest first, hp bar, sigil, shield and live flags');
  assert.match(Lay[5].y, /\n {40}S/, 'a shield is drawn in yellow');
  // 70 alive: every one is on exactly one STATUS page (34 per page), the healthiest included (18/10: FloridaBoy, 110/110,
  // was cut by the 34-weakest page); the page counter follows
  {
    const many = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`p${String(i).padStart(2, '0')}`, { alive: true, hp: i + 1, max: 110, out: false }]));
    const pg = streamPages({ me, health: { ...many, gone: { alive: false, hp: 0, max: 100 } } }).map((p) => p.replace(/\x01.|\x02/g, ''));
    assert.strictEqual(pg.length, 8, '5 pages + 3 STATUS pages for 70 alive');
    assert.match(pg[7], /^8\/8 {2}STATUS 3\/3 \(70 alive\)/, 'status pages numbered');
    for (const n of Object.keys(many)) assert.strictEqual(pg.slice(5).filter((p) => new RegExp(`\\n${n} `).test(p) || new RegExp(` ${n} `).test(p)).length, 1, `${n} on exactly one status page`);
    assert.match(pg[7], /p69 +#{6}-{4} +70/, 'the healthiest (70/110) is on the last status page');
    assert.ok(!pg.slice(5).some((p) => /gone/.test(p)), 'control: a dead contestant is on no status page');
    for (const p of pg) { const l = p.trimEnd().split('\n'); assert.ok(l.length <= 22 && l.every((x) => x.length <= 94), 'status page fits 94 x 22'); }
  }
  assert.match(plain[0], /^1\/6 {2}PORTFOLIO +next \[ {10}\] +data 03:05:00 UTC\nWhat the bot holds/, 'header: page, next-page bar, data time, then a line for viewers');
  assert.match(P[0], /\nBig +crash +20\.00 +25\.00 +\+5\.00 +\+25\.0% +- +-\nSmall +yours/, 'highest value first; control: a position the engine did not open is yours');
  assert.match(P[1], /04:29 {2}buy {3}Big[\s\S]*top +3 +2 +\+15\.00/, 'orders and strategy PnL');
  assert.match(P[2], /RISING[^\n]*\nUp +\+20\.0%[^\n]*\n[^\n]*\nFALLING 5 MIN\nDown +-10\.0%/, 'control: a fall is never listed as rising');
  assert.match(P[2], /1\. Top +90\.00/);
  assert.match(P[4], /IN DANGER[^\n]*\nx +20\/100[^\n]*newest +knife/, 'low hp listed (z at 90 hp is not), deaths newest first with their source');
  assert.doesNotMatch(P[4], /\nz /, 'control: a healthy contestant is not in danger');
  // revives (18/10): a revived contestant is alive again, and buyable; a death after the revive counts again
  {
    assert.ok(deadAfter(100) && !deadAfter(100, 200) && deadAfter(300, 200) && !deadAfter(undefined, 200), 'dead until revived, dead again after a new death');
    assert.ok(!deadAfter(100, 0, 150) && deadAfter(300, 200, 150), 'since: only a death after it');
    const old = (died = 0, revived = 0, since = 0) => died > since;
    assert.ok(old(100, 200) && !deadAfter(100, 200), 'control: the old rule (died > since) kept a revived contestant dead');
    const rv = streamPages({ me, health: { back: { alive: true, hp: 45, max: 100, out: false } }, revived: { back: 2e12 },
      deaths: [{ u: 'back', t: 1e12, cause: 'damage', source: 'zone' }, { u: 'back', t: 2e12, revive: true }] });
    const rp = rv.map((p) => p.replace(/\x01.|\x02/g, '')), rl = rv.map(layers);
    assert.match(rp[4], /DEATHS AND REVIVES[^\n]*\n[^\n]*back +REVIVED[^\n]*\n[^\n]*back +zone/, 'a revive is listed with the deaths, newest first');
    assert.match(rl[4].g, /REVIVED/, 'a revive is drawn in green');
    assert.match(rp[5], /\nback +[#-]{10} +45 - +\.\.\.\.\.R/, 'status: R flag on a revived contestant');
    assert.doesNotMatch(plain[5], /^[xz] .*R$/m, 'control: no R flag without a revive');
  }
  // top basket tracker: rank by calm price, held / next marks, refused pumps with their ratio
  {
    const bp = streamPages({ me, basket: [{ name: 'Calm', price: 9000, calm: 8800, ch5: 0.02, held: true }, { name: 'Fresh', price: 5000, calm: 5000, ch5: null, held: false }],
      pumps: [{ t: 2e12, name: 'Pumped', ratio: 9.8 }] }).map((p) => p.replace(/\x01.|\x02/g, ''));
    assert.match(bp[3], /TOP BASKET TRACKER[\s\S]*\n 1 +Calm +88\.00 +90\.00 +\+2\.0% HELD[^\n]*Pumped +x9\.8\n 2 +Fresh +50\.00 +50\.00 +- NEXT/, 'basket: calm, now, 5 min, held or next; pumps refused');
    assert.match(streamPages({ me }).map((p) => p.replace(/\x01.|\x02/g, ''))[3], /no ranking yet[^\n]*none so far/, 'control: empty basket and no pump');
  }
  // right panel: 24 h value chart, mascot mood, bubble, bot log
  {
    const t0 = 1e12, pts = Array.from({ length: 100 }, (_, i) => ({ t: t0 + i * 60e3, value: 1000 + i }));
    const ch = equityChart(pts, t0 + 99 * 60e3, 10, 2, 100 * 60e3);
    assert.deepStrictEqual(ch.rows.map((r) => r.length), [10, 10], 'chart: w columns x h rows');
    assert.ok(ch.rows[1].startsWith('\u2581') && ch.rows[0].endsWith('\u2588') && ch.lo === 1009 && ch.hi === 1099, 'rising: low bottom-left, full top-right (lo, hi: of the columns)');
    assert.strictEqual(equityChart(pts.slice(0, 1), t0, 10, 2), null, 'control: one point is no chart');
    assert.strictEqual(moodOf(pts, t0 + 99 * 60e3), 'happy', 'up 1.5% in 15 min: happy');
    assert.strictEqual(moodOf(pts.map((p) => ({ ...p, value: 3000 - p.value })), t0 + 99 * 60e3), 'sad', 'control: down: sad');
    assert.strictEqual(moodOf(pts.map((p) => ({ ...p, value: 1000 })), t0 + 99 * 60e3), 'cool', 'control: flat: cool');
    for (const m of ['happy', 'cool', 'sad']) { const ps = mascot(m); assert.ok(ps.length === 4 && ps.every((p) => p.split('\n').length === 8 && p.includes('.-^-.')), m + ': 4 poses in the hat'); }
    const b = bubble('SOLD SomeoneWithALongName +137.20 Cx yeehaw').trimEnd().split('\n');
    assert.ok(b.length === 4 && new Set(b.map((x) => x.length)).size === 1, 'bubble: two lines in a closed box: ' + JSON.stringify(b));
    const own = ownOrders([JSON.stringify({ t: '2026-10-18T21:00:11Z', ev: 'stock-market/buy', name: 'vimp', why: 'top #4', status: 200, res: { cash_cents: 9318 } }),
      JSON.stringify({ t: '2026-10-18T21:05:33Z', ev: 'stock-market/sell', name: 'vimp', why: 'toprank 43', status: 200, res: { cash_cents: 897 } }),
      JSON.stringify({ t: '2026-10-18T21:05:34Z', ev: 'stock-market/buy', name: 'x', why: 'top #4', status: 429, res: {} })]);
    assert.deepStrictEqual(own.trips, [{ t: Date.parse('2026-10-18T21:05:33Z'), name: 'vimp', k: 'top', pnl: -8421 }], 'round trip with its strategy; control: a 429 is no order');
    const lg = botLog(own.orders, [{ u: 'gone', t: Date.parse('2026-10-18T21:08:00Z'), source: 'nuke' }, { u: 'back', t: Date.parse('2026-10-18T21:09:00Z'), revive: true }], [{ t: Date.parse('2026-10-18T21:10:00Z'), name: 'Pumped', ratio: 9.8 }]);
    const ll = layers(lg, 50);
    assert.match(lg.replace(/\x01.|\x02/g, ''), /^21:10 SKIP Pumped +pump x9\.8\n21:09 BACK back +revived\n21:08 RIP  gone +nuke *\n21:05 SELL vimp +-84\.21\n21:00 BUY  vimp +93\.18\n$/, 'bot log newest first');
    assert.ok(ll.r.includes('-84.21') && !ll.g.includes('-84.21') && ll.y.includes('SKIP') && ll.lw === undefined && lg.split('\n').every((x) => x.replace(/\x01.|\x02/g, '').length <= 42), 'log colors and width');
  }
  const tick = streamTicker({ me, names: { b: 'Big' }, health: { x: { alive: true }, y: { alive: false } }, movers: [{ name: 'Up', ret: 0.2 }, { name: 'Down', ret: -0.1 }] });
  assert.match(tick, /^CX STOCK BOT +\| +REALIZED \+505\.80 Cx +\| +RISING {2}Up \+20\.0% +\| +FALLING {2}Down -10\.0% +\| +LAST ORDERS {2}04:29 buy Big 20\.00 Cx +\| +ALIVE 1 /);
  assert.ok(!tick.includes('\n') && /^[\x20-\x7e]+$/.test(tick), 'one printable ASCII line');
  assert.doesNotMatch(streamTicker({ me, movers: [{ name: 'Up', ret: 0.2 }] }), /FALLING/, 'control: no falling section without a fall');
}
// round trips per strategy, matched buy -> next sell of the same name; unknown prefixes ignored
{
  const tr = (side, name, why, c) => JSON.stringify({ ev: `stock-market/${side}`, name, why, status: 200, res: { cash_cents: c } });
  const r = roundTrips([tr('buy', 'A', 'top #1', 1000), tr('sell', 'A', 'toprank', 1300), tr('buy', 'B', 'mom +2', 1000), tr('sell', 'B', 'x', 500), tr('buy', 'C', 'crash -30%', 1000), tr('sell', 'C', 'time', 800)], ['top', 'crash']);
  assert.deepStrictEqual(r, { top: { n: 1, win: 1, pnl: 300 }, crash: { n: 1, win: 0, pnl: -200 } });
}
// engine loops: every periodic job is scheduled, none hidden behind a // comment (18/10: record, retune, daily and
// reloadParams sat after one for 8 h, the tape stopped)
{
  const src = fs.readFileSync('engine.mjs', 'utf8'), lines = src.split('\n');
  const swallowed = (ls) => ls.filter((l) => /^\s*[^/\s].*\/\/.*\bloop\(/.test(l)); // code, then a comment, then a call it hides
  assert.deepStrictEqual(swallowed(lines), [], 'a loop( after a // comment is never scheduled');
  assert.strictEqual(swallowed(['loop(a, 1); // x loop(b, 2);']).length, 1, 'control: the 18/10 line is caught');
  for (const fn of ['guard', 'scan', 'readMap', 'pushStream', 'record', 'retune', 'daily', 'reloadParams']) assert.ok(lines.some((l) => new RegExp(`^loop\\(${fn},`).test(l)), `${fn} is scheduled`);
}
console.log('check ok');
