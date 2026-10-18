#!/bin/sh
# Stream the text dashboard to an RTMP(S) ingest, no browser: ffmpeg draws dash.txt (pushed every 10 s by the
# engine, STREAM_SSH in .env), encodes and sends it; restarts 10 s after any drop. ~40 MB RAM, a few % of a core.
# Setup on the streaming box: copy this folder to ~/szdash, put the full ingest URL + stream key in ~/szdash/url
# (chmod 600), then: nohup sh ~/szdash/run.sh >/dev/null 2>&1 &   and the same line as a crontab @reboot.
cd "$(dirname "$0")" || exit 1
F=/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf
while :; do
  if [ -s url ] && [ -s dash.txt ]; then
    ffmpeg -nostdin -loglevel error -re -f lavfi -i color=c=0x0b0e14:s=1280x720:r=5 -f lavfi -i anullsrc=r=44100:cl=stereo \
      -vf "drawtext=fontfile=$F:textfile=dash.txt:reload=1:expansion=none:fontsize=20:fontcolor=0xe6edf3:line_spacing=8:x=48:y=48" \
      -c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p -g 10 -b:v 500k -maxrate 500k -bufsize 1000k \
      -c:a aac -b:a 64k -f flv "$(cat url)" 2>>err.log
  fi
  sleep 10
done
