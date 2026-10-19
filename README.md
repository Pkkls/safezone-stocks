# safezone-stocks

An unattended trading engine for the stock market of the SafeZone fan event: a 7-day IRL battle royale where every
contestant has a tradable stock priced in Cx Bucks, an event currency with no real-world value. It trades on its own,
protects positions you open by hand, tunes itself, announces its trades in Kick chat, shows everything on a live local dashboard and streams its state.

![Live dashboard, portfolio section](docs/screenshots/portfolio.png)

## The market (measured, not documented)

- One stock per contestant, opening at 10.00 Cx, in a constant-product pool with ~10,000 Cx of cash reserve `R`: a
  buy of `c` moves the price by ~`2c/R`, so your own orders move the price against you. Fees: 1.5% per side.
- A death knocks the stock ~20% down, 30 s to 2 min later. Eliminated stocks settle ~4 h later and vanish from the API.
- Since 18/10 a dead contestant can be revived: the roster clears `eliminated_at`, the stock loses its elimination
  flag and trades again. A revived contestant can die again (one died at 20:39, 20:41, and was back at 21:05 UTC).
- Data: `api.<host>/public/stock-market/` (stocks, trades, sparklines, your portfolio with the session cookie) and
  `event-public.<host>/event/map-snapshot` (graves, roster, contestant health).
- ~6 requests/s gets the IP blocked (`403 Blocked`); a 3rd order within ~2 s gets `429 RATELIMITED` (just retry).

## What the engine does

Positions every 2 s (exits at death or low HP within about 2 s of the map showing it), map (health, deaths) every 3 s, market every 15 s, one order per scan. The buy reason's first word names the strategy.

| Strategy | Buys | Sells |
|---|---|---|
| `top` | the `topN` highest-priced live contestants (10 by default, 14 since 2026-10-19) (traded in the last 30 min), ranked on their lowest price of now, 2.5 and 5 min ago (`topCalm`: a pump never ranks), 15% of cash each, one buy per scan | rank `topExit` or worse at the hourly check (20, 28 since 2026-10-19) |
| `surv` | 20 s after a new death, the 2 highest-priced live contestants (at most 2 open) | after 30 min |
| `crash` | a drop of 25%+ between two scans with no pump in the 3 min before (logged as kind `dip`) | after 10 min |

- **Run mode**: a crash or survivor buy that gains 10% rides a 15% trail from its peak, up to 2 h, instead of its timer.
- **Every position**, including yours: sold at death (grave, health feed or roster), under 25% HP, at elimination or
  when the stock stops trading. Never bought under 40% HP, outside the zone or dead. A death counts until the
  roster shows the contestant alive again (at least 30 s after it): then it is buyable, and a new death counts again.
  Revives go to `data/revives.jsonl` and the `revive` event.
- **Your own buys join the pool** (since 2026-10-19): shares bought by hand on the site are taken over as `top` basket
  shares (`adopt` in the log) and follow the basket's exits; a sale by hand just leaves the engine fewer shares.
- **Guard rails**: rebound and survivor orders capped at 1.5% of the pool reserve; at most 6 non-basket positions; a
  30 min cooldown (5 min for crash); each strategy switches itself off after 10 round trips with a negative total.
- **Self-tuning**, at start and every 2 h, on the last 24 h of recorded tape: each strategy's settings are replayed
  exactly as traded and a new one is adopted only with 8+ trades, a profit in both halves of the window and a clear
  margin; a losing strategy with no winning setting is switched off, and back on when one wins again. Picking the best
  of many settings on a small sample overfits: the kill switches are the safety net. `params.json` is hot-reloaded.
  `"topForce": true` there keeps the top basket on: self-tuning and its kill switch no longer change it (set on
  2026-10-19 to put idle cash to work, while the 24 h replay had it at -59 to -166 Cx and the last 12 h at +180 to +270).
  `"topKeep": 0.1` (set the same day): once every basket slot is held, cash above 10% of the total value goes into the
  smallest healthy basket position, `topfill` in the log, one order per scan. Measured before: on 19/10 every stock live
  24 h earlier, dead ones sold 2 min after their death, gained 16% on average (+19% over 12 h, +9% over 6 h), and the
  survivors' prices rose a median 4.6% in the 30 min after each of the 44 deaths.
- **Supervisor**: the scheduled task runs a parent process that restarts the engine if it crashes or hangs (no
  successful call for 5 min, or a session lost for 3 min).

