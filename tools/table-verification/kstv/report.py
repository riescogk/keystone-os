"""Render a review result as HTML / CSV / JSON."""
from __future__ import annotations
import csv, html, io, json, datetime

E = html.escape
BADGE = {'FULL': ('Fully compared', '#0a7a3d', '#e6f4ec'), 'PARTIAL': ('Partly compared', '#9a6700', '#fff4d6'),
         'UNVERIFIED': ('Not verified', '#b42318', '#fde8e6')}

CSS = """
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2433;--mut:#5b6577;--line:#e2e6ee;--acc:#1f3a8a}
@media(prefers-color-scheme:dark){:root{--bg:#10141c;--card:#171c27;--ink:#e8ecf4;--mut:#9aa4b8;--line:#2a3142;--acc:#8fb0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 20px 60px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 10px}
.sub{color:var(--mut);font-size:13px}.banner{margin:18px 0;padding:14px 16px;border-radius:10px;font-weight:600}
.ok{background:#e6f4ec;color:#0a7a3d}.warn{background:#fff4d6;color:#7a5200}.bad{background:#fde8e6;color:#b42318}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.card b{display:block;font-size:24px}.card span{color:var(--mut);font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{background:rgba(127,127,127,.08);font-weight:600;font-size:12px;color:var(--mut)}
td.num{text-align:right;font-variant-numeric:tabular-nums}.wrap{overflow-x:auto}.pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;font-weight:600;white-space:nowrap}
code{font:12px ui-monospace,Menlo,Consolas,monospace;background:rgba(127,127,127,.12);padding:1px 5px;border-radius:4px}
.val{font-weight:600}.w{color:#b42318}.x{color:#0a7a3d}details{margin:6px 0}summary{cursor:pointer;color:var(--acc)}
.note{color:var(--mut);font-size:12px}ul{margin:6px 0 6px 18px;padding:0}
"""


def _pill(status, mismatches=0):
    """Show value-discrepancy status without hiding incomplete comparison coverage."""
    if mismatches and status in ('FULL', 'PARTIAL'):
        label = 'Discrepancies found' if status == 'FULL' else 'Discrepancies found (partly compared)'
        fg, bg = '#b42318', '#fde8e6'
    elif status == 'FULL':
        label, fg, bg = 'Matching', '#0a7a3d', '#e6f4ec'
    else:
        label, fg, bg = BADGE[status]
    return f'<span class="pill" style="color:{fg};background:{bg}">{label}</span>'


