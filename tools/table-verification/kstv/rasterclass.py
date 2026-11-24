"""Classify bitmap pictures (no OCR needed; Pillow only).

Categories: table_candidate | signature_or_logo | photo_or_map | chart_or_plan_or_other | undecodable
A 'table_candidate' is a text-dense, white-background image with many regular text rows -- the
signature of a screenshot of a table. Everything else is explicitly named, never silently skipped.
"""
from __future__ import annotations
import io

def _px(img):
    return list(img.get_flattened_data()) if hasattr(img, 'get_flattened_data') else list(img.getdata())


LABEL = {
    'table_candidate': 'Table (bitmap screenshot)',
    'weak_table_candidate': 'Possible table - looks like a chart; needs a visual check',
    'signature_or_logo': 'Signature / logo',
    'photo_or_map': 'Photo / aerial / map',
    'chart_or_plan_or_other': 'Chart / floor plan / other graphic',
    'undecodable': 'Could not be decoded',
}


def classify(blob: bytes):
    try:
        from PIL import Image
    except Exception:
        return dict(category='unclassified', label='Bitmap not classified (Pillow is not installed) - check visually', evidence={})
    try:
        im = Image.open(io.BytesIO(blob)); im.load()
    except Exception:
        return dict(category='undecodable', label=LABEL['undecodable'], evidence={})
    w, h = im.size
    rgb = im.convert('RGB')
    scale = 700 / w if w > 700 else 1.0
    small = rgb.resize((max(1, int(w * scale)), max(1, int(h * scale)))) if scale != 1 else rgb
    px = _px(small); n = len(px)
    white = sum(1 for r, g, b in px if min(r, g, b) > 225) / n
    sat = sum(1 for r, g, b in px if (max(r, g, b) - min(r, g, b)) > 60) / n
    bins = {}
    for r, g, b in px:
        k = (r >> 5, g >> 5, b >> 5); bins[k] = bins.get(k, 0) + 1
    colours = sum(1 for v in bins.values() if v / n > 0.004)
    # text-row structure on a grayscale view: a TEXT row alternates ink/gap many times with short ink runs;
    # gridlines (one long run) and chart bars (long runs) do not.
    g = small.convert('L'); gw, gh = g.size; gd = _px(g)
    runs = 0; inrun = False; text_rows_total = 0; longrun_rows = 0
    for y in range(gh):
        row = gd[y * gw:(y + 1) * gw]
        trans = 0; cur = 0; longest = 0; prev = False
        for v in row:
            ink_px = v < 150
            if ink_px:
                cur += 1
                if cur > longest: longest = cur
            else: cur = 0
            if ink_px != prev: trans += 1
            prev = ink_px
        is_text = trans >= 12 and longest <= 0.12 * gw
        if longest > 0.25 * gw: longrun_rows += 1
        if is_text and not inrun: runs += 1
        if is_text: text_rows_total += 1
        inrun = is_text
    ev = dict(width=w, height=h, white_fraction=round(white, 2), colourful_fraction=round(sat, 2), colours=colours, text_rows=runs, text_row_pixels=text_rows_total)
    ev_extra = {}
    if h <= 160 and w <= 320 and runs <= 4 and white > 0.8:
        cat = 'signature_or_logo'
    elif white < 0.45 or (sat > 0.45 and white < 0.7) or colours > 40 and white < 0.6:
        cat = 'photo_or_map'
    elif white >= 0.55 and runs >= 7 and w >= 400 and h >= 120 and sat < 0.12 and text_rows_total >= 0.12 * gh:
        # separate maps (large pastel areas) and charts (no grey row banding) from table screenshots
        sm = rgb.resize((300, max(1, int(h * 300 / w))))
        q = _px(sm); nq = len(q)
        tint = sum(1 for r, g2, b in q if 10 <= max(r, g2, b) - min(r, g2, b) <= 60 and max(r, g2, b) > 150) / nq
        grey = sum(1 for r, g2, b in q if max(r, g2, b) - min(r, g2, b) < 10 and 150 < max(r, g2, b) <= 235) / nq
        ev_extra = dict(pastel_tint=round(tint, 3), grey_banding=round(grey, 3))
        if tint >= 0.12: cat = 'photo_or_map'
        elif grey >= 0.045: cat = 'table_candidate'
        elif grey >= 0.012: cat = 'weak_table_candidate'
        else: cat = 'chart_or_plan_or_other'
        ev.update(ev_extra)
    else:
        cat = 'chart_or_plan_or_other'
    return dict(category=cat, label=LABEL[cat], evidence=ev)
