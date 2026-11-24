"""Optional OCR for bitmap tables (screenshots of tables saved as PNG/JPEG).

Requires Pillow + pytesseract + the Tesseract binary. If unavailable, bitmaps are listed as
'not examined' -- never silently ignored. OCR-derived cells are reported as needing visual
confirmation rather than as hard discrepancies.
"""
from __future__ import annotations
import hashlib, io, json, os
from .model import WCell


def make_ocr(cache_dir=None, min_conf=55):
    try:
        import pytesseract
        from PIL import Image
        pytesseract.get_tesseract_version()
    except Exception:
        return None
    if cache_dir: os.makedirs(cache_dir, exist_ok=True)

    def ocr(pic, base):
        sha = base['sha']
        cpath = os.path.join(cache_dir, sha + '.json') if cache_dir else None
        if cpath and os.path.exists(cpath):
            return _revive(json.load(open(cpath)))
        res = _run(pic, Image, pytesseract, min_conf)
        if cpath: json.dump(_dump(res), open(cpath, 'w'))
        return res
    return ocr


def _run(pic, Image, pytesseract, min_conf):
    try:
        im = Image.open(io.BytesIO(pic.blob)); im.load()
    except Exception:
        return dict(table=False, reason='Image could not be decoded.')
    w, h = im.size
    if w < 260 or h < 90: return dict(table=False, reason='Too small to be a table.')
    g = im.convert('L')
    small = g.resize((64, 64))
    px = list(small.getdata())
    white = sum(1 for p in px if p > 235) / len(px)
    if white < 0.30: return dict(table=False, reason='Photographic/colour-rich image (not a table).')
    scale = 2 if w < 1100 else 1
    big = g.resize((w * scale, h * scale)) if scale > 1 else g
    d = pytesseract.image_to_data(big, config='--psm 6', output_type=pytesseract.Output.DICT)
    lines = {}
    for i, t in enumerate(d['text']):
        t = t.strip()
        try: conf = float(d['conf'][i])
        except ValueError: continue
        if not t or conf < min_conf or not any(ch.isalnum() for ch in t): continue
        key = (d['block_num'][i], d['par_num'][i], d['line_num'][i])
        lines.setdefault(key, []).append((d['left'][i] / scale, d['top'][i] / scale, d['width'][i] / scale, d['height'][i] / scale, t, conf))
    rows = []
    for key in sorted(lines, key=lambda k: min(x[1] for x in lines[k])):
        ws = sorted(lines[key]); cells = []
        for x, y, ww, hh, t, c in ws:
            if cells and x - cells[-1]['x1'] <= 0.9 * max(hh, cells[-1]['h']):
                cells[-1]['t'] += ' ' + t; cells[-1]['x1'] = x + ww; cells[-1]['c'].append(c)
            else: cells.append(dict(t=t, x0=x, x1=x + ww, y=y, h=hh, c=[c]))
        rows.append(cells)
    ncell = sum(len(r) for r in rows)
    multi = sum(1 for r in rows if len(r) >= 2)
    numeric = sum(1 for r in rows for c in r if any(ch.isdigit() for ch in c['t']))
    if len(rows) < 4 or multi < 0.5 * len(rows) or ncell < 10 or numeric < 0.2 * ncell:
        return dict(table=False, reason=f'Bitmap with {ncell} OCR text cells in {len(rows)} lines; no table structure.')
    out = []
    for ri, r in enumerate(rows, 1):
        out.append([WCell(c['t'], c['x0'], c['x1'], c['y'], c['h'], ri) for c in r])
    conf = sum(sum(c['c']) / len(c['c']) for r in rows for c in r) / ncell
    return dict(table=True, rows=out, w=w, h=h, conf=round(conf, 1))


def _dump(res):
    if not res.get('table'): return res
    return dict(res, rows=[[dict(t=c.text, x0=c.x0, x1=c.x1, y=c.y, h=c.h) for c in r] for r in res['rows']])


def _revive(res):
    if not res.get('table'): return res
    rows = [[WCell(c['t'], c['x0'], c['x1'], c['y'], c['h'], ri) for c in r] for ri, r in enumerate(res['rows'], 1)]
    return dict(res, rows=rows)