def to_html(r):
    s = r['summary']
    cls = 'bad' if s['discrepancies'] else ('warn' if s['partial'] + s['unverified'] else 'ok')
    out = [f'<!doctype html><html lang="en"><meta charset="utf-8"><title>Table Verification – {E(r["word_file"])}</title><style>{CSS}</style><main>']
    out.append(f'<h1>Table Verification Report</h1><div class="sub">Word: <code>{E(r["word_file"])}</code> &nbsp; Excel: <code>{E(r["excel_file"])}</code> &nbsp; '
               f'Generated {datetime.datetime.now():%Y-%m-%d %H:%M} &nbsp; Scope: tables only (narrative text is not reviewed)</div>')
    out.append(f'<div class="banner {cls}">{E(s["verdict"])}</div>')
    # The headline groups are mutually exclusive; show partial coverage separately.
    cards = [('Tables identified', s['tables_identified']), ('Matching tables', s['matching_tables']),
             ('Tables with discrepancies', s['tables_with_discrepancies']),
             ('Partly compared (no mismatches found)', s['partial_without_discrepancies']),
             ('Not verified', s['unverified']), ('Unique discrepancies', s['discrepancies']),
             ('Discrepancy occurrences', s['discrepancy_occurrences']),
             ('Cells compared', f"{s['cells_compared']:,}"),
             ('Truncated in Word', s.get('cells_clipped', 0)),
             ('Cells NOT verified', f"{s['cells_not_verified']:,}")]
    out.append('<div class="cards">' + ''.join(f'<div class="card"><b>{E(str(v))}</b><span>{E(k)}</span></div>' for k, v in cards) + '</div>')
    # discrepancies
    out.append('<h2>1. Discrepancies</h2>')
    if not r['findings']:
        out.append('<p>No value differences were found in the cells that could be compared. See section 2 for what was <b>not</b> verified.</p>')
    else:
        out.append('<div class="wrap"><table><tr><th>#</th><th>Table (Word)</th><th>Word location</th><th>Excel location</th><th>Word shows</th><th>Excel shows</th><th>Detail</th></tr>')
        for n, f in enumerate(r['findings'], 1):
            occ = f['occurrences']
            tbl = '<br>'.join(f'Table {o["table_no"]}: {E(o["table_title"][:60])}' for o in occ[:4]) + (f'<br><span class="note">+{len(occ) - 4} repeated</span>' if len(occ) > 4 else '')
            loc = '<br>'.join(f'row {o["word_row"]} “{E((o["word_row_label"] or "")[:36])}”, col {o["word_col"] or "?"} “{E((o["col_header"] or "")[:30])}”' for o in occ[:4])
            loc += f'<br><span class="note">{E(occ[0].get("page") or "")}; after: “{E((occ[0]["follows_text"] or "")[:70])}”</span>'
            out.append(f'<tr><td>{n}</td><td>{tbl}</td><td>{loc}</td><td><code>{E(f["sheet"])}!{E(f["excel_cell"] or "")}</code></td>'
                       f'<td class="val w">{E(str(f["word_value"]))}</td><td class="val x">{E(str(f["excel_display"]).strip())}</td><td>{E(str(f["detail"] or ""))}</td></tr>')
        out.append('</table></div>')
        out.append('<p class="note">Repeated tables showing the same underlying cell are listed once; all occurrences are shown in the Table / Word location columns.</p>')
    # truncated text
    clip = [(t, c) for t in r['tables'] for c in t['cells'] if c['status'] == 'clipped']
    out.append('<h2>1c. Text visibly truncated in Word (not a value discrepancy, not an exact match)</h2>')
    if not clip: out.append('<p>None.</p>')
    else:
        out.append('<p class="note">The leading text matches Excel; the end of the Excel text is not shown in the Word table, so the hidden part could not be compared. “Confirmed” means the picture geometry shows the text reached the cell edge.</p><div class="wrap"><table><tr><th>Table</th><th>Where in Word</th><th>Word shows</th><th>Excel has</th><th>Excel cell</th><th>Evidence</th></tr>')
        for t, c in clip:
            loc = t['word_location']
            out.append(f'<tr><td>Table {t["order"]}: {E(t["title"][:40])}</td><td>{E(loc["page"])}; row {c["word_row"]} “{E((c.get("row_label") or "")[:30])}”</td><td>{E(c["word_text"])}</td>'
                       f'<td>{E(str(c.get("excel_display") or "").strip())}</td><td><code>{E(c.get("sheet") or "")}!{E(c.get("excel_cell") or "")}</code></td><td><b>{E(c.get("clip_confidence") or "")}</b> – {E(c.get("note") or "")}</td></tr>')
        out.append('</table></div>')
    # OCR review
    ocr = [(t, c) for t in r['tables'] for c in t['cells'] if c['status'] == 'ocr_review']
    if ocr:
        out.append('<h2>1b. Bitmap tables read by OCR – confirm visually</h2><ul>' + ''.join(
            f'<li>Table {t["order"]} row {c["word_row"]}: OCR read <b>{E(c["word_text"])}</b>, Excel shows <b>{E(str(c.get("excel_display")))}</b> (<code>{E(c.get("sheet") or "")}!{E(c.get("excel_cell") or "")}</code>)</li>' for t, c in ocr[:60]) + '</ul>')
    # coverage
    out.append('<h2>2. Table coverage</h2><div class="wrap"><table><tr><th>#</th><th>Word table</th><th>Status</th><th>Excel source</th><th>Text records → cells</th><th>Exact / format</th><th>Truncated</th><th>Mismatch</th><th>Not located</th><th>Notes</th></tr>')
    for t in r['tables']:
        src = t.get('source') or {}
        srctxt = '—'
        if src and src.get('trusted', True) and t['status'] != 'UNVERIFIED' and src.get('excel_rows'):
            cols = src['columns']; ks = sorted(cols, key=int)
            srctxt = f'<code>{E(src["sheet"])}</code> {E(cols[ks[0]]["excel_col"])}{src["excel_rows"][0]}:{E(cols[ks[-1]]["excel_col"])}{src["excel_rows"][1]}'
            if src.get('sheet_state') != 'visible': srctxt += f' <span class="note">({E(src["sheet_state"])} sheet)</span>'
        notes = list(t.get('notes') or [])
        if t['status'] == 'UNVERIFIED': notes.insert(0, t['reason'])
        if t.get('duplicate_of'): notes.append(f'Identical picture to {t["duplicate_of"]}.')
        if t.get('excel_only_cells') or t.get('excel_rows_not_in_word'):
            notes.append(f'{t.get("excel_only_cells", 0)} Excel cell(s) / {t.get("excel_rows_not_in_word", 0)} row(s) in the matched range not shown in Word (review).')
        detail = ''
        bad = [c for c in t['cells'] if c['status'] in ('unaligned', 'unmatched')]
        if bad:
            detail = '<details><summary>show unverified cells</summary><ul>' + ''.join(f'<li>row {c["word_row"]}: “{E(c["word_text"][:60])}” – {E(c.get("note") or "not located in Excel")}</li>' for c in bad[:40]) + '</ul></details>'
        wl = t['word_location']
        title = f'{E(t["title"][:70])}<br><span class="note">{E(t["method"])} • {E(wl["page"])} • graphic #{wl.get("graphic_sequence") or "-"} • after: “{E((wl["follows_text"] or "")[:60])}”</span>'
        if t.get('thumb'): title += f'<br><img alt="table image" src="{t["thumb"]}" style="max-width:220px;margin-top:4px;border:1px solid var(--line)">'
        rc = t['reconciliation']
        recon = f'{rc["text_records_extracted"]} → {rc["logical_cells"]}'
        if rc['lines_folded_into_multiline_cells'] or rc['joined_symbol_fragments']:
            recon += f'<br><span class="note">{rc["lines_folded_into_multiline_cells"]} wrapped lines folded, {rc["joined_symbol_fragments"]} symbols joined</span>'
        pr = {'cells_not_located': 'cells not located', 'clipped_text': 'truncated text'}
        stat_html = _pill(t['status'], t.get('mismatches', 0)) + ('<br><span class="note">' + ', '.join(pr[x] for x in t.get('partial_reasons', [])) + '</span>' if t.get('partial_reasons') else '')
        out.append(f'<tr><td>{t["order"]}</td><td>{title}</td><td>{stat_html}</td><td>{srctxt}</td><td class="num">{recon}</td>'
                   f'<td class="num">{rc["exact"] + rc["format_only"]}</td><td class="num">{rc["clipped"]}</td><td class="num">{t["mismatches"]}</td><td class="num">{t["unverified_cells"]}</td><td>{E(" ".join(notes))}{detail}</td></tr>')
    out.append('</table></div>')
    # other graphics
    o = r['other_graphics']
    out.append('<h2>3. Other objects in the Word file (not tables)</h2>')
    from collections import Counter
    cnt = Counter(x['kind'] for x in o)
    names = {'bitmap_photo_or_map': 'Photos / aerials / maps (no table structure)', 'bitmap_signature_or_logo': 'Signatures / logos',
             'bitmap_chart_or_plan_or_other': 'Charts / floor plans / other graphics', 'bitmap_weak_table_candidate': 'Possible tables that look like charts – CHECK VISUALLY', 'bitmap_unclassified': 'Bitmaps NOT classified (install Pillow) – CHECK VISUALLY',
             'native_layout_table': 'Native Word layout table (narrative container) – not compared', 'raster_photo_or_graphic': 'Photos / maps / plans / charts (no table structure)',
             'raster_not_examined': 'Bitmaps NOT examined (OCR unavailable)', 'emf_no_text': 'Vector figures with no text', 'emf_text_not_table': 'Vector figures with text but not table-shaped'}
    out.append('<ul>' + ''.join(f'<li><b>{n}</b> × {E(names.get(k, k))}</li>' for k, n in cnt.items()) + '</ul>')
    weak = [x for x in o if x.get('needs_visual_check')]
    if weak:
        out.append('<p><b>Please check these bitmaps by eye (could be table screenshots):</b></p><ul>' + ''.join(
            f'<li>graphic #{x.get("pic_no")} ({x.get("width_px")}×{x.get("height_px")} px) – after “{E((x.get("before") or "")[:70])}”</li>' for x in weak) + '</ul>')
    for x in o:
        if x['kind'] == 'native_layout_table':
            out.append(f'<p class="note">The native Word table has {x["rows"]} rows × {x["cols"]} columns and {x["characters"]:,} characters of narrative/layout text; it is not tabular data and was not compared. Pictures inside it are processed individually above.</p>')
    out.append('<h2>4. Method and limits</h2><ul>'
               '<li>Word tables pasted from Excel as pictures are read from their vector (EMF) drawing instructions: exact text, no OCR.</li>'
               '<li>Each table is located in the workbook by aligning its rows and columns (labels, headers and values together) to a contiguous Excel range; hidden rows/columns are honoured.</li>'
               '<li>Values are compared using Excel’s displayed text and Word’s displayed precision, so formatting/rounding alone is not reported.</li>'
               '<li>Coverage (fully/partly/not verified) describes how much of a Word table could be checked. Matching or discrepancies describes the values checked; a fully compared table can contain discrepancies.</li>'
               '<li>Legacy .doc files store no page layout, so exact page numbers cannot be read. “Between pages X and Y” is derived from the report’s own saved table of contents plus manual page breaks and is a bracket, not an exact page; it can be stale if the TOC was not refreshed. “Graphic #N” is the picture’s position among all inline pictures in the document.</li>'
               '<li>Workbook formulas are never recalculated: Excel’s last saved values are used.</li></ul>')
    out.append('</main></html>')
    return ''.join(out)


