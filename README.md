# safezone-stocks

An unattended trading engine for the stock market of the SafeZone fan event: a 7-day IRL battle royale where every
contestant has a tradable stock priced in Cx Bucks, an event currency with no real-world value. It trades on its own,
protects positions you open by hand, tunes itself, announces its trades in Kick chat and streams its state live.

## The market (measured, not documented)

- One stock per contestant, opening at 10.00 Cx, in a constant-product pool with ~10,000 Cx of cash reserve `R`: a
  buy of `c` moves the price by ~`2c/R`, so your own orders move the price against you. Fees: 1.5% per side.
- A death knocks the stock ~20% down, 30 s to 2 min later. Eliminated stocks settle ~4 h later and vanish from the API.
- Data: `api.<host>/public/stock-market/` (stocks, trades, sparklines, your portfolio with the session cookie) and
  `event-public.<host>/event/map-snapshot` (graves, roster, contestant health).
- ~6 requests/s gets the IP blocked (`403 Blocked`); a 3rd order within ~2 s gets `429 RATELIMITED` (just retry).

## What the engine does

Positions every 5 s, map every 10 s, market every 15 s, one order per scan. The buy reason's first word names the strategy.

| Strategy | Buys | Sells |
|---|---|---|
| `top` | the 10 highest-priced live contestants (traded in the last 30 min), 15% of cash each | rank 20 or worse at the hourly check |
| `surv` | 20 s after a new death, the 2 highest-priced live contestants (at most 2 open) | after 30 min |
| `crash` | a drop of 25%+ between two scans with no pump in the 3 min before (logged as kind `dip`) | after 10 min |

- **Run mode**: a crash or survivor buy that gains 10% rides a 15% trail from its peak, up to 2 h, instead of its timer.
- **Every position**, including yours: sold at death (grave, health feed or roster), under 25% HP, at elimination or
  when the stock stops trading. Never bought under 40% HP, outside the zone or dead.
- **Your own positions**: 15% trail from the peak and a dump exit (a single sell of -5% or more), never a timer. When
  you hold the same stock as the engine, it only sells its own shares.
- **Guard rails**: rebound and survivor orders capped at 1.5% of the pool reserve; at most 6 non-basket positions; a
  30 min cooldown (5 min for crash); each strategy switches itself off after 10 round trips with a negative total.
- **Self-tuning**, at start and every 2 h, on the last 24 h of recorded tape: each strategy's settings are replayed
  exactly as traded and a new one is adopted only with 8+ trades, a profit in both halves of the window and a clear
  margin; a losing strategy with no winning setting is switched off, and back on when one wins again. Picking the best
  of many settings on a small sample overfits: the kill switches are the safety net. `params.json` is hot-reloaded.
- **Supervisor**: the scheduled task runs a parent process that restarts the engine if it crashes or hangs (no
  successful call for 5 min, or a session lost for 3 min).

### What was measured (net of fees and own impact, kept only if it held in both halves)

Momentum paid only in the opening rush and lost afterwards; chasing a pump loses even 2 s after it (-4% to -17%);
copying the best wallets lost 10% (they are the pumpers); the whole market drifts down (-1.4% to -5% per 30 min held);
scanning every 5 s instead of 15 s earned less (it buys mid-fall); adding to winners lost. What paid: the top basket
(+404 Cx from 866 on one evening, both halves positive) and crash rebounds with run mode. Small samples: hints, not laws.

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

The engine pushes a 90-column text dashboard over ssh every 10 s; `stream/run.sh` on a server has ffmpeg draw it
(`drawtext`), encode it and send it to the RTMP(S) ingest, restarting after any drop. Measured on a 1 GB VPS: 7% of a
core and 94 MB at 1280x720, 5 fps.

1. Server (ffmpeg + DejaVu fonts): copy `stream/run.sh` to `~/szdash/`, put the ingest URL and stream key in
   `~/szdash/url` (`chmod 600`), run `nohup sh ~/szdash/run.sh >/dev/null 2>&1 &` and add it as a crontab `@reboot`.
2. PC: `STREAM_SSH` (ssh host alias) in `.env`, plus `STREAM_SSH_BIN` if `ssh` is not on PATH. Restart the engine.

A frozen "data HH:MM:SS UTC" on the stream means the PC stopped pushing. `stream/check.sh <env file with TG_TOKEN and
TG_CHAT>`, run every 5 min from cron on the server, sends one Telegram message when the text is over 5 min old (engine
down, session lost or PC off) or ffmpeg is down, and one when it is back.

## Monitoring

`node status.mjs` prints deaths, breadth, trades and PnL per strategy from local files. `trades.jsonl` is the event
log: `start`, `restart`, `watchdog`, `stock-market/buy|sell` (with `why`), `kick_say`, `auth_lost` (log in again),
`blocked`, `<strategy>_off` / `_on`, `tune_crash|surv|top`, `params_reload`, `stream_err`, `save_err`. Telegram (optional):
lost session, long API block, strategy switched off or on, new params, daily PnL.

`node check.mjs` must print `check ok` after any change: replays, tuners, kill-switch tally, watchdog, health
decoder, chat and stream text, cookie sorter, each with a control case that must fail.

## Safety rules

- Every API call goes through one queue at 2.5 requests/s with back-off on a block.
- The map's binary feed carries live GPS positions of real people: only the health frame is decoded, never positions.
- No credential is stored or printed by the engine; recorded market data (`data/`, other players' ids) stays local.

## Files

`engine.mjs` the engine and supervisor · `backtest.mjs` replays, tuning, decoders, text · `check.mjs` self-check ·
`status.mjs` status · `import-cookies.mjs` cookie import · `kick_say.py` chat line (Python: Kick blocks Node's TLS
fingerprint) · `stream/run.sh` stream · `stream/check.sh` stream alert · `scripts/register-task.ps1` scheduled task · `.env.example` configuration.
