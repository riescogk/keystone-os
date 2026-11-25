"""Read-only .docx reader: native tables (with merged cells) and embedded pictures, in document order."""
from __future__ import annotations
import re, zipfile, posixpath, html
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'


def _text(el):
    out = []
    for n in el.iter():
        if n.tag == W + 't': out.append(n.text or '')
        elif n.tag in (W + 'tab',): out.append(' ')
        elif n.tag in (W + 'br', W + 'cr'): out.append('\n')
    return ''.join(out)


def parse_docx(path):
    """-> list of items in order: ('para', text) | ('table', rows[list[list[(text,gridspan,vmerge)]]]) | ('pic', kind, bytes)"""
    z = zipfile.ZipFile(path)
    rels = {}
    if 'word/_rels/document.xml.rels' in z.namelist():
        for m in re.finditer(r'<Relationship [^>]*?/>', z.read('word/_rels/document.xml.rels').decode('utf8', 'replace')):
            a = dict(re.findall(r'(\w+)="([^"]*)"', m.group(0)))
            rels[a.get('Id')] = a.get('Target', '')
    root = ET.fromstring(z.read('word/document.xml'))
    body = root.find(W + 'body')
    items = []

    def pics_in(el):
        for blip in el.iter(A + 'blip'):
            rid = blip.get(R + 'embed')
            if rid in rels:
                part = posixpath.normpath('word/' + rels[rid])
                if part in z.namelist():
                    ext = part.rsplit('.', 1)[-1].lower()
                    items.append(('pic', {'emf': 'emf', 'wmf': 'wmf', 'png': 'png', 'jpg': 'jpeg', 'jpeg': 'jpeg'}.get(ext, ext), z.read(part)))
        for im in el.iter('{urn:schemas-microsoft-com:vml}imagedata'):
            rid = im.get(R + 'id')
            if rid in rels:
                part = posixpath.normpath('word/' + rels[rid])
                if part in z.namelist():
                    ext = part.rsplit('.', 1)[-1].lower()
                    items.append(('pic', {'emf': 'emf', 'wmf': 'wmf', 'png': 'png', 'jpg': 'jpeg', 'jpeg': 'jpeg'}.get(ext, ext), z.read(part)))

    def table_rows(tbl):
        rows = []
        for tr in tbl.findall(W + 'tr'):
            cells = []
            for tc in tr.findall(W + 'tc'):
                pr = tc.find(W + 'tcPr')
                span, vm = 1, None
                if pr is not None:
                    gs = pr.find(W + 'gridSpan')
                    if gs is not None: span = int(gs.get(W + 'val', '1'))
                    v = pr.find(W + 'vMerge')
                    if v is not None: vm = v.get(W + 'val', 'continue')
                txt = '\n'.join(_text(p) for p in tc.findall(W + 'p')).strip()
                cells.append((txt, span, vm))
            rows.append(cells)
        return rows

    for ch in body:
        if ch.tag == W + 'p':
            t = _text(ch).strip()
            items.append(('para', t))
            pics_in(ch)
        elif ch.tag == W + 'tbl':
            items.append(('table', table_rows(ch)))
            pics_in(ch)
    return items
