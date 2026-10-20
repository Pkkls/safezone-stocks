#!/bin/sh
# Stream the text dashboard to an RTMP(S) ingest, no browser: ffmpeg draws it and sends it, restarting 10 s after any
# drop. Layout (1920x1080, 8 fps): header (ASCII "CX" banner, title, blinking LIVE, total profit); 8 KPI tiles; the
# current page on the left (dash.txt and its color layers g/r/y/c.txt, a new page every 20 s); on the right the total
# value over 24 h, the CX mascot in its cowboy hat dancing on a disco floor with a speech bubble, and the bot log; a
# scrolling band of the other players' big trades, then a scrolling ticker at the bottom. The engine pushes every text (STREAM_SSH in .env); only the banner is static here.
# Sharp text: drawn natively at 1080p (18/10 it was 720p, upscaled by every viewer), x264 at constant quality (CRF 18,
# up to 4 Mb/s) instead of a 600 kb/s cap that smeared every glyph edge. Measured on 12 s of live content: 4x less
# encoding error (SSIM 0.9971 vs 0.9885), 29% of real time on the 2 cores.
# Setup: copy this folder to ~/szdash, put the full ingest URL + stream key in ~/szdash/url (chmod 600), then
# nohup sh ~/szdash/run.sh >/dev/null 2>&1 &   and the same line as a crontab @reboot.
cd "$(dirname "$0")" || exit 1
F=/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf
B=/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf
SIZE=1920x1080
ENC="-c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p -g 16 -crf 18 -maxrate 4000k -bufsize 8000k"
T="fontfile=$F:expansion=none"
R="$T:reload=1"
# header
VF="drawtext=$T:textfile=banner.txt:fontsize=20:fontcolor=0x39d0ff:line_spacing=0:x=36:y=12"
VF="$VF,drawtext=fontfile=$B:expansion=none:text=SAFEZONE STOCK BOT:fontsize=42:fontcolor=0xe6edf3:x=285:y=18"
VF="$VF,drawtext=$T:text=automated play money bot  -  Safe Zone  -  Austin TX:fontsize=22:fontcolor=0x7d8590:x=288:y=75"
VF="$VF,drawtext=fontfile=$B:expansion=none:text=LIVE:fontsize=33:fontcolor=0xff5c5c:x=w-135:y=33:enable='lt(mod(t\,1)\,0.6)'"
# profit: total PnL big and pulsing (green pg.txt / red pr.txt, one of them blank), realized/open under it
PG="fontfile=$B:expansion=none:reload=1:fontsize=48:x=1080:y=12:alpha='0.8+0.2*sin(t*3)'"
VF="$VF,drawtext=$PG:textfile=pg.txt:fontcolor=0x3fb950,drawtext=$PG:textfile=pr.txt:fontcolor=0xff6b6b"
VF="$VF,drawtext=$R:textfile=ps.txt:fontsize=22:fontcolor=0x9da7b3:x=1086:y=75"
VF="$VF,drawbox=x=0:y=126:w=iw:h=3:color=0x39d0ff@0.5:t=fill"
# KPI tiles: label here, value pushed (ka..kh.txt)
i=0
for L in VALUE "SINCE START" CASH INVESTED POSITIONS "TRIPS WON" ALIVE "EVENT ENDS IN"; do
  X=$((36 + i * 231)); K=$(printf "\\$(printf %o $((97 + i)))")
  VF="$VF,drawbox=x=$X:y=141:w=222:h=81:color=0x161b22:t=fill,drawbox=x=$X:y=141:w=222:h=3:color=0x39d0ff@0.6:t=fill"
  VF="$VF,drawtext=$T:text=$L:fontsize=18:fontcolor=0x7d8590:x=$((X + 15)):y=153"
  VF="$VF,drawtext=fontfile=$B:expansion=none:reload=1:textfile=k$K.txt:fontsize=33:fontcolor=0xe6edf3:x=$((X + 15)):y=180"
  i=$((i + 1))
done
# the page and its color layers, same grid (the engine pads them with spaces): gain, loss/danger, warning, titles
PAGE=":fontsize=22:line_spacing=8:x=36:y=243"
VF="$VF,drawtext=$R:textfile=dash.txt:fontcolor=0xe6edf3$PAGE,drawtext=$R:textfile=g.txt:fontcolor=0x3fb950$PAGE"
VF="$VF,drawtext=$R:textfile=r.txt:fontcolor=0xff6b6b$PAGE,drawtext=$R:textfile=y.txt:fontcolor=0xe3b341$PAGE"
VF="$VF,drawtext=$R:textfile=c.txt:fontcolor=0x39d0ff$PAGE"
# right panel: 24 h value chart
VF="$VF,drawbox=x=1314:y=234:w=2:h=708:color=0x30363d:t=fill"
VF="$VF,drawtext=$T:text=TOTAL VALUE  -  LAST 24 H:fontsize=20:fontcolor=0x39d0ff:x=1338:y=243"
EQ=":fontsize=21:line_spacing=0:x=1338:y=276"
VF="$VF,drawtext=$R:textfile=eqg.txt:fontcolor=0x3fb950$EQ,drawtext=$R:textfile=eqr.txt:fontcolor=0xff6b6b$EQ"
VF="$VF,drawtext=$R:textfile=eqb.txt:fontsize=18:fontcolor=0x9da7b3:x=1338:y=435"
# the CX mascot: 4 poses a second, bouncing; green when the portfolio is up, cyan when flat, red when down (the
# engine fills the files of the current mood and blanks the others)
for M in g:0x3fb950 c:0x39d0ff r:0xff6b6b; do
  j=0
  for P in a b c d; do
    VF="$VF,drawtext=$R:textfile=m${M%%:*}$P.txt:fontsize=26:fontcolor=${M#*:}:line_spacing=2:x=1344:y='483+15*abs(sin(t*5))':enable='eq(floor(mod(t*4\,4))\,$j)'"
    j=$((j + 1))
  done
