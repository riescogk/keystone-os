"""Runs the engine on the real appraisal reports/workbooks.

Set KSTV_SAMPLES to the folder holding the .doc/.xlsm files (default: ./samples).
Tests are skipped when the files are absent.
"""
import os, pytest
from kstv.review import run_review
from kstv.xlsx import Workbook, addr

S = os.environ.get('KSTV_SAMPLES', os.path.join(os.path.dirname(__file__), '..', 'samples'))


def p(n): return os.path.join(S, n)


def need(*names):
    if not all(os.path.exists(p(n)) for n in names): pytest.skip('sample files not present')


CLEAN = {  # report -> (min tables identified, expected discrepancies)
    '25203TheIsaac': (55, 0), '26221HighpointeAptsTAX2024': (33, 0), '26186WaterfordPlace': (44, 0),
    '26196HarborRCS-Milwaukee': (39, 0), '25181ParkerHouseRCS': (37, 0), '25211CountryAcresAppraisal-LaPorteIN': (41, 0),
    '26112TheHighlandsfkaPamApts-RCS': (26, 2), '25124-TonganoxieVacantLand': (10, 0),
}


@pytest.mark.parametrize('name', sorted(CLEAN))
def test_clean_pairs(name):
    need(name + '.doc', name + '.xlsm')
    r = run_review(p(name + '.doc'), p(name + '.xlsm'))
    s = r['summary']
    assert s['tables_identified'] >= CLEAN[name][0]
    assert s['discrepancies'] == CLEAN[name][1]
    # never claim a clean pass when tables are unverified
    if s['partial'] + s['unverified']: assert 'not verified' in s['verdict'] or 'partly' in s['verdict']
    # high coverage of the tables that do have an Excel source
    assert s['full'] >= 0.6 * s['tables_identified']


def test_highlands_known_discrepancy():
    need('26112TheHighlandsfkaPamApts-RCS.doc', '26112TheHighlandsfkaPamApts-RCS.xlsm')
    r = run_review(p('26112TheHighlandsfkaPamApts-RCS.doc'), p('26112TheHighlandsfkaPamApts-RCS.xlsm'))
    vals = {(f['excel_cell'], f['word_value'], str(f['excel_display']).strip()) for f in r['findings']}
    assert ('BH87', '572', '590') in vals


def _expected_from_diff(word, clean, bad):
    rc = run_review(p(word), p(clean))
    shown = {(c['sheet'], c['excel_cell']) for t in rc['tables'] for c in t['cells'] if c['status'] in ('match', 'format_only') and c.get('excel_cell')}
    A, B = Workbook(p(clean)).load_all(), Workbook(p(bad)).load_all()
    changed = set()
    for n in A.names:
        sa, sb = A.sheet(n), B.sheet(n)
        for k in set(sa.cells) | set(sb.cells):
            ca, cb = sa.cells.get(k), sb.cells.get(k)
            if (ca.disp if ca else None) != (cb.disp if cb else None): changed.add((n, addr(*k)))
    return changed & shown


@pytest.mark.parametrize('word,clean,bad,n', [
    ('26221HighpointeAptsTAX2024.doc', '26221HighpointeAptsTAX2024.xlsm', '26221HighpointeAptsTAX2024-bad.xlsm', 3),
    ('26196HarborRCS-Milwaukee.doc', '26196HarborRCS-Milwaukee.xlsm', '26196HarborRCS-Milwaukee_BAD_TEST.xlsm', 26)])
def test_negative_controls(word, clean, bad, n):
    need(word, clean, bad)
    expected = _expected_from_diff(word, clean, bad)       # ground truth from a raw cell diff, independent of the matcher
    assert len(expected) == n
    rb = run_review(p(word), p(bad))
    flagged = {(f['sheet'], f['excel_cell']) for f in rb['findings']}
    assert expected <= flagged, f'missed: {sorted(expected - flagged)}'
    assert flagged <= expected, f'unexpected: {sorted(flagged - expected)}'


# ---- refinements requested after the first local run -------------------------------------------------
TONGA = '25124-TonganoxieVacantLand'


def _tonga():
    need(TONGA + '.doc', TONGA + '.xlsm')
    return run_review(p(TONGA + '.doc'), p(TONGA + '.xlsm'))


def test_tonganoxie_cell_reconciliation_616_to_593():
    r = _tonga()
    vec = [t for t in r['tables'] if t['kind'] == 'vector']
    rc = [t['reconciliation'] for t in vec]
    assert sum(x['text_records_extracted'] for x in rc) == 616
    assert sum(x['logical_cells'] for x in rc) == 593
    assert sum(x['lines_folded_into_multiline_cells'] for x in rc) == 23         # the whole 23-cell difference
    assert all(x['sums_to_logical_cells'] for x in rc)                           # every cell is in exactly one category
    assert r['summary']['cells_compared'] == 593


def test_tonganoxie_bitmaps_classified_without_ocr():
    r = _tonga()
    assert sum(1 for t in r['tables'] if t['kind'] == 'raster_unread') == 2      # the two Oxford Economics table screenshots
    kinds = {}
    for o in r['other_graphics']: kinds[o['kind']] = kinds.get(o['kind'], 0) + 1
    assert kinds.get('bitmap_photo_or_map') == 19 and kinds.get('bitmap_signature_or_logo') == 4
    assert not any(o.get('needs_visual_check') for o in r['other_graphics'])
    assert r['summary']['unverified'] == 2                                       # never reported as passed


def test_clipped_cells_are_not_exact_matches():
    r = _tonga()
    clipped = [(t['id'], c) for t in r['tables'] for c in t['cells'] if c['status'] == 'clipped']
    assert len(clipped) == 3
    lc4 = [c for tid, c in clipped if c['word_text'].startswith('NEQ 259th Street and Dehoff')]
    assert lc4 and lc4[0]['excel_display'].strip() == 'NEQ 259th Street and Dehoff Road' and lc4[0]['clip_confidence'] == 'confirmed'
    for t in r['tables']:
        if any(c['status'] == 'clipped' for c in t['cells']): assert t['status'] == 'PARTIAL' and 'clipped_text' in t['partial_reasons']


def test_page_ranges_come_from_the_saved_toc_and_are_never_exact_guesses():
    r = _tonga()
    for t in r['tables']:
        pg = t['word_location']['page_detail']
        assert pg and pg['page_min'] >= 1 and (pg['page_max'] is None or pg['page_max'] >= pg['page_min'])
        assert 'table-of-contents' in pg['basis']
