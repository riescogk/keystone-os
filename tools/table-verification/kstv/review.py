"""Top-level review: Word report + Excel workbook -> table-by-table verification result."""
from __future__ import annotations
import hashlib, time, os
from collections import Counter, defaultdict
from .xlsx import Workbook, addr, col_letters
from .align import ExcelIndex
from .engine import analyze_table
from .wordtables import inventory_doc

OK_STATES = ('match', 'format_only')


def _jsonable(v):
    if isinstance(v, float) and v.is_integer(): return int(v)
    return v


def run_review(word_path, excel_path, ocr=None, progress=lambda *a: None):
    t0 = time.time()
    progress('Reading Word report…')
    tables, others, winfo = inventory_doc(word_path, ocr=ocr, progress=progress)
    progress('Reading Excel workbook…')
    wb = Workbook(excel_path).load_all()
    idx = ExcelIndex(wb)
    out_tables, findings_raw = [], []
    for n, tb in enumerate(tables, 1):
        progress(f'Comparing table {n} of {len(tables)}…')
        out_tables.append(_review_table(idx, tb))
    findings = _collect_findings(out_tables)
    summary = _summarize(out_tables, others, findings, winfo)
    summary['elapsed_seconds'] = round(time.time() - t0, 1)
    return dict(
        word_file=os.path.basename(word_path), excel_file=os.path.basename(excel_path),
        word_sha256=_sha(word_path), excel_sha256=_sha(excel_path),
        summary=summary, tables=out_tables, findings=findings, other_graphics=others,
        sheets=[dict(name=n, state=wb.sheet(n).state) for n in wb.names],
    )


def _sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for ch in iter(lambda: f.read(1 << 20), b''): h.update(ch)
    return h.hexdigest()


def _page_text(tb):
    pg = tb.meta.get('page')
    if not pg: return 'not available (no usable table of contents in this file; no page layout is stored in Word files)'
    lo, hi = pg['page_min'], pg['page_max']
    if hi is None: return f'page {lo} or later'
    if lo == hi: return f'page {lo}'
    return f'between pages {lo} and {hi}'


def _location(tb):
    return dict(table_no=tb.order, picture_no=tb.meta.get('pic_no'), kind=tb.kind,
                follows_text=tb.before, precedes_text=tb.after, first_row_text=tb.title,
                page=_page_text(tb), page_detail=tb.meta.get('page'),
                graphic_sequence=tb.meta.get('pic_no'))


def _thumb(tb):
    """Small data-URI thumbnail of a bitmap table so the reviewer can see what was not compared."""
    import base64, io
    blob = tb.meta.get('thumb_blob')
    if not blob: return None
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(blob)).convert('RGB'); im.thumbnail((520, 360))
        b = io.BytesIO(); im.save(b, 'JPEG', quality=62)
        return 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()
    except Exception:
        return 'data:image/png;base64,' + base64.b64encode(blob).decode() if len(blob) < 150000 else None


def _presence(idx, tb):
    keys = [c.key for r in tb.rows for c in r if not (c.key.startswith('n:') and len(c.key) <= 4)]
    found = sum(1 for k in keys if idx.post.get(k))
    return found, len(keys)