done
VF="$VF,drawtext=$R:textfile=say.txt:fontsize=20:fontcolor=0xe6edf3:line_spacing=3:x=1569:y=495"
VF="$VF,drawtext=$T:text=CX DANCE FLOOR  -  AUSTIN TX:fontsize=18:fontcolor=0x7d8590:x=1569:y=693"
# disco floor: two tile patterns swapping twice a second
DF="fontsize=21:x=1338:y=729"
VF="$VF,drawtext=$T:text=#==#    #==#    #==#    #==#    #==#:fontcolor=0xff4fd8:$DF:enable='lt(mod(t\,1)\,0.5)'"
VF="$VF,drawtext=$T:text=    #==#    #==#    #==#    #==#    :fontcolor=0xe3b341:$DF:enable='gte(mod(t\,1)\,0.5)'"
# bot log, newest first, colored like the page
VF="$VF,drawtext=$T:text=BOT LOG (UTC):fontsize=20:fontcolor=0x39d0ff:x=1338:y=771"
LOG=":fontsize=20:line_spacing=4:x=1338:y=804"
VF="$VF,drawtext=$R:textfile=lw.txt:fontcolor=0xe6edf3$LOG,drawtext=$R:textfile=lg.txt:fontcolor=0x3fb950$LOG"
VF="$VF,drawtext=$R:textfile=lr.txt:fontcolor=0xff6b6b$LOG,drawtext=$R:textfile=ly.txt:fontcolor=0xe3b341$LOG"
# big trades band, on every page: other players' trades of 100 Cx or more, scrolling (white, BUY green, SELL red
# layers bw/bg/br.txt, same width), under a fixed label
VF="$VF,drawbox=x=0:y=952:w=iw:h=50:color=0x10151d:t=fill,drawbox=x=0:y=952:w=iw:h=2:color=0xe3b341@0.5:t=fill"
BT="fontsize=24:y=965:x='w-mod(t*120\,w+tw)'"
VF="$VF,drawtext=$R:textfile=bg.txt:fontcolor=0x3fb950:$BT,drawtext=$R:textfile=br.txt:fontcolor=0xff6b6b:$BT,drawtext=$R:textfile=bw.txt:fontcolor=0xe6edf3:$BT"
VF="$VF,drawbox=x=0:y=954:w=228:h=48:color=0x10151d:t=fill,drawbox=x=226:y=962:w=2:h=30:color=0xe3b341@0.6:t=fill"
VF="$VF,drawtext=fontfile=$B:expansion=none:text=BIG TRADES:fontsize=24:fontcolor=0xe3b341:x=36:y=965"
VF="$VF,drawbox=x=0:y=ih-72:w=iw:h=72:color=0x161b22:t=fill"
VF="$VF,drawtext=$R:textfile=ticker.txt:fontsize=30:fontcolor=0x3fb950:x='w-mod(t*165\,w+tw)':y=h-52"
while :; do
  if [ -s url ] && [ -s dash.txt ]; then
    [ -s ticker.txt ] || echo "CX STOCK BOT" > ticker.txt
    for f in g r y c pg pr ps ka kb kc kd ke kf kg kh eqg eqr eqb say lw lg lr ly mga mgb mgc mgd mca mcb mcc mcd mra mrb mrc mrd bw bg br; do
      [ -s $f.txt ] || echo " " > $f.txt
    done
    # shellcheck disable=SC2086 # ENC is a list of options
    # 2026-10-20: what does not move is drawn once a second, the rest 8 times (layers.py,
    # same pixels, half the filter CPU); any trouble there and the full chain runs as before
    VF_RUN=$(printf '%s' "$VF" | python3 layers.py 8 2>>err.log) || VF_RUN=
    [ -n "$VF_RUN" ] || VF_RUN=$VF
    ffmpeg -nostdin -loglevel error -re -f lavfi -i color=c=0x0b0e14:s=$SIZE:r=8 -f lavfi -i anullsrc=r=44100:cl=stereo \
      -vf "$VF_RUN" $ENC -c:a aac -b:a 64k -f flv "$(cat url)" 2>>err.log
  fi
  sleep 10
done
