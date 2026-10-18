// Self-check of the pure helpers (backtest.mjs, import-cookies.mjs): node check.mjs
import assert from 'node:assert';
import { prepare, compact, sayText, decodeHealth, simulateCrash, tuneCrash, simulateSurv, tuneSurv, trialTally, stuck, simulateTop, tuneTop, streamPages, streamTicker, layers, roundTrips } from './backtest.mjs';
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
}
// watchdog: stale after 5 min without success, never during an API block; lost after 3 min of 401
{
  const t = 1e12, m = 60e3;
  assert.deepStrictEqual(stuck(t + 6 * m, t, 0, 0), { stale: true, lost: false }, 'stale not detected');
  assert.deepStrictEqual(stuck(t + 6 * m, t, t + 5 * m, 0), { stale: false, lost: false }, 'control: a block is not a hang');
  assert.deepStrictEqual(stuck(t + 4 * m, t + 4 * m, 0, t), { stale: false, lost: true }, 'lost session not detected');
  assert.deepStrictEqual(stuck(t + 2 * m, t + 2 * m, 0, t), { stale: false, lost: false }, 'control: 2 min of 401 is tolerated');
}
// stream pages: 5 pages of at most 96 x 22, color layers on one grid, each with its content; positions sorted by value, yours labelled
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
  assert.strictEqual(raw.length, 5);
  for (const p of plain) { const l = p.trimEnd().split('\n'); assert.ok(l.length <= 22 && l.every((x) => x.length <= 96), 'page fits 96 x 22: ' + l[0]); }
  for (const [i, L] of Lay.entries()) for (const k of ['g', 'r', 'y', 'c']) assert.deepStrictEqual(L[k].split('\n').map((x) => x.length), L.w.split('\n').map((x) => x.length), `layer ${k} of page ${i + 1} on the same grid`);
  assert.match(Lay[0].g, /\n {49}\+5\.00 +\+25\.0%/, 'a gain is drawn in green, at its column');
  assert.match(Lay[0].r, /\n {49}-1\.00 +-10\.0%/, 'a loss is drawn in red');
  assert.doesNotMatch(Lay[0].g, /-1\.00/, 'control: a loss is never green');
  assert.match(plain[4], /5\/5 {2}STATUS[\s\S]*\nx +##-{8} +20 - +\.\.\.\.\.[\s\S]*\nz +#{9}- +90 healing +S\.\.\.L/, 'status: weakest first, hp bar, sigil, shield and live flags');
  assert.match(Lay[4].y, /S/, 'a shield is drawn in yellow');
  // 70 alive: every one is on exactly one STATUS page (34 per page), the healthiest included (18/10: FloridaBoy, 110/110,
  // was cut by the 34-weakest page); the page counter follows
  {
    const many = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`p${String(i).padStart(2, '0')}`, { alive: true, hp: i + 1, max: 110, out: false }]));
    const pg = streamPages({ me, health: { ...many, gone: { alive: false, hp: 0, max: 100 } } }).map((p) => p.replace(/\x01.|\x02/g, ''));
    assert.strictEqual(pg.length, 7, '4 pages + 3 STATUS pages for 70 alive');
    assert.match(pg[6], /^7\/7 {2}STATUS 3\/3 \(weakest first, 70 alive\)/, 'status pages numbered');
    for (const n of Object.keys(many)) assert.strictEqual(pg.slice(4).filter((p) => new RegExp(`\\n${n} `).test(p) || new RegExp(` ${n} `).test(p)).length, 1, `${n} on exactly one status page`);
    assert.match(pg[6], /p69 +#{6}-{4} +70/, 'the healthiest (70/110) is on the last status page');
    assert.ok(!pg.slice(4).some((p) => /gone/.test(p)), 'control: a dead contestant is on no status page');
    for (const p of pg) { const l = p.trimEnd().split('\n'); assert.ok(l.length <= 22 && l.every((x) => x.length <= 96), 'status page fits 96 x 22'); }
  }
  assert.match(plain[0], /^1\/5 {2}PORTFOLIO[\s\S]*Realized \+505\.80 Cx {3}Open -1\.20 Cx {3}Positions 2 {3}Alive 2 {3}Bot up 3h05/);
  assert.match(P[0], /\nBig +crash +20\.00 +25\.00 +\+5\.00 +\+25\.0%\nSmall +yours/, 'highest value first; control: a position the engine did not open is yours');
  assert.match(P[1], /04:29 {2}buy {3}Big[\s\S]*top +3 +2 +\+15\.00/, 'orders and strategy PnL');
  assert.match(P[2], /RISING[^\n]*\nUp +\+20\.0%[^\n]*\n[^\n]*\nFALLING 5 MIN\nDown +-10\.0%/, 'control: a fall is never listed as rising');
  assert.match(P[2], /1\. Top +90\.00/);
  assert.match(P[3], /IN DANGER[^\n]*\nx +20\/100[^\n]*newest +knife/, 'low hp listed (z at 90 hp is not), deaths newest first with their source');
  assert.doesNotMatch(P[3], /\nz /, 'control: a healthy contestant is not in danger');
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
console.log('check ok');
