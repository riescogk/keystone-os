"""Turn a Word report into an ordered list of table-like objects (WTable) and a
full inventory of every other embedded graphic (so nothing is silently skipped)."""
from __future__ import annotations
import hashlib, io, re
from .docparse import WordDoc, page_locator, doc_page_count
from .emf import parse_emf, cluster_rows
from .model import WCell, WTable
from .normalize import clean, parse_num
from .rasterclass import classify

_SYMBOL_ONLY = re.compile(r'^[$€£(]+$')


def _merge_symbols(row):
    """Join lone currency symbols / parentheses / % fragments to their number."""
    out = []
    i = 0
    while i < len(row):
        f = row[i]
        t = f.text.strip()
        if _SYMBOL_ONLY.match(t) and i + 1 < len(row):
            n = row[i + 1]
            f2 = type(f)(t + ' ' + n.text, f.x0, n.x1, n.y, n.h, n.bold, n.italic, n.color, n.idx)
            f2.text = t + n.text
            out.append(f2); i += 2; continue
        if out and t in (')', '%', ')%') and f.x0 - out[-1].x1 < 0.6 * f.h:
            p = out[-1]; p.text = p.text + t; p.x1 = f.x1; i += 1; continue
        out.append(f); i += 1
    return out


def vector_rows(info):
    raw_rows = cluster_rows(info.frags)
    rows = []
    for ri, r in enumerate(raw_rows, 1):
        r = _merge_symbols(r)
        rows.append([WCell(f.text, f.x0, f.x1, f.y, f.h, ri, bold=f.bold) for f in r])
    return rows


def is_table_like(rows):
    n = len(rows)
    if n < 2: return False
    multi = sum(1 for r in rows if len(r) >= 2)
    cells = sum(len(r) for r in rows)
    return cells >= 4 and (multi >= 1 or n >= 4)


def _para_before(text, cp, maxlen=200):
    j = cp - 1
    # skip control chars and empty paragraphs
    parts = []
    while j >= 0 and len(parts) < 3:
        k = j
        while k >= 0 and text[k] not in '\r\x07\x0c': k -= 1
        seg = clean(re.sub(r'[\x00-\x08\x0b\x0e-\x1f]', ' ', text[k + 1:j + 1]))
        if seg and not seg.startswith('\x13') and len(re.sub(r'[^A-Za-z0-9]', '', seg)) > 2:
            parts.append(seg)
        j = k - 1
    if not parts: return ''
    return ('…' + parts[0][-maxlen:]) if len(parts[0]) > maxlen else parts[0]


def _para_after(text, cp, maxlen=200):
    j = cp + 1; n = len(text)
    while j < n and j < cp + 4000:
        k = j
        while k < n and text[k] not in '\r\x07\x0c': k += 1
        seg = clean(re.sub(r'[\x00-\x08\x0b\x0e-\x1f]', ' ', text[j:k]))
        if seg and len(re.sub(r'[^A-Za-z0-9]', '', seg)) > 2: return seg[:maxlen]
        j = k + 1
    return ''


def native_rows_to_cells(grid):
    """grid: list[list[(text, span, vmerge)]] -> WCell rows with synthetic geometry (column index based)."""
    rows = []
    for ri, row in enumerate(grid, 1):
        cells, col = [], 0
        for txt, span, vm in row:
            if txt and vm != 'continue':
                cells.append(WCell(txt, col * 100 + 2, (col + span) * 100 - 2, ri * 20, 12, ri))
            col += span
        if cells: rows.append(cells)
    for ri, r in enumerate(rows, 1):
        for c in r: c.row = ri
    return rows


def native_is_data_like(rows):
    cells = [c for r in rows for c in r]
    if len(rows) < 3 or len(cells) < 6: return False
    avg = sum(len(c.text) for c in cells) / len(cells)
    numeric = sum(1 for c in cells if parse_num(c.text) is not None) / len(cells)
    wide = sum(1 for r in rows if len(r) >= 2) / len(rows)
    return avg <= 45 and wide >= 0.6 and numeric >= 0.15


