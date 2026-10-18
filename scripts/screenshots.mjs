// Dashboard screenshots for the README: node scripts/screenshots.mjs [--anon] (dashboard running on DASH_PORT).
// Default: the live page as it is. --anon: the live state is fetched once, every contestant name is replaced by
// "Player N", stock ids and the site host are hidden, the page is fed that state instead of the live stream, and the
// script stops if any of them is still on the page.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = `http://127.0.0.1:${process.env.DASH_PORT || 7788}`;
const OUT = 'docs/screenshots';
const ANON = process.argv.includes('--anon');

let clean = null, alias = new Map(), HOST = '\0';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
if (ANON) {
  const state = await (await fetch(`${BASE}/api/state`)).json();
  const names = new Set();
  const add = (n) => { if (n && typeof n === 'string' && n.length > 1) names.add(n.toLowerCase()); };
  const M = state.market, G = state.game;
  for (const list of [M.ranked, M.crash, M.up, M.down, M.heat, M.feed, M.whales, state.positions, state.orders, state.trips, G.settled]) for (const x of list || []) add(x.name);
  for (const list of [G.lastDeaths, G.lowHp, G.outside]) for (const x of list || []) add(x.u);
  for (const k of state.engine.kick?.last || []) add(k.name);
  // longest first, so a name that contains another is replaced whole
  alias = new Map([...names].sort((a, b) => b.length - a.length).map((n, i) => [n, `Player ${i + 1}`]));
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(${[...alias.keys()].map(esc).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  // stock ids resolve to names through the public API; the site host lives in .env
  if (fs.existsSync('.env')) process.loadEnvFile('.env');
  HOST = process.env.SITE_HOST || '\0';
  const anon = (v) => typeof v === 'string' ? v.replace(re, (m) => alias.get(m.toLowerCase())).replace(/contestant-[0-9a-f]{32}/g, 'contestant-id').replaceAll(HOST, '<host>')
    : Array.isArray(v) ? v.map(anon) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, anon(x)])) : v;
  clean = anon(state);
}

const browser = await chromium.launch();
async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  // one anonymized state event, and a long retry so the stream does not reconnect to the live one
  if (ANON) await page.route('**/api/events', (r) => r.fulfill({ status: 200, contentType: 'text/event-stream', body: `retry: 3600000\nevent: state\ndata: ${JSON.stringify(clean)}\n\n` }));
  await page.goto(BASE + '/');
  await page.waitForTimeout(2500);
  if (ANON) {
    await page.evaluate(() => { document.getElementById('err').style.display = 'none'; document.getElementById('livedot').classList.add('on'); });
    const text = (await page.evaluate(() => document.body.innerText + [...document.querySelectorAll('[data-tip],[aria-label]')].map((e) => e.dataset.tip + ' ' + e.getAttribute('aria-label')).join(' '))).toLowerCase();
    const leaks = [...alias.keys()].filter((n) => new RegExp(`(?<![\\p{L}\\p{N}_])${esc(n)}(?![\\p{L}\\p{N}_])`, 'u').test(text));
    if (leaks.length || /contestant-[0-9a-f]{32}/.test(text) || text.includes(HOST.toLowerCase())) { console.error(`STOP: ${leaks.length} real name(s), a stock id or the site host still on the page`); process.exit(1); }
  }
  return page;
}
// one image around one or more selectors (their union), optionally after an interaction (hover for a tooltip, a click)
async function shot(page, file, sels, act) {
  const els = [sels].flat().map((s) => page.locator(s).first());
  await els[0].scrollIntoViewIfNeeded();
  if (act) { await act(page); await page.waitForTimeout(300); }
  const boxes = await Promise.all(els.map((e) => e.boundingBox()));
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width)), y1 = Math.max(...boxes.map((b) => b.y + b.height));
  const pad = 8, vw = page.viewportSize();
  const clip = { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad) };
  clip.width = Math.min(vw.width, x1 + pad) - clip.x; clip.height = Math.min(vw.height, y1 + pad) - clip.y;
  await page.screenshot({ path: `${OUT}/${file}`, clip });
  files.push(file);
}
const hoverIn = (sel, fx, fy = 0.5) => async (page) => { const b = await page.locator(sel).first().boundingBox(); await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy); };
const click = (sel) => async (page) => { await page.locator(sel).first().click(); await page.mouse.move(0, 0); };
const files = [];
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.unlinkSync(`${OUT}/${f}`);