### What was measured (net of fees and own impact, kept only if it held in both halves)

Momentum paid only in the opening rush and lost afterwards; chasing a pump loses even 2 s after it (-4% to -17%);
copying the best wallets lost 10% (they are the pumpers); the whole market drifts down (-1.4% to -5% per 30 min held);
scanning every 5 s instead of 15 s earned less (it buys mid-fall); adding to winners lost. What paid: the top basket
(+404 Cx from 866 on one evening, both halves positive) and crash rebounds with run mode. Small samples: hints, not laws.

18/10 21:00 UTC: the basket lost 130 Cx on two pumps (a stock pushed from 22 to 227 Cx by dozens of wallets in a few
seconds, bought at 227, back at 22 thirty seconds later). The replay now buys on any scan, as the engine does (it
used to buy only at the hourly check, so it never saw a pump). On the last 24 h of tape, ranking entries by the
lowest price over 5 min: +1,588 Cx instead of +1,355, worst trade -43 instead of -64, both halves better. On the last
12 h alone the basket loses either way (-57 with the filter, -74 without): the gains come from the evening rushes.

## Setup

Node.js 22+, Windows for the scheduled task, Python 3 with `curl_cffi` only for Kick chat announcements.

```powershell
npm install
npx playwright install chromium
copy .env.example .env      # set SITE_HOST, END_AT; Telegram, Kick and stream are optional
pip install -r requirements.txt
```

Log in once: `node engine.mjs --login` opens a window, log in, close it (the session stays in `profile/`). Or import
cookies, below.

### Tutorial: import cookies with EditThisCookie

1. Install the EditThisCookie extension, log in to `kick.com` (chat announcements) and/or the event site (trading).
2. On that site: EditThisCookie icon, **Export** (copies a JSON array).
3. In the project folder: `Get-Clipboard | node import-cookies.mjs` (or save it as `cookies.json`, git-ignored, and run
   `node import-cookies.mjs cookies.json`).
4. It keeps `kick.com` `session_token` (as `KICK_BEARER` in `.env`) and the site's `token` cookies (loaded into
   `profile/` at the next start), drops everything else and never prints a value. Restart the engine.

Session cookies are your account: never paste them anywhere. If one leaked, log out of that site to invalidate it.

## Running it

`node engine.mjs --dry` logs what it would do; `node engine.mjs` trades. Unattended: run
`scripts\register-task.ps1` once from an elevated PowerShell (starts 1 min after logon, survives logoff); restart with
`Stop-ScheduledTask SafezoneStocks; Start-ScheduledTask SafezoneStocks`. The PC must not sleep. It exits for good
after `END_AT`.

### Live stream (no browser)

The engine pushes the stream's texts every 2 s over one long-lived ssh connection (only the ones that changed), and
`stream/run.sh` on a server has ffmpeg draw them (`drawtext`), encode them and send them to the RTMP(S) ingest,
restarting after any drop. It is drawn natively at 1920x1080, 8 fps, and encoded at constant quality (x264 CRF 18, up to
4 Mb/s): small text stays sharp (18/10, measured on 12 s of live content: 4x less encoding error than the first
setup, 720p capped at 600 kb/s, SSIM 0.9971 vs 0.9885). Measured on a 1 GB VPS: 14% of a core and 170 MB. The frame:

- **Header**: ASCII "CX" banner, a blinking LIVE tag, total profit (realized + open) big, green or red.
- **8 tiles**: total value, change since the start (607.46 Cx plus any deposit), cash, invested, positions, round trips won, contestants
  alive, time left in the event.
- **Left**: the current page, a new one every 20 s (5, plus one STATUS page per 34 alive contestants). The header line
  fills a bar until the next page, the line under it says what the page shows.
- **Right**: the total value over 24 h as a block chart (green when up over the window, red when down), with low, high
  and now; the CX mascot in a cowboy hat (the event is in Austin, Texas), dancing on a disco floor, 4 poses a second,
  happy and green when the value is up 0.5% over 15 min, sad and red when down 0.5%, cool and cyan otherwise, with a
  speech bubble that announces its last buy or sell (net PnL), a death or a revive within 2 min, and otherwise tells
  a fun fact every 20 s (38 of them in `FUN_FACTS`, `backtest.mjs`: Ice Poseidon's career, the Cx community, Safe Zone
  rules, this market, the mascot; taken from Wikipedia, iceposeidon.com and KXAN on 18/10) or a line for its mood;
  the bot log (its orders, deaths, revives and refused pumps, newest first).