def inventory_doc(path, ocr=None, progress=None):
    if str(path).lower().endswith('.docx'): return inventory_docx(path, ocr)
    """Return (tables, others, info). tables: list[WTable]; others: list[dict] for
    every non-table graphic and for the narrative layout container."""
    d = WordDoc(path)
    locate = page_locator(d); total_pages = doc_page_count(d)
    pics = [p for p in d.pictures() if p.blob]
    tables, others = [], []
    seen_sha = {}
    order = 0
    items = []
    for p in pics: items.append((p.cp, 'pic', p))
    nts = d.native_tables()
    for t in nts: items.append((t.start_cp, 'native', t))
    items.sort(key=lambda x: x[0])
    for cp, kind, obj in items:
        if kind == 'native':
            ncell = sum(len(r) for r in obj.rows)
            chars = sum(len(c) for r in obj.rows for c in r)
            grid = [[(c, 1, None) for c in r] for r in obj.rows]
            nrows = native_rows_to_cells(grid)
            if native_is_data_like(nrows):
                order += 1
                tables.append(WTable(tid=f'T{order:03d}', kind='native', order=order, cp=cp, rows=nrows, sha='', before=_para_before(d.text, cp),
                                     after='', title=' '.join(c.text for c in nrows[0])[:120], meta={'source': 'native .doc table'}))
                continue
            others.append({'kind': 'native_layout_table', 'cp': cp, 'rows': len(obj.rows),
                           'cols': max((len(r) for r in obj.rows), default=0), 'cells': ncell,
                           'reason': 'Narrative/layout container (long text cells, little numeric content) - not tabular data; not compared.',
                           'characters': chars, 'first_text': (obj.rows[0][0] if obj.rows and obj.rows[0] else '')[:60]})
            continue
        p = obj
        sha = hashlib.sha256(p.blob).hexdigest()[:16]
        base = dict(cp=cp, pic_no=p.order, kind=p.kind, bytes=len(p.blob), sha=sha,
                    before=_para_before(d.text, cp), after=_para_after(d.text, cp))
        if p.kind == 'emf':
            info = parse_emf(p.blob)
            if info is None or not info.frags:
                others.append({**base, 'kind': 'emf_no_text', 'reason': 'Vector picture with no text (logo/figure/rule).'}); continue
            rows = vector_rows(info)
            if not is_table_like(rows):
                others.append({**base, 'kind': 'emf_text_not_table', 'reason': f'Vector picture with {sum(len(r) for r in rows)} text fragments in {len(rows)} line(s); not table-shaped.',
                               'text': ' | '.join(c.text for r in rows for c in r)[:160]}); continue
            order += 1
            t = WTable(tid=f'T{order:03d}', kind='vector', order=order, cp=cp, rows=rows, width=info.width, height=info.height,
                       sha=sha, before=base['before'], after=base['after'], title=' '.join(c.text for c in rows[0])[:120],
                       meta={'pic_no': p.order, 'frag_count': len(info.frags), 'blank_records': info.blank, 'bytes': len(p.blob)})
            if sha in seen_sha: t.duplicate_of = seen_sha[sha]
            else: seen_sha[sha] = t.tid
            tables.append(t)
        elif p.kind in ('png', 'jpeg', 'dib', 'tiff'):
            cl = classify(p.blob)
            base = {**base, 'classification': cl['label'], 'evidence': cl['evidence'], 'width_px': cl['evidence'].get('width'), 'height_px': cl['evidence'].get('height')}
            cat = cl['category']
            if cat == 'table_candidate':
                res = ocr(p, base) if ocr else None
                rows = res['rows'] if res and res.get('table') else []
                order += 1
                t = WTable(tid=f'T{order:03d}', kind='raster_ocr' if rows else 'raster_unread', order=order, cp=cp, rows=rows,
                           width=base.get('width_px') or 0, height=base.get('height_px') or 0, sha=sha, before=base['before'], after=base['after'],
                           title=(' '.join(c.text for c in rows[0])[:120] if rows else 'Table image (bitmap)'),
                           meta={'pic_no': p.order, 'ocr_mean_conf': (res or {}).get('conf'), 'bytes': len(p.blob), 'classification': cl['label'], 'evidence': cl['evidence'], 'thumb_blob': p.blob if len(p.blob) < 400000 else None})
                if sha in seen_sha: t.duplicate_of = seen_sha[sha]
                else: seen_sha[sha] = t.tid
                tables.append(t)
            else:
                others.append({**base, 'kind': 'bitmap_' + cat, 'needs_visual_check': cat in ('weak_table_candidate', 'unclassified'),
                               'reason': cl['label'] + (' (no table structure detected)' if cat != 'weak_table_candidate' else '')})
        else:
            others.append({**base, 'kind': 'unsupported_graphic', 'reason': f'{p.kind} graphic not examined.'})
    for t in tables:
        pg = locate(t.cp) if t.cp is not None else None
        if pg:
            if pg['page_max'] is None and total_pages and total_pages >= pg['page_min']: pg = dict(pg, page_max=total_pages, basis=pg['basis'] + '; upper bound = total pages saved in the file')
            t.meta['page'] = pg
    info = dict(pictures=len(pics), native_tables=len(nts), text_chars=len(d.text), total_pages=total_pages)
    return tables, others, info


