"""EMF (Excel "Copy as Picture") reader: text fragments with true geometry.

No rendering and nothing executed. Each EXTTEXTOUT record becomes a Fragment with
left/right extents (from the per-character advance array), font size and weight.
"""
from __future__ import annotations
import struct
from dataclasses import dataclass, field


@dataclass
class Frag:
    text: str
    x0: float
    x1: float
    y: float          # reference y (device units)
    h: float          # font height (abs)
    bold: bool = False
    italic: bool = False
    color: int = 0
    idx: int = 0      # record order

    @property
    def xc(self): return (self.x0 + self.x1) / 2


@dataclass
class EmfInfo:
    width: int
    height: int
    frags: list
    lines: list = field(default_factory=list)   # (x0,y0,x1,y1) from LINETO/rect fills
    fills: list = field(default_factory=list)   # filled rectangles (x0,y0,x1,y1)
    bitmaps: int = 0
    scaled: bool = False
    blank: int = 0          # whitespace-only text records (invisible)


def parse_emf(data: bytes, max_records=400000) -> EmfInfo | None:
    if len(data) < 88 or data[:4] != b'\x01\x00\x00\x00' or data[40:44] != b' EMF':
        return None
    bl, bt, br, bb = struct.unpack_from('<iiii', data, 8)
    info = EmfInfo(br - bl + 1, bb - bt + 1, [])
    fonts, objs = {}, {}
    cur_font = (0, False, False)
    ta = 0
    color = 0
    pos = 0; n = 0
    cur = (0, 0)
    org = (0, 0)
    stack = []
    while pos + 8 <= len(data) and n < max_records:
        t, s = struct.unpack_from('<II', data, pos)
        if s < 8 or pos + s > len(data): break
        body = data[pos + 8:pos + s]
        if t == 82 and len(body) >= 24:      # EXTCREATEFONTINDIRECTW
            ih = struct.unpack_from('<I', body, 0)[0]
            h, w, esc, ori, wt = struct.unpack_from('<iiiii', body, 4)
            it = body[24]
            fonts[ih] = (abs(h), wt >= 600, bool(it))
        elif t == 37:                         # SELECTOBJECT
            ih = struct.unpack_from('<I', body, 0)[0]
            if ih in fonts: cur_font = fonts[ih]
        elif t == 22: ta = struct.unpack_from('<I', body, 0)[0]
        elif t == 24: color = struct.unpack_from('<I', body, 0)[0]
        elif t == 33: stack.append((cur_font, ta, color))
        elif t == 34 and stack: cur_font, ta, color = stack.pop()
        elif t == 10: org = struct.unpack_from('<ii', body, 0)
        elif t in (35, 36): info.scaled = True
        elif t in (81, 80, 77, 76) : info.bitmaps += 1 if t != 76 else 0
        elif t in (83, 84) and len(body) >= 68:
            rx, ry, nch, off, opt = struct.unpack_from('<iiIII', body, 28)
            offdx = struct.unpack_from('<I', body, 64)[0]
            wide = t == 84
            if 0 < nch <= 5000 and off + nch * (2 if wide else 1) <= s:
                raw = data[pos + off:pos + off + nch * (2 if wide else 1)]
                txt = raw.decode('utf-16le' if wide else 'cp1252', 'replace')
                width = 0
                if offdx and offdx + 4 * nch <= s:
                    dx = struct.unpack_from(f'<{nch}i', data, pos + offdx)
                    width = sum(dx)
                if width <= 0: width = int(len(txt) * cur_font[0] * 0.5)
                h = cur_font[0] or 12
                al = ta & 6
                if al == 0: x0, x1 = rx, rx + width
                elif al == 2: x0, x1 = rx - width, rx
                else: x0, x1 = rx - width / 2, rx + width / 2
                if not txt.strip(): info.blank += 1
                if txt.strip():
                    info.frags.append(Frag(txt, x0 - org[0], x1 - org[0], ry - org[1], h, cur_font[1], cur_font[2], color, n))
        elif t == 76 and len(body) >= 64:       # BITBLT with PATCOPY/fill
            xd, yd, cx, cy = struct.unpack_from('<iiii', body, 16)
            info.fills.append((xd, yd, xd + cx, yd + cy))
        elif t == 27: cur = struct.unpack_from('<ii', body, 0)
        elif t == 54:
            x, y = struct.unpack_from('<ii', body, 0)
            info.lines.append((cur[0], cur[1], x, y)); cur = (x, y)
        pos += s; n += 1
        if t == 14: break
    return info


def cluster_rows(frags, tol=0.55):
    """Group fragments into visual rows by baseline/centre y."""
    rows = []
    for f in sorted(frags, key=lambda f: (f.y, f.x0)):
        if rows:
            last = rows[-1]
            ref = sum(g.y for g in last) / len(last)
            if abs(f.y - ref) <= max(2, tol * min(f.h, last[0].h)):
                last.append(f); continue
        rows.append([f])
    for r in rows: r.sort(key=lambda f: f.x0)
    return rows
