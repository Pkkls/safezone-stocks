#!/bin/sh
# Stream the text dashboard to an RTMP(S) ingest, no browser: ffmpeg draws it and sends it, restarting 10 s after any
# drop. Layout (1280x720, 8 fps): header (ASCII "CX" banner, title, blinking LIVE, total profit); 8 KPI tiles; the
# current page on the left (dash.txt and its color layers g/r/y/c.txt, a new page every 20 s); on the right the total
# value over 24 h, the CX mascot in its cowboy hat dancing on a disco floor with a speech bubble, and the bot log; a
# scrolling ticker at the bottom. The engine pushes every text (STREAM_SSH in .env); only the banner is static here.
# Setup: copy this folder to ~/szdash, put the full ingest URL + stream key in ~/szdash/url (chmod 600), then
# nohup sh ~/szdash/run.sh >/dev/null 2>&1 &   and the same line as a crontab @reboot.
cd "$(dirname "$0")" || exit 1
F=/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf
B=/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf
T="fontfile=$F:expansion=none"
R="$T:reload=1"
# header
VF="drawtext=$T:textfile=banner.txt:fontsize=13:fontcolor=0x39d0ff:line_spacing=0:x=24:y=8"
VF="$VF,drawtext=fontfile=$B:expansion=none:text=SAFEZONE STOCK BOT:fontsize=28:fontcolor=0xe6edf3:x=190:y=12"
VF="$VF,drawtext=$T:text=play money  -  automated trading  -  Houston TX:fontsize=15:fontcolor=0x7d8590:x=192:y=50"
VF="$VF,drawtext=fontfile=$B:expansion=none:text=LIVE:fontsize=22:fontcolor=0xff5c5c:x=w-90:y=22:enable='lt(mod(t\,1)\,0.6)'"
# profit: total PnL big and pulsing (green pg.txt / red pr.txt, one of them blank), realized/open under it
PG="fontfile=$B:expansion=none:reload=1:fontsize=32:x=720:y=8:alpha='0.8+0.2*sin(t*3)'"
VF="$VF,drawtext=$PG:textfile=pg.txt:fontcolor=0x3fb950,drawtext=$PG:textfile=pr.txt:fontcolor=0xff6b6b"
VF="$VF,drawtext=$R:textfile=ps.txt:fontsize=15:fontcolor=0x9da7b3:x=724:y=50"
VF="$VF,drawbox=x=0:y=84:w=iw:h=2:color=0x39d0ff@0.5:t=fill"
# KPI tiles: label here, value pushed (ka..kh.txt)
i=0
for L in VALUE "SINCE START" CASH INVESTED POSITIONS "TRIPS WON" ALIVE "EVENT ENDS IN"; do
  X=$((24 + i * 154)); K=$(printf "\\$(printf %o $((97 + i)))")
  VF="$VF,drawbox=x=$X:y=94:w=148:h=54:color=0x161b22:t=fill,drawbox=x=$X:y=94:w=148:h=2:color=0x39d0ff@0.6:t=fill"
  VF="$VF,drawtext=$T:text=$L:fontsize=12:fontcolor=0x7d8590:x=$((X + 10)):y=102"
  VF="$VF,drawtext=fontfile=$B:expansion=none:reload=1:textfile=k$K.txt:fontsize=22:fontcolor=0xe6edf3:x=$((X + 10)):y=120"
  i=$((i + 1))