def _review_table(idx, tb):
    pre_cells = tb.cell_count
    base = dict(id=tb.tid, kind=tb.kind, order=tb.order, title=tb.title, word_location=_location(tb),
                word_rows=len(tb.rows), duplicate_of=tb.duplicate_of)
    base['method'] = 'OCR (image)' if tb.kind == 'raster_ocr' else 'vector text (exact)'
    base['thumb'] = _thumb(tb) if tb.kind in ('raster_ocr', 'raster_unread') else None
    raw = tb.meta.get('frag_count', pre_cells)

    def recon(post, cells=None):
        st = Counter(c['status'] for c in (cells or []))
        return dict(text_records_extracted=raw, whitespace_only_records_ignored=tb.meta.get('blank_records', 0),
                    joined_symbol_fragments=max(0, raw - pre_cells), lines_folded_into_multiline_cells=max(0, pre_cells - post),
                    logical_cells=post, exact=st['match'], format_only=st['format_only'], clipped=st['clipped'], mismatch=st['mismatch'],
                    ocr_review=st['ocr_review'], not_located=st['unaligned'] + st['unmatched'],
                    sums_to_logical_cells=(sum(st.values()) == post) if cells is not None else None)
    if not tb.rows:
        return dict(base, status='UNVERIFIED', reason='Table image (screenshot). Its text cannot be read without OCR, so it was not compared. Install Tesseract OCR to read it.', word_cells=0, compared=0, matched=0, mismatches=0, clipped=0,
                    unverified_cells=0, cells=[], source=None, method='bitmap - not read', reconciliation=recon(0, []))
    A = analyze_table(idx, tb)
    post_cells = tb.cell_count
    base['word_cells'] = post_cells
    if A is None:
        f, n = _presence(idx, tb)
        return dict(base, status='UNVERIFIED', reason=f'No Excel cells share distinctive labels/headings with this table ({f} of {n} distinctive cell values occur anywhere in the workbook).', compared=0, matched=0,
                    mismatches=0, clipped=0, unverified_cells=tb.cell_count, cells=[], source=None, reconciliation=recon(post_cells, None))
    ch = A['chain']; res = A['result']
    cells = res['cells']
    st = Counter(c['status'] for c in cells)
    compared = st['match'] + st['format_only'] + st['clipped'] + st['mismatch']
    total = max(1, len(cells))
    strong_rows = res['strong_rows']
    n_rows = len(tb.rows)
    trusted = ch.cover >= 0.45 and strong_rows >= max(2, min(3, n_rows // 2)) and compared >= 0.5 * total
    if tb.kind == 'raster_ocr': trusted = trusted and ch.cover >= 0.6
    sibs = A.get('siblings') or []
    source = dict(sheet=ch.sheet, sheet_state=idx.wb.sheet(ch.sheet).state, excel_rows=res['excel_rows'], columns=res['columns'],
                  coverage_of_word_content=round(ch.cover, 3), look_alike_ranges=sibs, selected_by=A.get('selected_by'))
    if not trusted:
        f, n = _presence(idx, tb)
        extra = ' Bitmap read by OCR.' if tb.kind == 'raster_ocr' else ''
        return dict(base, status='UNVERIFIED',
                    reason=f'No trustworthy Excel counterpart: the table\'s labels/headings match only {ch.cover:.0%} of the closest Excel region ({ch.sheet}) and it was NOT used ({f} of {n} distinctive cell values occur anywhere in the workbook).{extra}',
                    compared=0, matched=0, mismatches=0, clipped=0, unverified_cells=tb.cell_count, cells=[], source=dict(source, trusted=False), reconciliation=recon(post_cells, None))
    unverified = st['unaligned'] + st['unmatched']
    mism = st['mismatch']; clipped = st['clipped']
    if tb.kind == 'raster_ocr':
        for c in cells:
            if c['status'] == 'mismatch': c['status'] = 'ocr_review'; c['note'] = 'Read by OCR from a bitmap - confirm visually before treating as a discrepancy'
        mism = 0
    reasons = []
    if unverified: reasons.append('cells_not_located')
    if clipped: reasons.append('clipped_text')
    status = 'FULL' if not reasons else 'PARTIAL'
    notes = []
    if clipped: notes.append(f'{clipped} cell(s) are visibly truncated in Word (the leading text matches Excel; the rest is not shown in Word and cannot be compared).')
    if sibs:
        ci = A['chosen_info']
        parts = '; '.join(f"{x['where']} ({x['kind']}, {x['mismatches']} value mismatch(es))" for x in sibs)
        notes.append(f"AMBIGUOUS SOURCE: other Excel range(s) carry the same labels/headings: {parts}. Compared against {ci['where']} ({ci['mismatches']} mismatch(es)), selected by {A['selected_by']}. Confirm which range this Word table was pasted from.")
    review = len(res['findings']) + len(res['missing_rows'])
    return dict(base, status=status, partial_reasons=reasons, compared=compared, matched=st['match'] + st['format_only'], mismatches=mism, clipped=clipped,
                ocr_review=st['mismatch'] if tb.kind == 'raster_ocr' else 0, format_only=st['format_only'], unverified_cells=unverified, review_items=review,
                excel_only_cells=len(res['findings']), excel_rows_not_in_word=len(res['missing_rows']),
                unaligned_rows=[i + 1 for i in res['unaligned_rows']], notes=notes, source=dict(source, trusted=True), reconciliation=recon(post_cells, cells),
                cells=[{k: _jsonable(v) for k, v in c.items() if k not in ('row_idx', 'cell_idx', 'x0', 'x1')} for c in cells],
                excel_only=[{k: _jsonable(v) for k, v in f.items()} for f in res['findings']], missing_rows=res['missing_rows'])


def _collect_findings(tables):
    """Unique discrepancies; repeated tables with the same underlying cell are merged."""
    groups = {}
    for t in tables:
        if t['status'] not in ('FULL', 'PARTIAL'): continue
        for c in t['cells']:
            if c['status'] != 'mismatch': continue
            key = (c['sheet'], c.get('excel_cell'), c['word_text'])
            g = groups.setdefault(key, dict(type='value_mismatch', sheet=c['sheet'], excel_cell=c.get('excel_cell'),
                                            word_value=c['word_text'], excel_display=c.get('excel_display'), excel_value=c.get('excel_value'),
                                            formula=c.get('formula'), detail=c.get('diff') or c.get('note'), occurrences=[]))
            g['occurrences'].append(dict(table=t['id'], table_title=t['title'], table_no=t['order'], word_row=c['word_row'], word_row_label=c.get('row_label'),
                                         word_col=c.get('word_col'), col_header=c.get('col_header'), follows_text=t['word_location']['follows_text'], page=t['word_location']['page'], graphic=t['word_location'].get('graphic_sequence')))
    return sorted(groups.values(), key=lambda g: (g['sheet'], g['excel_cell'] or ''))


def _summarize(tables, others, findings, winfo):
    """Keep comparison coverage separate from whether verified values agree."""
    st = Counter(t['status'] for t in tables)
    cells = sum(t['compared'] for t in tables)
    clipped = sum(t.get('clipped', 0) for t in tables)
    pc = sum(1 for t in tables if t['status'] == 'PARTIAL' and 'cells_not_located' in t.get('partial_reasons', []))
    pcl = sum(1 for t in tables if t['status'] == 'PARTIAL' and t.get('partial_reasons') == ['clipped_text'])
    kinds = Counter(o['kind'] for o in others)

    # A FULL table can still have discrepancies: FULL describes coverage, not correctness.
    matching = sum(1 for t in tables if t['status'] == 'FULL' and t.get('mismatches', 0) == 0)
    discrepant = sum(1 for t in tables if t['status'] in ('FULL', 'PARTIAL') and t.get('mismatches', 0) > 0)
    partial_without_discrepancies = sum(1 for t in tables if t['status'] == 'PARTIAL' and t.get('mismatches', 0) == 0)
    partial_with_discrepancies = sum(1 for t in tables if t['status'] == 'PARTIAL' and t.get('mismatches', 0) > 0)
    assert matching + discrepant + partial_without_discrepancies + st['UNVERIFIED'] == len(tables)

    if discrepant:
        verdict = (f'DISCREPANCIES FOUND — {discrepant} table' + ('s' if discrepant != 1 else '')
                   + f' with discrepancies ({len(findings)} unique difference' + ('s' if len(findings) != 1 else '') + ')')
    elif findings:
        # Defensive fallback if findings exist but table mismatch counters are missing.
        verdict = f'DISCREPANCIES FOUND — {len(findings)} unique difference' + ('s' if len(findings) != 1 else '')
    else:
        verdict = 'NO DISCREPANCIES IN COMPARED CELLS'
    if st['PARTIAL']:
        verdict += f" — {st['PARTIAL']} partly compared"
    if st['UNVERIFIED']:
        verdict += f" — {st['UNVERIFIED']} not verified"

    return dict(
        tables_identified=len(tables), full=st['FULL'], partial=st['PARTIAL'], unverified=st['UNVERIFIED'],
        matching_tables=matching, tables_with_discrepancies=discrepant,
        partial_without_discrepancies=partial_without_discrepancies,
        partial_with_discrepancies=partial_with_discrepancies,
        cells_compared=cells, cells_clipped=clipped, partial_unlocated_cells=pc, partial_clipped_only=pcl,
        cells_not_verified=sum(t['unverified_cells'] for t in tables),
        discrepancies=len(findings), discrepancy_occurrences=sum(len(f['occurrences']) for f in findings),
        other_graphics=dict(kinds), pictures_in_document=winfo['pictures'],
        verdict=verdict,
    )
