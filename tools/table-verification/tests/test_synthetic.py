"""Native .docx tables vs .xlsx built on the fly (no real appraisal files needed)."""
import os, zipfile, pytest
openpyxl = pytest.importorskip('openpyxl')
from kstv.review import run_review


def make_docx(path, tables):
    def cell(t): return f'<w:tc><w:p><w:r><w:t>{t}</w:t></w:r></w:p></w:tc>'
    body = ''
    for title, rows in tables:
        body += f'<w:p><w:r><w:t>{title}</w:t></w:r></w:p><w:tbl>' + ''.join('<w:tr>' + ''.join(cell(c) for c in r) + '</w:tr>' for r in rows) + '</w:tbl>'
    xml = ('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           f'<w:body>{body}</w:body></w:document>')
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
        z.writestr('word/document.xml', xml)


@pytest.fixture
def book(tmp_path):
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Rents'
    def put(r0, c0, rows):
        for i, row in enumerate(rows):
            for j, v in enumerate(row): ws.cell(r0 + i, c0 + j, v)
    # table A as-is, table B as-complete (same labels, different numbers) side by side on one sheet
    hdr = ['Unit Type', 'Units', 'SF', 'Rent']
    a = [hdr, ['1BR', 10, 650, 1200], ['2BR', 8, 900, 1500], ['3BR', 4, 1150, 1800], ['Total', 22, 19100, 1380]]
    b = [hdr, ['1BR', 10, 650, 1300], ['2BR', 8, 900, 1600], ['3BR', 4, 1150, 1900], ['Total', 22, 19100, 1480]]
    put(3, 2, [['AS IS RENTS']] ); put(4, 2, a)
    put(3, 9, [['AS COMPLETE RENTS']]); put(4, 9, b)
    for r in range(5, 10):
        for c in (5, 12): ws.cell(r, c).number_format = '$#,##0'
    p = tmp_path / 'book.xlsx'; wb.save(p)
    return str(p), a, b


def rows_to_text(rows, fmt_rent=True):
    out = []
    for r in rows:
        out.append([r[0], str(r[1]), f'{r[2]:,}' if isinstance(r[2], int) else str(r[2]), (f'${r[3]:,}' if isinstance(r[3], int) else str(r[3]))] if r is not rows[0] else list(r))
    return out


def test_correct_tables_pass_and_versions_are_distinguished(tmp_path, book):
    xl, a, b = book
    make_docx(tmp_path / 'r.docx', [('AS IS RENTS', rows_to_text(a)), ('AS COMPLETE RENTS', rows_to_text(b))])
    r = run_review(str(tmp_path / 'r.docx'), xl)
    assert r['summary']['tables_identified'] == 2 and r['summary']['full'] == 2
    assert r['summary']['discrepancies'] == 0
    cols = [t['source']['columns'][1]['excel_col'] for t in r['tables']]
    assert cols == ['B', 'I']           # each version matched to ITS OWN block


def test_planted_error_is_located_precisely(tmp_path, book):
    xl, a, b = book
    bad = rows_to_text(b); bad[2][3] = '$1,650'            # Word says 1,650, Excel says 1,600
    make_docx(tmp_path / 'r.docx', [('AS COMPLETE RENTS', bad)])
    r = run_review(str(tmp_path / 'r.docx'), xl)
    assert r['summary']['discrepancies'] == 1
    f = r['findings'][0]
    assert (f['sheet'], f['excel_cell'], f['word_value']) == ('Rents', 'L6', '$1,650')
    assert str(f['excel_display']).strip() == '$1,600'


def test_formatting_only_difference_is_not_reported(tmp_path, book):
    xl, a, b = book
    txt = rows_to_text(a); txt[1][3] = '1200.00'           # same value, different formatting
    make_docx(tmp_path / 'r.docx', [('AS IS RENTS', txt)])
    r = run_review(str(tmp_path / 'r.docx'), xl)
    assert r['summary']['discrepancies'] == 0


def test_table_without_source_is_unverified_not_passed(tmp_path, book):
    xl, a, b = book
    ghost = [['Comp', 'Price', 'SF', '$/SF'], ['Alpha Plaza', '$4,100,000', '41,000', '$100.00'], ['Beta Court', '$3,900,000', '38,000', '$102.63'], ['Gamma Row', '$5,000,000', '47,500', '$105.26']]
    make_docx(tmp_path / 'r.docx', [('AS IS RENTS', rows_to_text(a)), ('SALES', ghost)])
    r = run_review(str(tmp_path / 'r.docx'), xl)
    st = {t['title'][:4]: t['status'] for t in r['tables']}
    assert st['Unit'] == 'FULL' and st['Comp'] == 'UNVERIFIED'
    assert 'NOT' not in r['summary']['verdict'] or 'not verified' in r['summary']['verdict']
    assert r['summary']['unverified'] == 1


# ---- matching must be driven by titles/headings/row labels, NOT by the numbers being audited ----
def test_every_number_wrong_is_still_located_and_reported(tmp_path, book):
    xl, a, b = book
    wrong = [a[0]] + [[r[0], str(r[1] + 7), f'{r[2] + 11:,}', f'${r[3] + 99:,}'] for r in a[1:]]     # labels right, all 12 numbers wrong
    make_docx(tmp_path / 'r.docx', [('AS IS RENTS', wrong)])
    r = run_review(str(tmp_path / 'r.docx'), xl)
    t = r['tables'][0]
    assert t['status'] in ('FULL', 'PARTIAL') and t['source']['sheet'] == 'Rents'
    assert t['source']['columns'][1]['excel_col'] == 'B'                      # located at the AS IS block by its title/labels
    assert r['summary']['discrepancies'] == 12
    assert {f['excel_cell'][0] for f in r['findings']} <= {'C', 'D', 'E'}


def test_scenario_title_beats_matching_numbers(tmp_path, book):
    xl, a, b = book
    # Word says AS COMPLETE but pasted the AS IS numbers: must be audited against the AS COMPLETE block
    make_docx(tmp_path / 'r.docx', [('AS COMPLETE RENTS', rows_to_text(a))])
    r = run_review(str(tmp_path / 'r.docx'), xl)
    t = r['tables'][0]
    assert t['source']['columns'][1]['excel_col'] == 'I'
    assert r['summary']['discrepancies'] >= 4                                  # rent column (and total) differ from AS COMPLETE


def test_identical_sibling_ranges_are_reported_as_ambiguous(tmp_path):
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Grid'
    rows1 = [['SUMMARY'], ['Type', 'Units', 'Rent'], ['1BR', 10, 1200], ['2BR', 8, 1500], ['3BR', 4, 1800]]
    rows2 = [['SUMMARY'], ['Type', 'Units', 'Rent'], ['1BR', 10, 1250], ['2BR', 8, 1550], ['3BR', 4, 1850]]   # same title/labels, other numbers
    for r0, c0, rows in ((2, 2, rows1), (2, 8, rows2)):
        for i, row in enumerate(rows):
            for j, v in enumerate(row): ws.cell(r0 + i, c0 + j, v)
    p = tmp_path / 'sib.xlsx'; wb.save(p)
    make_docx(tmp_path / 'r.docx', [('SUMMARY', [['Type', 'Units', 'Rent'], ['1BR', '10', '1250'], ['2BR', '8', '1550'], ['3BR', '4', '1850']])])
    r = run_review(str(tmp_path / 'r.docx'), str(p))
    t = r['tables'][0]
    notes = ' '.join(t.get('notes') or [])
    assert 'AMBIGUOUS SOURCE' in notes                                        # ambiguity is surfaced, not hidden
    assert len(t['source']['look_alike_ranges']) == 1 and 'last resort' in t['source']['selected_by']
