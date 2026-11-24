"""Region-aware merging of stacked Word line fragments into one logical cell.

Excel draws explicit multi-line cells and auto-wrapped text as separate text
records, and clips wrapped text to the row height. We merge stacked fragments ONLY
when a cell inside the already-located Excel region has exactly (multi-line) or
as a visible prefix of (clipped wrapped text >= 20 chars) the concatenated lines.
"""
from __future__ import annotations
from .normalize import text_key, key_of


def _aligned(a, b, tol=None):
    tol = tol if tol is not None else max(5.0, 0.4 * max(a.h, b.h))
    return abs(a.x0 - b.x0) <= tol or abs(a.x1 - b.x1) <= tol or abs(a.xc - b.xc) <= tol


def region_texts(index, sheet, lo, hi, margin=3):
    out = set()
    sh = index.wb.sheet(sheet)
    rows = index.rows[sheet]
    for r in range(max(1, lo - margin), hi + margin + 1):
        for e in rows.get(r, ()):
            v = e.cell.v
            if not isinstance(v, str): continue
            d = str(e.disp)
            k = text_key(d)
            if '\n' in d or '\r' in d:
                lines = [text_key(x) for x in d.replace('\r', '\n').split('\n') if text_key(x)]
                out.add((k, 'multi', tuple(lines)))
            elif e.cell.wrap and len(k) >= 3 or len(k) >= 20:
                out.add((k, 'long', ()))
    return out


def premerge(table, index, sheet, lo, hi, fuse=True):
    texts = region_texts(index, sheet, lo, hi)
    if not texts: return 0
    exact = {k for k, kind, _ in texts}
    longs = [k for k, kind, _ in texts if kind == 'long']
    rows = table.rows
    consumed = set()
    spans = []
    merged = 0
    for i, row in enumerate(rows):
        for wi, f in enumerate(row):
            if (i, wi) in consumed: continue
            k0 = text_key(f.text)
            if not k0: continue
            starts_multi = [k for k, kind, _ in texts if kind == 'multi' and k.startswith(k0) and len(k) > len(k0)]
            starts_long = [k for k in longs if k.startswith(k0) and len(k) > len(k0)]
            if not starts_multi and not starts_long: continue
            acc = k0; chain = [(i, wi)]; cur = f
            for nr in range(i + 1, min(len(rows), i + 14)):
                nxt = None
                for k, g in enumerate(rows[nr]):
                    if (nr, k) in consumed: continue
                    if _aligned(cur, g) and 0 < g.y - cur.y < 3.2 * max(cur.h, 8):
                        a2 = acc + text_key(g.text)
                        if any(c.startswith(a2) for c in starts_multi + starts_long):   # must actually continue the Excel text
                            nxt = (nr, k, g); break
                if not nxt:
                    if rows[nr] and rows[nr][0].y - cur.y > 3.2 * max(cur.h, 8): break
                    continue
                acc2 = acc + text_key(nxt[2].text)
                acc = acc2; chain.append((nxt[0], nxt[1])); cur = nxt[2]
                if acc in starts_multi or acc in starts_long: break
            ok = False
            if len(chain) > 1:
                if acc in starts_multi: ok = True                      # whole explicit multi-line cell
                elif acc in starts_long or (any(c.startswith(acc) for c in starts_long) and len(acc) >= 12): ok = True  # wrapped (exact) / clipped (prefix)
            if ok:
                cells = [rows[a][b] for a, b in chain]
                f.parts = [c.text for c in cells]
                f.text = ' '.join(c.text for c in cells)
                f.key = key_of(f.text)
                f.x0 = min(c.x0 for c in cells); f.x1 = max(c.x1 for c in cells)
                f.merged_lines = len(cells)
                for a, b in chain[1:]: consumed.add((a, b))
                spans.append((min(a for a, _ in chain), max(a for a, _ in chain)))
                merged += 1
    if consumed:
        # rows spanned by one merged cell are ONE tall Excel row -> fuse them
        parent = list(range(len(rows)))
        def find(x):
            while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
            return x
        for a, b in spans:
            if not fuse: break
            for k in range(a + 1, b + 1): parent[find(k)] = find(a)
        groups = {}
        for i, row in enumerate(rows):
            kept = [c for wi, c in enumerate(row) if (i, wi) not in consumed]
            groups.setdefault(find(i), []).extend(kept)
        new = []
        for g in sorted(groups):
            r = sorted(groups[g], key=lambda c: (c.x0, c.y))
            if r: new.append(r)
        for ri, r in enumerate(new, 1):
            for c in r: c.row = ri
        table.rows = new
    table.meta['premerged_cells'] = merged
    return merged