def inventory_docx(path, ocr=None):
    from .docxparse import parse_docx
    items = parse_docx(path)
    tables, others, order, seen = [], [], 0, {}
    last_para = ''
    for idx, it in enumerate(items):
        if it[0] == 'para':
            if it[1]: last_para = it[1][-200:]
            continue
        after = next((x[1] for x in items[idx + 1:] if x[0] == 'para' and x[1]), '')[:200]
        if it[0] == 'table':
            rows = native_rows_to_cells(it[1])
            ncell = sum(len(r) for r in rows)
            if native_is_data_like(rows):
                order += 1
                tables.append(WTable(tid=f'T{order:03d}', kind='docx_native', order=order, cp=idx, rows=rows, before=last_para, after=after,
                                     title=' '.join(c.text for c in rows[0])[:120], meta={'source': 'native .docx table'}))
            else:
                others.append({'kind': 'native_layout_table', 'rows': len(it[1]), 'cols': max((len(r) for r in it[1]), default=0), 'cells': ncell,
                               'characters': sum(len(c[0]) for r in it[1] for c in r), 'first_text': '',
                               'reason': 'Not data-like (narrative/layout); not compared.', 'cp': idx})
        elif it[0] == 'pic':
            kind, blob = it[1], it[2]
            sha = hashlib.sha256(blob).hexdigest()[:16]
            base = dict(cp=idx, pic_no=idx, kind=kind, bytes=len(blob), sha=sha, before=last_para, after=after)
            if kind == 'emf':
                info = parse_emf(blob)
                if info is None or not info.frags: others.append({**base, 'kind': 'emf_no_text', 'reason': 'Vector picture with no text.'}); continue
                rows = vector_rows(info)
                if not is_table_like(rows): others.append({**base, 'kind': 'emf_text_not_table', 'reason': 'Vector picture, not table-shaped.'}); continue
                order += 1
                t = WTable(tid=f'T{order:03d}', kind='vector', order=order, cp=idx, rows=rows, width=info.width, height=info.height, sha=sha,
                           before=last_para, after=after, title=' '.join(c.text for c in rows[0])[:120], meta={'pic_no': idx, 'bytes': len(blob)})
                if sha in seen: t.duplicate_of = seen[sha]
                else: seen[sha] = t.tid
                tables.append(t)
            elif kind in ('png', 'jpeg'):
                cl = classify(blob)
                base = {**base, 'classification': cl['label'], 'evidence': cl['evidence']}
                if cl['category'] == 'table_candidate':
                    class _P: pass
                    pp = _P(); pp.blob = blob
                    res = ocr(pp, base) if ocr else None
                    rows = res['rows'] if res and res.get('table') else []
                    order += 1
                    t = WTable(tid=f'T{order:03d}', kind='raster_ocr' if rows else 'raster_unread', order=order, cp=idx, rows=rows,
                               width=cl['evidence'].get('width', 0), height=cl['evidence'].get('height', 0), sha=sha, before=last_para, after=after,
                               title=(' '.join(c.text for c in rows[0])[:120] if rows else 'Table image (bitmap)'),
                               meta={'pic_no': idx, 'classification': cl['label'], 'evidence': cl['evidence'], 'thumb_blob': blob if len(blob) < 400000 else None})
                    tables.append(t)
                else:
                    others.append({**base, 'kind': 'bitmap_' + cl['category'], 'needs_visual_check': cl['category'] in ('weak_table_candidate', 'unclassified'), 'reason': cl['label']})
            else:
                others.append({**base, 'kind': 'unsupported_graphic', 'reason': f'{kind} not examined.'})
    return tables, others, dict(pictures=sum(1 for i in items if i[0] == 'pic'), native_tables=sum(1 for i in items if i[0] == 'table'), text_chars=0)