def findings_csv(r):
    b = io.StringIO(); w = csv.writer(b)
    w.writerow(['#', 'type', 'table_no', 'table_title', 'word_page', 'word_graphic_no', 'word_row', 'word_row_label', 'word_col', 'col_header', 'follows_text', 'excel_sheet', 'excel_cell', 'word_value', 'excel_display', 'detail'])
    n = 0
    for f in r['findings']:
        for o in f['occurrences']:
            n += 1
            w.writerow([n, f['type'], o['table_no'], o['table_title'], o.get('page'), o.get('graphic'), o['word_row'], o['word_row_label'], o['word_col'], o['col_header'], o['follows_text'],
                        f['sheet'], f['excel_cell'], f['word_value'], str(f['excel_display']).strip(), f['detail']])
    return b.getvalue()


def cells_csv(r):
    b = io.StringIO(); w = csv.writer(b)
    w.writerow(['table_no', 'table_title', 'status_of_table', 'word_row', 'word_text', 'cell_status', 'excel_sheet', 'excel_cell', 'excel_display', 'clip_confidence', 'merged_from', 'method', 'note'])
    for t in r['tables']:
        for c in t['cells']:
            w.writerow([t['order'], t['title'], t['status'], c['word_row'], c['word_text'], c['status'], c.get('sheet') or '', c.get('excel_cell') or '',
                        str(c.get('excel_display') or '').strip(), c.get('clip_confidence') or '', ' | '.join(c.get('merged_from') or []), c.get('method') or '', c.get('note') or ''])
    return b.getvalue()


def tables_csv(r):
    b = io.StringIO(); w = csv.writer(b)
    w.writerow(['table_no', 'id', 'title', 'word_page', 'status', 'partial_reasons', 'method', 'excel_sheet', 'excel_rows', 'text_records', 'logical_cells', 'lines_folded', 'exact_or_format', 'truncated', 'mismatches', 'not_located', 'reason_or_notes'])
    for t in r['tables']:
        src = t.get('source') or {}
        rc = t['reconciliation']
        w.writerow([t['order'], t['id'], t['title'], t['word_location']['page'], t['status'], ';'.join(t.get('partial_reasons') or []), t['method'], src.get('sheet', ''), src.get('excel_rows', ''),
                    rc['text_records_extracted'], rc['logical_cells'], rc['lines_folded_into_multiline_cells'], rc['exact'] + rc['format_only'], rc['clipped'], t['mismatches'], t['unverified_cells'], t.get('reason') or ' '.join(t.get('notes') or [])])
    return b.getvalue()


def to_json(r): return json.dumps(r, indent=1, default=str)
