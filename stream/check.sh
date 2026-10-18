#!/bin/sh
# Health check for the stream box, every 5 min from cron: alert on Telegram when the dashboard text is older than
# 5 min (engine down, session lost or PC off) or ffmpeg is not running, and once more when it is back. One message per
# change of state. Telegram: TG_TOKEN / TG_CHAT read from the env file given as $1 (never printed).
cd "$(dirname "$0")" || exit 1
age=$(( $(date +%s) - $(stat -c %Y dash.txt 2>/dev/null || echo 0) ))
bad=""
[ "$age" -gt 300 ] && bad="dashboard data ${age}s old (engine down or PC off)"
[ -s url ] && ! pgrep -f "^ffmpeg.*textfile=dash.txt" >/dev/null && bad="${bad:+$bad, }ffmpeg not running"
now=${bad:-ok}
[ "$now" = "$(cat check.state 2>/dev/null)" ] && exit 0
echo "$now" > check.state
tok=$(sed -n 's/^TG_TOKEN=//p' "$1" | tail -n 1); chat=$(sed -n 's/^TG_CHAT=//p' "$1" | tail -n 1)
curl -s -m 20 "https://api.telegram.org/bot$tok/sendMessage" --data-urlencode "chat_id=$chat" --data-urlencode "text=[safezone-stream] ${bad:-back to normal}" >/dev/null
echo "$(date -u +%FT%TZ) $now" >> check.log
