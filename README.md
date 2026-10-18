# safezone-stocks

An unattended trading engine for the stock market of the SafeZone fan event: a 7-day IRL battle royale where every
contestant has a tradable "stock" priced in Cx Bucks. Cx Bucks are an event currency with no real-world value. This is
a hobby project to see how far a measured, rule-based bot can go on a small, thin, pump-and-dump-heavy market.

The engine runs in the background (Windows scheduled task), trades on its own, protects positions you open by hand,
and can announce its trades in the contestant's Kick chat.

## Contents

- [How the market works](#how-the-market-works)
- [What the engine does](#what-the-engine-does)
- [What was measured](#what-was-measured)
- [Setup](#setup)
- [Tutorial: import your cookies with EditThisCookie](#tutorial-import-your-cookies-with-editthiscookie)
- [Running it](#running-it)
- [Monitoring](#monitoring)
- [Backtesting and self-check](#backtesting-and-self-check)
- [Safety rules built in](#safety-rules-built-in)
- [Files](#files)

## How the market works

Everything below was measured on the live public API, not taken from documentation.

- **One stock per contestant**, quoted in cents of Cx Bucks, opening at 10.00.
- **Constant-product pool (AMM)**: each stock starts with about 10,000 Cx of cash reserve. The price moves with every
  trade, and a buy of size `c` moves the price by roughly `2c / R`, where `R` is the cash reserve. Small pools mean
  your own orders move the price against you.
- **Fees: 1.5% per side**, so a round trip must gain about 3% plus price impact just to break even.
- **Deaths**: when a contestant dies in the game, the server knocks their stock down about 20%, 30 s to 2 min after
  the death. Dead contestants get `eliminated_at` set and are settled about 4 hours later, after which the stock
  disappears from the public API.
- **Public data**:
  - `api.<host>/public/stock-market/` gives stocks, trades, candles, sparklines and your portfolio (`me`, with the
    session cookie).
  - `event-public.<host>/event/map-snapshot` gives the live map: safe zones, graves and contestant health.
- **Rate limit**: bursts of about 6 requests/s get the IP blocked (`403 {"error":"Blocked"}`) for several minutes.

## What the engine does

Every 5 s it checks its positions, every 10 s it reads the map, every 15 s it scans the market.

**Entries**, each a separate strategy, tagged by the first word of the buy reason in the log:

| Strategy | Trigger | Exit |
|---|---|---|
| `crash` | a stock drops 25% or more between two scans (15 s) with no pump in the 3 min before; 5 min cooldown after any exit on that stock (30 min for the other strategies) | after 10 min |
| `surv` | 20 s after a new death, buy the 2 highest-priced live contestants | after 30 min |
| `mom` | momentum, only while at least 60% of the market is rising together | 20% trail or 10 min |
| `top` | every hour, hold the 10 highest-priced live contestants (traded in the last 30 min), 15% of cash each, capped at 1.5% of the pool reserve | when the rank reaches 20, or death |

`top` is the only steady earner measured so far: on the 18/10 evening tape (21:00 to 03:00 UTC, deaths sold at the
knocked-down price) it made +404 Cx from 866, positive in both halves, in 14 buys. Frequent entries (dips of 10 to
20%, dips in an uptrend, breakouts) all lost 2 to 10% per trade after fees on the same tape.

**Exits that apply on top**:

- **Run mode**: a rebound or survivor buy that gains 10% switches to a 15% trailing stop from its peak, held up to
  2 hours, instead of the fixed exit time.
- **Death**: sell as soon as the contestant dies (map grave, health feed or roster `eliminated_at`), before the -20%
  impulse lands. Known deaths are reloaded from `data/deaths.jsonl` at start, because the map can black out (an
  in-game "EMP" hides graves and health for about 30 min).
- **Low health**: sell when the contestant drops under 25% of max HP. Never buy under 40% HP or outside the zone.
- **Dump**: sell when a single sell knocks the price down 5% or more while the market is weak.

**Guard rails**:

- Each strategy switches itself off after 10 round trips if their total is negative (Telegram alert). The re-tuning
  switches it back on when the setting it would trade wins again in both halves of its window (at least 8 trades);
  the 10-round-trip count then starts over.
- Rebound and survivor orders are capped at `maxImpact` (1.5%) of the pool's cash reserve. On the 18/10 tape the crash
  entries made +160 Cx at 0.75%, +248 at 1.5%; beyond 2% the own impact eats the rebound.
- At most 6 positions, with a 30 min cooldown before re-entering a stock.
- Positions you open yourself are managed too, but never on a timer: 15% trailing stop, plus the death, low-health
  and dump exits. When you hold the same stock as the engine, it only sells its own shares.
- **Self-tuning**, at start and every 2 hours, on the last 6 hours of tape for momentum and 24 hours for crash and
  survivors (rare events, and their replay is cheap):
  - momentum: adopts new parameters only if they beat the current ones by a clear margin over at least 10 trades;
  - crash rebound and run mode (`crashDrop`, `crashFlat`, `dipHold`, `runStart`, `runTrail`): 162 combinations
    replayed exactly as traded, adopted only with at least 8 trades, a profit in both halves of the window, and a
    clear margin over the current set;
  - survivors (`survTop`, `survHold`): replayed on the logged deaths. With no setting profitable in both halves and
    a losing current one, it sets `survTop` to 0 (strategy off), and switches it back on when a setting wins again;
  - top basket (`topN`, `topExit`, `topReb`): same rule in Cx, `topN` 0 is off.

  Picking the best of many combinations on a small sample overfits. The kill switches are the safety net.
- `params.json` is hot-reloaded every 30 s: edit it instead of restarting. A restart costs about a minute, which is
  enough to miss a signal.

**Data it records for later analysis** (all in `data/`, git-ignored):

| File | Content |
|---|---|
| `tape-YYYY-MM-DD.jsonl` | every public trade: stock, time, price before/after, side, size, anonymous user id |
| `deaths.jsonl` | deaths read from the map |
| `health.jsonl` | every HP change: `username, hp, max, alive, out` (never positions) |
| `settled.jsonl` | last known price and status of an eliminated stock when it disappears from the API, to find out what settlement pays |

## What was measured

All numbers come from the recorded public trade tape (about 30,000 trades over the first hours), net of fees and of
the engine's own price impact. Each rule was split into two halves of the period and kept only if it held in both.

- **Momentum** paid only during the opening rush (+21% average). Afterwards it lost money at every setting.
- **Chasing a pump loses**, even when buying 2 s after the pump trade: -4% to -17% on average. The pumper sells into
  the buyers who follow.
- **Copying the most profitable wallets** lost 10%: they are the pumpers.
- **Buying all survivors after a death** lost money (-2% to -6%).
- **A sharp drop with no pump before it** (a large holder leaving) rebounded: +11.5% and +9.3% at 10 min, but on
  few cases.
- **The market as a whole drifts down**: holding any stock for 30 min lost 1.4% to 5% on average. Trading less is
  part of the strategy.
- **Faster is not always better**: scanning for crashes every 5 s instead of 15 s caught more of them but earned less
  (+39% vs +56% summed on the first half), because it buys mid-fall, before the low.
- **Adding to winners lost**: buying a second tranche when a position turns into a run returned -2.2% and -1.9% on
  that tranche in the two halves. The run itself pays, the late entry does not.
- **Live results of the late game**: the survivor trial made +81 Cx over 6 round trips (2 winners: +24% and +53%,
  ridden in run mode), crash/dip rebounds +20 Cx over 9.

All these samples are small (often under 20 cases). Treat every number as a hint, not a law.

## Setup

Requirements: Windows (the scheduled task script is Windows-only; the engine itself is plain Node), Node.js 22 or
later, and optionally Python 3 with `curl_cffi` for Kick chat announcements.

```powershell
git clone <this repo> safezone-stocks
cd safezone-stocks
npm install
npx playwright install chromium
copy .env.example .env
# edit .env: set SITE_HOST to the event site's domain, END_AT, and Telegram if you want alerts
pip install -r requirements.txt   # only for Kick chat announcements
```

Then log in, using one of two options:

- **Option A, browser login**: `node engine.mjs --login` opens a browser window. Log in to the event site, then close
  the window. The session is kept in `profile/`.
- **Option B, cookie import**: see the tutorial below. Use it on a headless machine, or to enable Kick announcements.

## Tutorial: import your cookies with EditThisCookie

`import-cookies.mjs` takes a raw EditThisCookie export and keeps only what the engine needs. Paste everything, it does
the sorting:

| Cookie | Kept as | Used for |
|---|---|---|
| `kick.com` `session_token` | `KICK_BEARER` in `.env` (URL-decoded) | posting trade announcements in Kick chat |
| `<SITE_HOST>` `token`, `token_scope` | `.session.json`, loaded into `profile/` at next start, then deleted | trading on your account |
| anything else (`__cf_bm`, `_cfuvid`, `__stripe_*`, `KP_UIDz`, consent...) | dropped | |

Steps:

1. Install the **EditThisCookie** extension in your browser.
2. Log in to the site whose cookies you need: `kick.com` for announcements, the event site for trading.
3. On that site, click the EditThisCookie icon, then **Export**. The cookies are copied to your clipboard as a JSON
   array.
4. In the project folder, run one of:

   ```powershell
   Get-Clipboard | node import-cookies.mjs
   ```

   or paste the export into a file `cookies.json` (ignored by git) and run `node import-cookies.mjs cookies.json`.
5. The script prints which cookies it kept and how many it dropped. It never prints values.
6. Restart the engine (see below). Delete `cookies.json` if you used a file.

You can export from both sites and run the import twice. Each run only replaces what it finds.

**Your session cookies are your account.** Never paste them in a chat, an issue or a screenshot. If you leaked one,
log out of that site: logging out invalidates the session.

## Running it

```powershell
node engine.mjs --dry    # scans and logs what it would do, no orders
node engine.mjs          # live
```

To keep it running unattended (restart on crash, survives logoff), register the scheduled task once, from an
elevated PowerShell in the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1
```

Restart after a change (no admin rights needed):

```powershell
Stop-ScheduledTask SafezoneStocks; Start-ScheduledTask SafezoneStocks
```

The task starts 1 minute after you log in to Windows. The PC must stay awake: sleep pauses the engine. The engine
exits for good after `END_AT`.

Self-healing: the process the task starts is a supervisor that runs the engine as a child and restarts it whenever
it dies (10 s after a long run, backing off to 10 min in a crash loop). The engine exits on purpose, to be restarted,
when nothing worked for 5 minutes outside an API block, or when the session stays lost for 3 minutes (a profile
reopened by a fresh process gets its cookie back). Stopping the task stops both.

## Monitoring

- `node status.mjs` prints recent deaths, market breadth, trade count, API blocks and the PnL of each strategy, from
  local files only.
- `trades.jsonl` is the event log, one JSON object per line. Useful events:

| Event | Meaning |
|---|---|
| `start`, `profile_retry` | engine started; it waited for the old process to release the browser profile |
| `stock-market/buy`, `stock-market/sell` | orders, with `why` (strategy or exit reason) and the server response |
| `kick_say` | chat announcement result (`FOLLOWERS_ONLY_ERROR` means the chat only accepts followers) |
| `auth_lost` | the site session expired: log in again |
| `blocked` | rate limited, the engine pauses itself |
| `restart`, `watchdog` | the supervisor restarted a dead engine (exit code, wait); the engine found itself stuck |
| `crash_off`, `surv_off` | a strategy switched itself off |
| `crash_on`, `surv_on` | the re-tuning switched it back on |
| `hp_feed` | the map's health feed appeared or went silent (frame headers, for diagnosis) |
| `tune` | parameter re-tuning result |

- Telegram, if configured: lost session, long API block, strategy switched off, new parameters, daily PnL.

## Backtesting and self-check

- `node backtest.mjs [hours]` replays the recorded tape (`data/tape-*.jsonl`, written by the engine every 3 min)
  through the momentum rules on a parameter grid.
- `node check.mjs` must print `check ok` after any change. It checks:
  - the reference PnL on the frozen fixture `data/opening-17-10.jsonl`;
  - the re-tuning guard rails and the breadth gate;
  - the dump exit;
  - the chat message format;
  - the health decoder;
  - the cookie sorter;
  - the kill-switch tally (counted from the last re-arm) and the watchdog's stuck rule.

  Each check has a control case that must fail.

## Safety rules built in

- **One request queue at 2.5 requests/s**, with back-off from 2 to 30 minutes on a block. Do not add code that calls
  the API outside `api()`.
- **Position frames are never decoded.** The map's binary feed carries live GPS positions of real people. Only the
  health frame (kind 2) is read, and only `username -> hp, alive`.
- **The engine never stores or prints credentials.** The site session lives in the browser profile. The Kick bearer
  is read from `.env`.
- **Recorded market data stays local**: it contains other players' ids. `data/` is git-ignored except the anonymized
  fixture.

## Files

| File | Role |
|---|---|
| `engine.mjs` | the engine |
| `backtest.mjs` | tape loading, simulator, re-tuning, chat text, health decoder |
| `check.mjs` | self-check |
| `status.mjs` | one-screen status from local files |
| `import-cookies.mjs` | EditThisCookie import |
| `kick_say.py` | posts one chat line (Python, because Kick blocks Node's TLS fingerprint) |
| `scripts/register-task.ps1` | Windows scheduled task |
| `.env.example` | configuration template |
