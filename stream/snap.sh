#!/bin/sh
# One PNG per stream page, drawn by ffmpeg with run.sh's own filters, from the files the live stream is drawing.
# Leaves the live stream alone and nothing on the server but /tmp/szsnap. From the PC (README screenshots):
#   ssh oracle sh -s < stream/snap.sh && scp 'oracle:/tmp/szsnap/*.png' docs/screenshots/
set -e
S=~/szdash; O=/tmp/szsnap
rm -rf $O; mkdir -p $O
# run.sh's font and filter lines, evaluated as they are, so a screenshot is exactly what viewers see
eval "$(sed -n '/^F=/,/textfile=ticker.txt/p' $S/run.sh)"
n=$(head -1 $S/c.txt | sed -n 's#^ *[0-9]*/\([0-9]*\).*#\1#p')
for k in $(seq 1 "$n"); do
  w=0; until head -1 $S/c.txt | grep -q "^ *$k/$n "; do w=$((w + 1)); [ $w -gt 150 ] && { echo "page $k/$n never showed"; exit 1; }; sleep 1; done
  sleep 1 # a page's layers are replaced together at @@end: one second later all of them are this page's
  mkdir -p $O/p$k && cp $S/*.txt $O/p$k/
  # 6 s of frames: the ticker has scrolled in and the profit line pulses; the last frame is kept
  (cd $O/p$k && ffmpeg -nostdin -loglevel error -f lavfi -i color=c=0x0b0e14:s=$SIZE:r=8:d=6 -vf "$VF" -update 1 -y ../page$k.png)
  echo "page $k/$n: $(head -1 $S/c.txt | tr -s ' ' | cut -c1-60)"
done