// desktop: whole page, header, the five sections, then close-ups
{
  const page = await open(1600, 2400);
  await page.screenshot({ path: `${OUT}/overview.png`, fullPage: true }); files.push('overview.png');
  await shot(page, 'header.png', 'header');
  await page.evaluate(() => { document.querySelector('header').style.position = 'static'; }); // would land on later shots
  for (const [f, s] of [['portfolio.png', '#portfolio'], ['strategies.png', '#strategies'], ['market.png', '#market'], ['game.png', '#game'], ['engine.png', '#engine']]) await shot(page, f, s);
  await shot(page, 'kpis.png', ['#m-hero', '#m-tiles']);
  await shot(page, 'equity-tooltip.png', '#m-equity', hoverIn('#m-equity svg.chart', 0.72));
  await shot(page, 'positions.png', '#m-positions');
  await shot(page, 'strategy-pnl.png', ['#m-stratpnl', '#m-trial', '#m-gate']);
  await shot(page, 'top-basket.png', '#m-top');
  await shot(page, 'crash-radar.png', '#m-crash');
  await shot(page, 'tuning-params.png', ['#m-tunes', '#m-params', '#m-dist']);
  await shot(page, 'orders-rejected.png', '#m-orders', click('#m-orders .chip[data-v="fail"]'));
  await page.locator('#m-orders .chip[data-v="all"]').click();
  await shot(page, 'orders.png', '#m-orders');
  await shot(page, 'round-trips.png', '#m-trips');
  await shot(page, 'breadth.png', ['#m-breadth', '#m-mstats']);
  await shot(page, 'volume-tooltip.png', '#m-volume', hoverIn('#m-volume svg.chart', 0.3, 0.6));
  await shot(page, 'movers-whales.png', ['#m-up', '#m-down', '#m-whales']);
  await shot(page, 'heat-map-tooltip.png', '#m-heat', hoverIn('#m-heat .heat > div:nth-child(3)', 0.5));
  await shot(page, 'trade-feed.png', '#m-feed');
  await shot(page, 'deaths.png', ['#m-alive', '#m-deathsh', '#m-causes']);
  await shot(page, 'health.png', ['#m-deaths', '#m-lowhp', '#m-outside']);
  await shot(page, 'settlements.png', '#m-settled');
  await shot(page, 'engine-health.png', ['#m-health', '#m-api', '#m-hpfeed', '#m-end']);
  await shot(page, 'events-health.png', '#m-events', click('#m-events .chip[data-v="health"]'));
  await page.close();
}
// phone: the first screen as a phone shows it, then whole cards (a tall window, so no card is cut by the screen edge)
{
  const page = await open(390, 844);
  await page.screenshot({ path: `${OUT}/mobile-home.png` }); files.push('mobile-home.png');
  await page.close();
}
{
  const page = await open(390, 3000);
  await page.evaluate(() => { document.querySelector('header').style.position = 'static'; });
  for (const [f, s] of [['mobile-positions.png', '#m-positions'], ['mobile-top-basket.png', '#m-top'], ['mobile-movers.png', ['#m-up', '#m-down']], ['mobile-engine.png', ['#m-health', '#m-api']]]) await shot(page, f, s);
  await page.close();
}
await browser.close();
console.log(`${files.length} screenshots in ${OUT}${ANON ? `, ${alias.size} names replaced, no real name left` : ' (live data, not anonymized)'}`);
