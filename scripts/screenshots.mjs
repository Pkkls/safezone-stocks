// Anonymized dashboard screenshots for the README: node scripts/screenshots.mjs (dashboard running on DASH_PORT).
// The live state is fetched once, every contestant name in it is replaced by "Player N" (numbers kept), and the page
// is fed that state instead of the live stream. Fails if any real name is still in the rendered text.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = `http://127.0.0.1:${process.env.DASH_PORT || 7788}`;
const OUT = 'docs/screenshots';
const state = await (await fetch(`${BASE}/api/state`)).json();

// every contestant name the page can show
const names = new Set();
const add = (n) => { if (n && typeof n === 'string' && n.length > 1) names.add(n.toLowerCase()); };
const M = state.market, G = state.game;
for (const list of [M.ranked, M.crash, M.up, M.down, M.heat, M.feed, M.whales, state.positions, state.orders, state.trips, G.settled]) for (const x of list || []) add(x.name);
for (const list of [G.lastDeaths, G.lowHp, G.outside]) for (const x of list || []) add(x.u);
for (const k of state.engine.kick?.last || []) add(k.name);
// longest first, so a name that contains another is replaced whole
const alias = new Map([...names].sort((a, b) => b.length - a.length).map((n, i) => [n, `Player ${i + 1}`]));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const re = new RegExp(`(?<![\\p{L}\\p{N}_])(${[...alias.keys()].map(esc).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
// stock ids resolve to names through the public API, and the repo never names the site (SITE_HOST in .env): hidden too
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const HOST = process.env.SITE_HOST || '\0';
const anon = (v) => typeof v === 'string' ? v.replace(re, (m) => alias.get(m.toLowerCase())).replace(/contestant-[0-9a-f]{32}/g, 'contestant-id').replaceAll(HOST, '<host>')
  : Array.isArray(v) ? v.map(anon) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, anon(x)])) : v;
const clean = anon(state);

const browser = await chromium.launch();
async function shoot(width, shots) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
  // one anonymized state event, and a long retry so the stream does not reconnect to the live one
  await page.route('**/api/events', (r) => r.fulfill({ status: 200, contentType: 'text/event-stream', body: `retry: 3600000\nevent: state\ndata: ${JSON.stringify(clean)}\n\n` }));
  await page.goto(BASE + '/');
  await page.waitForTimeout(1500);
  // the sticky header would land on top of a section screenshotted after a scroll
  await page.evaluate(() => { document.getElementById('err').style.display = 'none'; document.getElementById('livedot').classList.add('on'); document.querySelector('header').style.position = 'static'; });
  const text = (await page.evaluate(() => document.body.innerText + [...document.querySelectorAll('[data-tip],[aria-label]')].map((e) => e.dataset.tip + ' ' + e.getAttribute('aria-label')).join(' '))).toLowerCase();
  const leaks = [...alias.keys()].filter((n) => new RegExp(`(?<![\\p{L}\\p{N}_])${esc(n)}(?![\\p{L}\\p{N}_])`, 'u').test(text));
  if (leaks.length || /contestant-[0-9a-f]{32}/.test(text) || text.includes(HOST.toLowerCase())) { console.error(`STOP: ${leaks.length} real name(s), a stock id or the site host still on the page`); process.exit(1); }
  for (const [file, sel] of shots) await page.locator(sel).screenshot({ path: `${OUT}/${file}` });
  await page.close();
}
fs.mkdirSync(OUT, { recursive: true });
await shoot(1600, [['portfolio.png', '#portfolio'], ['strategies.png', '#strategies'], ['market.png', '#market'], ['game.png', '#game'], ['engine.png', '#engine']]);
await shoot(390, [['mobile.png', 'main > section:first-child']]);
await browser.close();
console.log(`${alias.size} names replaced, 6 screenshots in ${OUT}, no real name left`);