- **Bottom**: a scrolling band of the other players' big trades on every page (`BIG TRADES`: 100 Cx or more in the
  last hour, newest first, time, BUY in green or SELL in red, stock, Cx, price move), then a scrolling ticker (PnL,
  5-min movers, last orders, alive count).

1. Server (ffmpeg + DejaVu fonts): copy `stream/run.sh` to `~/szdash/`, put the ingest URL and stream key in
   `~/szdash/url` (`chmod 600`), run `nohup sh ~/szdash/run.sh >/dev/null 2>&1 &` and add it as a crontab `@reboot`.
2. PC: `STREAM_SSH` (ssh host alias) in `.env`, plus `STREAM_SSH_BIN` if `ssh` is not on PATH. Restart the engine.

| Page | Shows |
|---|---|
| 1 PORTFOLIO | every position: strategy (`top`, `dip` = crash rebound, `surv`; a stock bought by hand is adopted as `top`), cost, value, P/L in Cx and %, the contestant's HP, how long it has been held |
| 2 ACTIVITY | last 14 orders (buy / sell); per strategy: closed round trips, winners, PnL; the 4 best and 4 worst round trips |
| 3 MARKET | 8 biggest 5-min rises and falls, share of the market rising, the 18 most expensive stocks |
| 4 TOP BASKET TRACKER | the basket's ranking on calm price (calm, now, 5-min change, HELD or NEXT to buy) and the pumps it refused (price over 1.5x its calm price, `pump_skip` in the log) |
| 5 CONTESTANTS | contestants in danger (under 35% HP or outside the zone) and the 18 last deaths (with what killed them) and revives, newest first |
| 6 OTHER PLAYERS: MONEY FLOW | everyone else's trades over the last 10 and 60 min (trades, traders, bought, sold, net with BUYERS or SELLERS LEAD, biggest trade) and the hour's 15 most traded stocks (trades, bought, sold, net; `*` when the bot holds it) |
| 7 OTHER PLAYERS: LAST 20 TRADES | their last 20 trades newest first (age, stock, side, Cx, price move of the trade, BIG from 100 Cx, `*` when the bot holds it), then the 4 biggest trades of the hour with their price before and after |
| 8 and on, STATUS | every alive contestant, weakest first, 34 per page: HP bar, HP, sigil, and the S P D O L R flags below |

The eight pages on 19/10 around 17:20 UTC, 1920x1080 (19 alive, one STATUS page). The other players' pages come from the
tape, recorded every minute, without this account's own trades:

![Stream page 1, portfolio](docs/screenshots/stream-page-1.png)

![Stream page 2, activity](docs/screenshots/stream-page-2.png)

![Stream page 3, market](docs/screenshots/stream-page-3.png)

![Stream page 4, top basket tracker](docs/screenshots/stream-page-4.png)

![Stream page 5, contestants](docs/screenshots/stream-page-5.png)

![Stream page 6, other players: money flow](docs/screenshots/stream-page-6.png)

![Stream page 7, other players: last 20 trades](docs/screenshots/stream-page-7.png)

![Stream page 8, status](docs/screenshots/stream-page-8.png)

`ssh <host> sh -s < stream/snap.sh && scp '<host>:/tmp/szsnap/*.png' docs/screenshots/` retakes them: on the server,
it waits for each page, freezes its text files and has ffmpeg draw one frame with `run.sh`'s own filters, so a
screenshot is exactly what viewers see. The live stream is not touched. Rename `page<N>.png` to `stream-page-<N>.png`.

Colors (one drawtext layer each, aligned on the same character grid): **green** gain, buy, HP over 70%, live, revive;
**red** loss, sell, HP under 35%, death, poison, drone, outside the zone; **yellow** HP 35 to 70%, shield, page
description, refused pump; **cyan** titles; **white** everything else.

Contestant status, decoded from the map's health frame and roster (never their positions):

| Field | Meaning |
|---|---|
| HP / max | hit points; max differs by contestant (90, 100, 110) |
| sigil | the contestant's class in the game: piety, healing, protection, endurance, greed, trolling, necromancy... |
| S shield | armor badge from the game: `kick_shield` or `faith_shield` (their exact effect is not published) |
| P poisoned | poison ticking (from a poison dart) |
| D drone | a drone strike is incoming |
| O outside | outside the safe zone: loses HP until back in |
| L live | streaming on Kick right now |
| R revived | died, then came back (revives exist since 18/10) |
| deaths | what killed them: zone, knife, drone, zombie_leech... |