done
# the page and its color layers, same grid (the engine pads them with spaces): gain, loss/danger, warning, titles
PAGE=":fontsize=15:line_spacing=4:x=24:y=162"
VF="$VF,drawtext=$R:textfile=dash.txt:fontcolor=0xe6edf3$PAGE,drawtext=$R:textfile=g.txt:fontcolor=0x3fb950$PAGE"
VF="$VF,drawtext=$R:textfile=r.txt:fontcolor=0xff6b6b$PAGE,drawtext=$R:textfile=y.txt:fontcolor=0xe3b341$PAGE"
VF="$VF,drawtext=$R:textfile=c.txt:fontcolor=0x39d0ff$PAGE"
# right panel: 24 h value chart
VF="$VF,drawbox=x=876:y=156:w=1:h=506:color=0x30363d:t=fill"
VF="$VF,drawtext=$T:text=TOTAL VALUE  -  LAST 24 H:fontsize=13:fontcolor=0x39d0ff:x=892:y=162"
EQ=":fontsize=14:line_spacing=0:x=892:y=184"
VF="$VF,drawtext=$R:textfile=eqg.txt:fontcolor=0x3fb950$EQ,drawtext=$R:textfile=eqr.txt:fontcolor=0xff6b6b$EQ"
VF="$VF,drawtext=$R:textfile=eqb.txt:fontsize=12:fontcolor=0x9da7b3:x=892:y=290"
# the CX mascot: 4 poses a second, bouncing; green when the portfolio is up, cyan when flat, red when down (the
# engine fills the files of the current mood and blanks the others)
for M in g:0x3fb950 c:0x39d0ff r:0xff6b6b; do
  j=0
  for P in a b c d; do
    VF="$VF,drawtext=$R:textfile=m${M%%:*}$P.txt:fontsize=17:fontcolor=${M#*:}:line_spacing=1:x=896:y='322+10*abs(sin(t*5))':enable='eq(floor(mod(t*4\,4))\,$j)'"
    j=$((j + 1))
  done
done
VF="$VF,drawtext=$R:textfile=say.txt:fontsize=13:fontcolor=0xe6edf3:line_spacing=2:x=1046:y=330"
VF="$VF,drawtext=$T:text=CX DANCE FLOOR:fontsize=12:fontcolor=0x7d8590:x=1066:y=420"
VF="$VF,drawtext=$T:text=HOUSTON TX:fontsize=12:fontcolor=0x7d8590:x=1080:y=438"
# disco floor: two tile patterns swapping twice a second
DF="fontsize=14:x=892:y=486"
VF="$VF,drawtext=$T:text=#==#    #==#    #==#    #==#    #==#:fontcolor=0xff4fd8:$DF:enable='lt(mod(t\,1)\,0.5)'"
VF="$VF,drawtext=$T:text=    #==#    #==#    #==#    #==#    :fontcolor=0xe3b341:$DF:enable='gte(mod(t\,1)\,0.5)'"
# bot log, newest first, colored like the page
VF="$VF,drawtext=$T:text=BOT LOG (UTC):fontsize=13:fontcolor=0x39d0ff:x=892:y=514"
LOG=":fontsize=13:line_spacing=3:x=892:y=536"
VF="$VF,drawtext=$R:textfile=lw.txt:fontcolor=0xe6edf3$LOG,drawtext=$R:textfile=lg.txt:fontcolor=0x3fb950$LOG"
VF="$VF,drawtext=$R:textfile=lr.txt:fontcolor=0xff6b6b$LOG,drawtext=$R:textfile=ly.txt:fontcolor=0xe3b341$LOG"
VF="$VF,drawbox=x=0:y=ih-48:w=iw:h=48:color=0x161b22:t=fill"
VF="$VF,drawtext=$R:textfile=ticker.txt:fontsize=20:fontcolor=0x3fb950:x='w-mod(t*110\,w+tw)':y=h-35"
while :; do
  if [ -s url ] && [ -s dash.txt ]; then
    [ -s ticker.txt ] || echo "CX STOCK BOT" > ticker.txt
    for f in g r y c pg pr ps ka kb kc kd ke kf kg kh eqg eqr eqb say lw lg lr ly mga mgb mgc mgd mca mcb mcc mcd mra mrb mrc mrd; do
      [ -s $f.txt ] || echo " " > $f.txt
    done
    ffmpeg -nostdin -loglevel error -re -f lavfi -i color=c=0x0b0e14:s=1280x720:r=8 -f lavfi -i anullsrc=r=44100:cl=stereo \
      -vf "$VF" -c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p -g 16 -b:v 600k -maxrate 600k -bufsize 1200k \
      -c:a aac -b:a 64k -f flv "$(cat url)" 2>>err.log
  fi
  sleep 10
done
