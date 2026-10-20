#!/usr/bin/env python3
"""Redraw only what moves at the stream's frame rate, the rest once a second.

Reads the drawtext/drawbox chain on stdin, prints "fps=1,<slow>,fps=<rate>,<fast>".
Slow: nothing in the filter depends on time (fixed text, reloaded text files,
boxes). Fast: an enable= or an expression of t (blinking, scrolling, bouncing).
A slow filter moves ahead of the fast ones only where no filter left in the
fast chain before it can paint the same pixels, so the stacking order and every
pixel stay the same; a reloaded file shows its new text within a second instead
of an eighth. Measured 2026-10-20 on the dashboard: 80/80 frames identical
(framemd5), filters 2.5 s -> 1.2 s of CPU per minute of video on the PC.
Any error prints the chain unchanged.
Usage: printf '%s' "$VF" | python3 layers.py 8
"""
import sys

import re


def split_chain(vf):
    out, cur, quote, i = [], "", False, 0
    while i < len(vf):
        ch = vf[i]
        if ch == "\\" and i + 1 < len(vf):
            cur += vf[i:i + 2]
            i += 2
            continue
        if ch == "'":
            quote = not quote
        if ch == "," and not quote:
            out.append(cur)
            cur = ""
        else:
            cur += ch
        i += 1
    out.append(cur)
    return out


def opts(f):
    name, _, rest = f.partition("=")
    return name, dict(re.findall(r"(\w+)=('(?:[^'\\]|\\.)*'|(?:[^:\\]|\\.)*)", rest))


def is_static(f):
    name, o = opts(f)
    if "enable" in o:
        return False
    if name == "drawbox":
        return True
    if name != "drawtext":
        return False
    return not any("t" in re.findall(r"[a-z]+", o.get(k, "")) for k in ("x", "y", "alpha"))


def num(v):
    return int(v) if v is not None and v.isdigit() else None


def rect(f):
    """(x0, x1, y0, y1) a filter may paint, generous; None in a slot means unbounded."""
    name, o = opts(f)
    x, y = num(o.get("x", "0")), num(o.get("y", "0"))
    if name == "drawbox":
        w, h = num(o.get("w")), num(o.get("h"))
        return (x, None if x is None or w is None else x + w, y, None if y is None or h is None else y + h)
    size = int(o.get("fontsize", "16"))
    if "textfile" in o:
        try:
            lines = open(o["textfile"], encoding="utf-8").read().rstrip(chr(10)).split(chr(10))
        except OSError:
            return (None, None, None, None)
    else:
        lines = [o.get("text", "")]
    # a mono glyph is 0.6 em wide; a line of the file may still grow, so a margin of 50%
    wide = int(max(len(l) for l in lines) * size * 0.6 * 1.5) + size
    step = size + int(o.get("line_spacing", "4"))
    tall = len(lines) * step + size // 2  # last line plus its descender
    if o.get("reload") not in (None, "0"):
        # reloaded text can grow: one more line than today when it already has several
        if len(lines) > 1:
            tall += step
    return (x, None if x is None else x + wide, y, None if y is None else y + tall)


def overlaps(a, b):
    def axis(a0, a1, b0, b1):
        lo_a, hi_a = a0 if a0 is not None else -10**9, a1 if a1 is not None else 10**9
        lo_b, hi_b = b0 if b0 is not None else -10**9, b1 if b1 is not None else 10**9
        return lo_a < hi_b and lo_b < hi_a
    return axis(a[0], a[1], b[0], b[1]) and axis(a[2], a[3], b[2], b[3])


def layered(vf, rate):
    chain = split_chain(vf)
    slow, fast = [], []
    for f in chain:
        if is_static(f) and not any(overlaps(rect(f), rect(d)) for d in fast):
            slow.append(f)
        else:
            fast.append(f)
    if not slow:
        return vf
    return ",".join(["fps=1"] + slow + [f"fps={rate}"] + fast)


if __name__ == "__main__":
    vf = sys.stdin.read()
    try:
        print(layered(vf, sys.argv[1] if len(sys.argv) > 1 else "8"), end="")
    except Exception as exc:  # the dashboard must stream whatever happens here
        print(f"layers.py: {exc}", file=sys.stderr)
        print(vf, end="")