A frozen "data HH:MM:SS UTC" on the stream means the PC stopped pushing. `stream/check.sh <env file with TG_TOKEN and
TG_CHAT>`, run every 5 min from cron on the server, sends one Telegram message when the text is over 5 min old (engine
down, session lost or PC off) or ffmpeg is down, and one when it is back.

## Dashboard

Open http://127.0.0.1:7788 while the engine runs (port `DASH_PORT` in `.env`). The supervisor serves it, so it stays
up while the engine restarts and cannot stop trading if it fails (`dashboard_err` in the log if it cannot start). It is
read-only and local (bound to 127.0.0.1), built from local files only: `live.json`, rewritten by the engine every 2 s
(portfolio, last scan, contestant health and roster, API state), `trades.jsonl`, the tape and `data/equity.jsonl` (one
total value point a minute). Every change reaches open tabs within 2 s (server-sent events). It works at phone width.

The screenshots below are the live dashboard on 18/10 around 21:10 UTC (15 positions, total value 2,043 Cx from 607).
The value curve has a hole from 04:30 to 13:50 UTC: the dashboard was removed then, and no point was recorded.

![Header: engine status, data age, time left in the event](docs/screenshots/header.png)

40 modules in five sections.

### Portfolio

Total value and gain since the start, cash, invested, unrealized and closed PnL, the total value curve, allocation by
strategy, and every position with cost, value, PnL, peak, top rank, holding time, the contestant's HP and its exit
condition.

![Portfolio](docs/screenshots/portfolio.png)

*Key figures*

![Key figures](docs/screenshots/kpis.png)

*Total value curve, hover tooltip*

![Total value curve, hover tooltip](docs/screenshots/equity-tooltip.png)

*Positions*

![Positions](docs/screenshots/positions.png)

### Strategies

PnL by strategy, kill switches, market breadth, the top basket ranking with one-hour sparklines, the crash radar, the
latest auto-tuning results, current parameters, the distribution of round trips, the order log (filter: buys, sells,
rejected) and the closed round trips.

![Strategies](docs/screenshots/strategies.png)

*PnL by strategy, kill switches, market breadth*

![PnL by strategy, kill switches, market breadth](docs/screenshots/strategy-pnl.png)

*Top basket ranking*

![Top basket ranking](docs/screenshots/top-basket.png)

*Crash radar*

![Crash radar](docs/screenshots/crash-radar.png)

*Auto-tuning, parameters, round trip distribution*

![Auto-tuning, parameters, round trip distribution](docs/screenshots/tuning-params.png)

*Order log*

![Order log](docs/screenshots/orders.png)

*Order log, rejected orders only*

![Order log, rejected orders only](docs/screenshots/orders-rejected.png)

*Round trips*

![Round trips](docs/screenshots/round-trips.png)

### Market

Breadth over 24 h, trades per minute, active wallets, volume per 10 minutes, top gainers and losers, the largest
trades of the hour, a heat map of every live stock and the other players' last 20 trades (this account's own trades left out).

![Market](docs/screenshots/market.png)

*Breadth over time, live activity*

![Breadth over time, live activity](docs/screenshots/breadth.png)

*Volume per 10 minutes, hover tooltip*

![Volume per 10 minutes, hover tooltip](docs/screenshots/volume-tooltip.png)

*Top gainers, top losers, whales*

![Top gainers, top losers, whales](docs/screenshots/movers-whales.png)

*Market heat map, hover tooltip*

![Market heat map, hover tooltip](docs/screenshots/heat-map-tooltip.png)

*Other players: last 20 trades*

![Other players: last 20 trades](docs/screenshots/trade-feed.png)

### Game

Contestants alive, deaths per hour and by cause, every alive contestant (weakest first, with class, shield and live
on Kick, revived ones flagged), the latest deaths and revives, the lowest HP, who is outside the zone, and settled
stocks.

![Game](docs/screenshots/game.png)

*Contestants, deaths per hour, causes*

![Contestants, deaths per hour, causes](docs/screenshots/deaths.png)

*Every alive contestant, weakest first*

![Every alive contestant, weakest first](docs/screenshots/alive-contestants.png)

*Latest deaths and revives, lowest HP, outside the zone*

