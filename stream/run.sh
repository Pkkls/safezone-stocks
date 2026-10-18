#!/bin/sh
# Stream the text dashboard to an RTMP(S) ingest, no browser: ffmpeg draws it and sends it, restarting 10 s after any
# drop. Layout (1280x720, 8 fps): ASCII "CX" banner and a blinking LIVE tag; the current page (dash.txt, pushed every
# 10 s by the engine, STREAM_SSH in .env) on the left; a dancing ASCII mascot on the right (4 poses, 4 per second,
# bouncing); a scrolling ticker at the bottom (ticker.txt, pushed with the page).
# Setup: copy this folder to ~/szdash, put the full ingest URL + stream key in ~/szdash/url (chmod 600), then
# nohup sh ~/szdash/run.sh >/dev/null 2>&1 &   and the same line as a crontab @reboot.
cd "$(dirname "$0")" || exit 1
F=/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf
B=/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf
T="fontfile=$F:expansion=none"
DANCE=""
for i in 1 2 3 4; do
  DANCE="$DANCE,drawtext=$T:textfile=dance$i.txt:fontsize=24:fontcolor=0x39d0ff:line_spacing=2:x=1045:y='190+12*abs(sin(t*5))':enable='eq(floor(mod(t*4\,4))\,$((i - 1)))'"
done
VF="drawtext=$T:textfile=banner.txt:fontsize=16:fontcolor=0x39d0ff:line_spacing=0:x=40:y=12"
VF="$VF,drawtext=fontfile=$B:expansion=none:text=SAFEZONE STOCK BOT:fontsize=30:fontcolor=0xe6edf3:x=230:y=16"
VF="$VF,drawtext=$T:text=play money  -  automated trading  -  powered by CX:fontsize=16:fontcolor=0x7d8590:x=232:y=56"
VF="$VF,drawtext=fontfile=$B:expansion=none:text=LIVE:fontsize=22:fontcolor=0xff5c5c:x=w-110:y=22:enable='lt(mod(t\,1)\,0.6)'"
VF="$VF,drawbox=x=0:y=96:w=iw:h=2:color=0x39d0ff@0.5:t=fill"
PAGE=":reload=1:fontsize=17:line_spacing=6:x=40:y=112"
VF="$VF,drawtext=$T:textfile=dash.txt:fontcolor=0xe6edf3$PAGE"
# color layers, same grid as dash.txt (the engine pads them with spaces): gain, loss/danger, warning/shield, titles
VF="$VF,drawtext=$T:textfile=g.txt:fontcolor=0x3fb950$PAGE,drawtext=$T:textfile=r.txt:fontcolor=0xff6b6b$PAGE"
VF="$VF,drawtext=$T:textfile=y.txt:fontcolor=0xe3b341$PAGE,drawtext=$T:textfile=c.txt:fontcolor=0x39d0ff$PAGE$DANCE"
VF="$VF,drawtext=$T:text=CX DANCE FLOOR:fontsize=16:fontcolor=0x7d8590:x=1075:y=150"
# the current page's ASCII art (art.txt, pushed with the page), floating slowly under the mascot
VF="$VF,drawtext=$T:textfile=art.txt:reload=1:fontsize=17:fontcolor=0xe3b341:line_spacing=2:x=1050:y='430+5*sin(t*1.5)'"
VF="$VF,drawbox=x=0:y=ih-48:w=iw:h=48:color=0x161b22:t=fill"
VF="$VF,drawtext=$T:textfile=ticker.txt:reload=1:fontsize=20:fontcolor=0x3fb950:x='w-mod(t*110\,w+tw)':y=h-35"
while :; do
  if [ -s url ] && [ -s dash.txt ]; then
    [ -s ticker.txt ] || echo "CX STOCK BOT" > ticker.txt
    for f in g r y c art; do [ -s $f.txt ] || echo " " > $f.txt; done
    ffmpeg -nostdin -loglevel error -re -f lavfi -i color=c=0x0b0e14:s=1280x720:r=8 -f lavfi -i anullsrc=r=44100:cl=stereo \
      -vf "$VF" -c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p -g 16 -b:v 600k -maxrate 600k -bufsize 1200k \
      -c:a aac -b:a 64k -f flv "$(cat url)" 2>>err.log
  fi
  sleep 10
done
