// Death tracker + engine state at a glance. node status.mjs
// Reads only local files written by the engine (no API call): data/deaths.jsonl, trades.jsonl, state.json.
import fs from 'node:fs';

const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);

const deaths = [...new Map(lines('data/deaths.jsonl').map((d) => [d.u + d.t, d])).values()].sort((a, b) => a.t - b.t);
const hour = deaths.filter((d) => d.t > Date.now() - 3600e3).length;
console.log(`Deaths: ${deaths.length} (${hour} in the last hour)`);
console.log('Last 10: ' + deaths.slice(-10).reverse().map((d) => `${hhmm(d.t)} ${d.u} (${d.source})`).join(' | '));

const log = lines('trades.jsonl');
const scan = log.filter((e) => e.ev === 'scan').at(-1);
const trades = log.filter((e) => /stock-market\/(buy|sell)/.test(e.ev) && e.status === 200);
console.log(`Market breadth: ${scan?.breadth ?? '-'} at ${scan ? hhmm(scan.t) : '-'}`);
console.log(`Trades: ${trades.length}, last: ${trades.at(-1) ? `${hhmm(trades.at(-1).t)} ${trades.at(-1).ev.split('/')[1]} ${trades.at(-1).name} (${trades.at(-1).why})` : '-'}`);
console.log(`API blocks: ${log.filter((e) => e.ev === 'blocked').length}`);
// round trips per strategy (buy reason prefix: crash / surv / mom...), matched buy -> next sell of the same stock
const open = {}, rt = {};
for (const e of trades) {
  if (e.ev.endsWith('buy')) open[e.name] = { cash: e.res.cash_cents, kind: String(e.why).split(' ')[0] };
  else if (open[e.name]) { const o = open[e.name]; const r = (rt[o.kind] ||= { n: 0, win: 0, pnl: 0 }); r.n++; r.pnl += e.res.cash_cents - o.cash; if (e.res.cash_cents > o.cash) r.win++; delete open[e.name]; }
}
for (const [k, r] of Object.entries(rt)) console.log(`Round trips ${k}: ${r.n}, winners ${r.win}, PnL ${(r.pnl / 100).toFixed(2)}`);
const st = fs.existsSync('state.json') ? JSON.parse(fs.readFileSync('state.json', 'utf8')) : { entryAt: {} };
console.log(`Engine positions: ${Object.keys(st.entryAt || {}).length}`);
