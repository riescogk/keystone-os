"""Command line:  python -m kstv review REPORT.doc WORKBOOK.xlsm --out DIR   |   python -m kstv serve"""
from __future__ import annotations
import argparse, os, sys
from .review import run_review
from .report import to_html, to_json, findings_csv, cells_csv, tables_csv
from .ocr import make_ocr


def write_outputs(result, out_dir, stem):
    os.makedirs(out_dir, exist_ok=True)
    paths = {}
    for ext, fn in (('html', to_html), ('json', to_json)):
        p = os.path.join(out_dir, f'{stem}.{ext}')
        open(p, 'w', encoding='utf-8').write(fn(result)); paths[ext] = p
    for name, fn in (('discrepancies', findings_csv), ('tables', tables_csv), ('cells', cells_csv)):
        p = os.path.join(out_dir, f'{stem}.{name}.csv')
        open(p, 'w', encoding='utf-8-sig', newline='').write(fn(result)); paths[name] = p
    return paths


def main(argv=None):
    ap = argparse.ArgumentParser(prog='kstv', description='Keystone Table Verification: compare Word tables with Excel tables.')
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('review'); r.add_argument('word'); r.add_argument('excel'); r.add_argument('--out', default='table-verification-output')
    r.add_argument('--ocr', action='store_true', help='also read bitmap tables with Tesseract OCR (needs pytesseract + tesseract)')
    r.add_argument('--ocr-cache', default=None)
    s = sub.add_parser('serve'); s.add_argument('--port', type=int, default=8765); s.add_argument('--host', default='127.0.0.1')
    a = ap.parse_args(argv)
    if a.cmd == 'serve':
        from .server import serve; return serve(a.host, a.port)
    ocr = None
    if a.ocr:
        ocr = make_ocr(a.ocr_cache or os.path.join(a.out, '.ocr-cache'))
        if ocr is None: print('OCR requested but pytesseract/Tesseract is not available; bitmaps will be listed as not examined.', file=sys.stderr)
    res = run_review(a.word, a.excel, ocr=ocr, progress=lambda m: print(m, file=sys.stderr))
    stem = os.path.splitext(os.path.basename(a.word))[0] + '.table-verification'
    paths = write_outputs(res, a.out, stem)
    s = res['summary']
    print(f"\n{s['verdict']}\n  tables {s['tables_identified']}: {s['full']} fully compared, {s['partial']} partly, {s['unverified']} not verified"
          f"\n  cells compared {s['cells_compared']:,}; not verified {s['cells_not_verified']:,}; discrepancies {s['discrepancies']}")
    for k, p in paths.items(): print(f'  {k:14s} {p}')
    return 1 if s['discrepancies'] else 0