![Latest deaths and revives, lowest HP, outside the zone](docs/screenshots/health.png)

*Settlements*

![Settlements](docs/screenshots/settlements.png)

### Engine

Health (last `/me`, last scan, session), API state, health feed, time left in the event, starts and watchdog exits,
Kick announcements, data file sizes and the event log (filter: orders, tuning, health).

![Engine](docs/screenshots/engine.png)

*Engine health, API, health feed, event end*

![Engine health, API, health feed, event end](docs/screenshots/engine-health.png)

*Event log, health events only*

![Event log, health events only](docs/screenshots/events-health.png)

### On a phone

<table>
<tr>
<td><img src="docs/screenshots/mobile-home.png" width="190" alt="First screen"></td>
<td><img src="docs/screenshots/mobile-positions.png" width="190" alt="Positions"></td>
<td><img src="docs/screenshots/mobile-top-basket.png" width="190" alt="Top basket"></td>
<td><img src="docs/screenshots/mobile-movers.png" width="190" alt="Top gainers and losers"></td>
<td><img src="docs/screenshots/mobile-engine.png" width="190" alt="Engine health and API"></td>
</tr>
</table>

### Whole page

![The whole dashboard in one image](docs/screenshots/overview.png)

### Notes

Times show in the browser's time zone. The tape arrives in 1-minute batches, so the trade feed lags by up to a minute;
prices and positions refresh every 2 seconds. A gap of more than 15 minutes in the value curve is drawn as a gap.

`node dashboard.mjs` runs it on its own, for working on the page; edits to `dashboard.html` reload open tabs by
themselves. `node scripts/screenshots.mjs` retakes the 33 dashboard screenshots above from the running dashboard
(desktop and phone, hover tooltips and filters included); `--anon` replaces every contestant name with "Player N",
hides stock ids and the site host, and stops if any of them is still on the page.

## Monitoring

`node status.mjs` prints deaths, breadth, trades and PnL per strategy from local files. `trades.jsonl` is the event
log: `start`, `restart`, `watchdog`, `stock-market/buy|sell` (with `why`), `kick_say`, `auth_lost` (log in again),
`blocked`, `revive`, `adopt` (shares bought by hand taken over by the engine), `pump_skip`, `cash_in` / `cash_out` (the Cx Bucks balance moved without an order, e.g. chat earnings: summed in `state.json` as deposits and left out of the gain since the start), `manual_trade` (a trade made by hand on the site: its cash is taken back out of the deposits, so it is neither a deposit nor a withdrawal), `<strategy>_off` / `_on`, `tune_crash|surv|top`, `params_reload`, `stream_err`, `save_err`, `dashboard_err`. Telegram (optional):
lost session, long API block, strategy switched off or on, new params, daily PnL.

`node check.mjs` must print `check ok` after any change: replays, tuners, kill-switch tally, watchdog, health
decoder, revives (dead until revived, dead again after a new death), the top basket's pump filter and fill (smallest position first, cash reserve kept), the balance a restart starts from (a deposit never counted twice), trades made by hand kept out of the deposits and their shares adopted, the two OTHER PLAYERS pages (10 and 60 min windows, by-stock totals, two columns of trades, the hour's biggest, BIG and held marks) and the big trades band (BUY green, SELL red, every color layer the same width), chat and stream text (every alive contestant on a STATUS page; basket tracker, value chart, mascot mood, speech bubble, every fun fact shown whole, bot log), cookie sorter, engine loop scheduling (no
periodic job hidden behind a comment), each with a control case that must fail.

## Safety rules

- Every API call goes through one queue at 2.5 requests/s with back-off on a block.
- The map's binary feed carries live GPS positions of real people: only the health frame is decoded, never positions.
- No credential is stored or printed by the engine; recorded market data (`data/`, other players' ids) stays local.

## Files

`engine.mjs` the engine and supervisor · `backtest.mjs` replays, tuning, decoders, text · `check.mjs` self-check ·
`status.mjs` status · `import-cookies.mjs` cookie import · `kick_say.py` chat line (Python: Kick blocks Node's TLS
fingerprint) · `stream/run.sh` stream · `stream/check.sh` stream alert · `stream/snap.sh` stream screenshots · `dashboard.mjs`
local dashboard server · `dashboard.html` its page · `scripts/screenshots.mjs` dashboard screenshots · `docs/screenshots/`
all the images above · `scripts/register-task.ps1` scheduled task · `.env.example` configuration.
