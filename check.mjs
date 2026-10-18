// Self-check: backtest on the frozen opening tape must reproduce the reference PnL, and tune() must
// refuse to adopt params that do not clearly beat the current ones. node check.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import { prepare, simulate, tune, compact, loadTape, sayText, decodeHealth, simulateCrash, tuneCrash, simulateSurv, tuneSurv } from './backtest.mjs';
import { sortCookies, setEnv } from './import-cookies.mjs';

const ref = fs.readFileSync('data/opening-17-10.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const d = prepare(ref);
const P = { lookback: 2 * 60e3, entryMin: 0.15, entryMax: 99, trail: 0.8, maxHold: 10 * 60e3, size: 0.25 };
// 119609 = value on this frozen file (3946 trades). The 3912-trade first fetch gave 124253 with both the
// old and the refactored simulator; the gap is the 34 trades that fetch missed, not code.
assert.strictEqual(simulate(d, P).pnl, 119609, 'reference PnL drifted: tape loading or simulation changed');

const best = tune(ref, P);
assert.ok(best.adopt === null || best.best.r.pnl > best.cur.pnl + 2500, 'tune adopted without margin');
const worse = { ...P, lookback: 5 * 60e3, entryMin: 0.3, entryMax: 0.6 }; // worst combo on this tape
assert.strictEqual(tune(ref, worse).adopt, null, 'best combo has 8 trades here: below 10 it must not be adopted');
assert.ok(tune(ref, worse, 5).adopt, 'tune should replace a clearly worse param set');

// breadth gate: at 0.6 the late (post-rush) tape must produce no trades, at 0 it trades
const all = fs.readFileSync('data/opening-17-10.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const late = prepare(all.filter((r) => r.t >= all[0].t + 15 * 60e3));
assert.strictEqual(simulate(late, { ...P, minBreadth: 0.6 }).n, 0, 'breadth gate did not stand aside');
assert.ok(simulate(late, { ...P, minBreadth: 0 }).n > 0, 'control: ungated run should trade');

// dump exit: a held stock hit by a >= 5% sell while breadth is low must be sold at that step
{
  const t = 1e12, row = (e, dt, pb, pa, s = 'b') => ({ e, t: t + dt, pb, pa, s });
  const tape = [row('a', 0, 1000, 1000), row('a', 60e3, 1000, 1300), row('a', 90e3, 1300, 1300), row('a', 200e3, 1300, 1200, 's'), row('a', 400e3, 1200, 1200)];
  const Q = { lookback: 60e3, entryMin: 0.15, entryMax: 99, trail: 0.5, maxHold: 0, size: 0.25, minBreadth: 0, dumpExit: true, dumpBreadth: 2 };
  assert.ok(simulate(prepare(tape), Q).n === 1, 'dump exit did not fire');
  assert.ok(simulate(prepare(tape), { ...Q, dumpExit: false }).n === 0, 'control: without dump exit the position stays open');
}

// sim vs live: on the window the engine traded live ungated (20:27-20:45 UTC, 6 round trips, net +4.94, 2 wins),
// the simulator must also see a losing phase (it gave -16409, 1/17) and the 0.6 breadth gate must stay out.
{
  const from = Date.parse('2026-10-17T20:27:05Z'), to = Date.parse('2026-10-17T20:45:00Z');
  const tape = loadTape(0).filter((r) => r.t >= from - 6e5 && r.t <= to);
  if (tape.length) {
    const w = { ...prepare(tape), t0: from - 120e3, t1: to };
    assert.ok(simulate(w, P).pnl < 0, 'simulator turned optimistic on the live losing window');
    assert.strictEqual(simulate(w, { ...P, minBreadth: 0.6 }).n, 0, 'breadth gate would have traded the live losing window');
  }
}

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
    recs.forEach(([slot, status, flags, hp, max], i) => { v.setUint16(48 + i * 2, slot, true); v.setUint8(48 + n * 2 + i, status); v.setUint16(48 + n * 4 + i * 2, flags, true); v.setUint8(48 + n * 6 + i, hp); v.setUint8(48 + n * 7 + i, max); });
    return { binary: b.toString('base64') };
  };
  const text = { text: JSON.stringify({ type: 'contestants', data: { slots: { slots: [{ slot: 0, username: 'Aa' }, { slot: 1, username: 'Bb' }] } } }) };
  const h = decodeHealth([text, frame(2, [[0, 2, 1, 90, 100], [1, 3, 9, 50, 110]]), frame(2, [[0, 2, 0, 0, 100]]), frame(1, [[1, 2, 1, 7, 100]])]);
  assert.deepStrictEqual(h, { aa: { hp: 0, max: 100, alive: false, out: false }, bb: { hp: 50, max: 110, alive: true, out: true } }, 'health decode');
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
  assert.ok(r.total > 0.2, 'crash rebound should be a clear win');
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
console.log('check ok');
