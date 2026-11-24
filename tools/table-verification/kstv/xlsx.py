"""Fast read-only OOXML workbook reader (.xlsx/.xlsm). Macros/formulas never executed.

Keeps, per cell: cached value, DISPLAY text (number format applied), formula flag.
Also hidden rows/columns and merged ranges, so Word pictures (which omit hidden
rows/cols) can be aligned against the sheet.
"""
from __future__ import annotations
import re, zipfile, html, posixpath
from dataclasses import dataclass, field
from .numfmt import BUILTIN, format_value


def col_letters(n):
    s = ''
    while n: n, r = divmod(n - 1, 26); s = chr(65 + r) + s
    return s


def col_index(s):
    n = 0
    for ch in s: n = n * 26 + ord(ch) - 64
    return n


def addr(r, c): return f'{col_letters(c)}{r}'


class Cell:
    __slots__ = ('v', 'disp', 'f', 'fmt', 't', 'wrap')

    def __init__(self, v, disp, f, fmt, t, wrap=False):
        self.v, self.disp, self.f, self.fmt, self.t, self.wrap = v, disp, f, fmt, t, wrap


@dataclass
class Sheet:
    name: str
    state: str
    cells: dict = field(default_factory=dict)       # (r,c) -> Cell
    hidden_rows: set = field(default_factory=set)
    hidden_cols: set = field(default_factory=set)
    merges: list = field(default_factory=list)      # (r1,c1,r2,c2)
    max_row: int = 0
    max_col: int = 0

    def row_cells(self, r):
        return sorted(((c, cell) for (rr, c), cell in self.cells.items() if rr == r))


_cell_re = re.compile(r'<c r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)', re.S)
_row_re = re.compile(r'<row ([^>]*?)(/?)>')
_attr = re.compile(r'(\w+)="([^"]*)"')
_v_re = re.compile(r'<v>(.*?)</v>', re.S)
_f_re = re.compile(r'<f[ >/]')
_is_re = re.compile(r'<is>(.*?)</is>', re.S)
_t_re = re.compile(r'<t[^>]*>(.*?)</t>', re.S)


class Workbook:
    def __init__(self, path):
        self.path = str(path)
        self.z = zipfile.ZipFile(self.path)
        self._load_meta()
        self.sheets: dict[str, Sheet] = {}

    def _load_meta(self):
        z = self.z
        wb = z.read('xl/workbook.xml').decode('utf8', 'replace')
        self.date1904 = 'date1904="1"' in wb or 'date1904="true"' in wb
        rels = z.read('xl/_rels/workbook.xml.rels').decode('utf8', 'replace')
        relmap = {}
        for m in re.finditer(r'<Relationship [^>]*?>', rels):
            a = dict(_attr.findall(m.group(0)))
            relmap[a.get('Id')] = a.get('Target', '')
        self.sheet_meta = []
        for m in re.finditer(r'<sheet [^>]*?/>', wb):
            a = dict(_attr.findall(m.group(0)))
            rid = re.search(r'r:id="([^"]+)"', m.group(0)).group(1)
            tgt = relmap[rid]
            part = tgt.lstrip('/') if tgt.startswith('/') else posixpath.normpath('xl/' + tgt)
            self.sheet_meta.append((html.unescape(a['name']), a.get('state', 'visible'), part))
        # shared strings
        self.sst = []
        if 'xl/sharedStrings.xml' in z.namelist():
            x = z.read('xl/sharedStrings.xml').decode('utf8', 'replace')
            for si in re.finditer(r'<si>(.*?)</si>', x, re.S):
                parts = _t_re.findall(re.sub(r'<rPh.*?</rPh>', '', si.group(1), flags=re.S))
                self.sst.append(html.unescape(''.join(parts)))
        # styles -> number format code per xf index
        st = z.read('xl/styles.xml').decode('utf8', 'replace')
        numfmts = {int(m.group(1)): html.unescape(m.group(2)) for m in re.finditer(r'<numFmt numFmtId="(\d+)" formatCode="([^"]*)"', st)}
        cx = re.search(r'<cellXfs[^>]*>(.*?)</cellXfs>', st, re.S)
        self.xf_fmt = []; self.xf_wrap = []
        if cx:
            for m in re.finditer(r'<xf ([^>]*?)(?:/>|>(.*?)</xf>)', cx.group(1), re.S):
                a = dict(_attr.findall(m.group(1)))
                nid = int(a.get('numFmtId', 0))
                self.xf_fmt.append(numfmts.get(nid) or BUILTIN.get(nid) or 'General')
                self.xf_wrap.append(bool(m.group(2) and re.search(r'wrapText="(1|true)"', m.group(2))))

    @property
    def names(self): return [n for n, _, _ in self.sheet_meta]

    def sheet(self, name):
        if name not in self.sheets:
            for n, state, part in self.sheet_meta:
                if n == name:
                    self.sheets[name] = self._parse_sheet(n, state, part)
                    break
            else: raise KeyError(name)
        return self.sheets[name]

    def load_all(self, progress=None):
        for i, (n, _, _) in enumerate(self.sheet_meta):
            self.sheet(n)
            if progress: progress(i + 1, len(self.sheet_meta), n)
        return self

    def _parse_sheet(self, name, state, part):
        x = self.z.read(part).decode('utf8', 'replace')
        sh = Sheet(name, state)
        # hidden columns
        cols = re.search(r'<cols>(.*?)</cols>', x, re.S)
        if cols:
            for m in re.finditer(r'<col ([^>]*?)/?>', cols.group(1)):
                a = dict(_attr.findall(m.group(1)))
                if a.get('hidden') in ('1', 'true'):
                    lo, hi = int(a['min']), min(int(a['max']), 2000)
                    sh.hidden_cols.update(range(lo, hi + 1))
        sd = x.find('<sheetData')
        end = x.find('</sheetData>')
        body = x[sd:end] if sd >= 0 else ''
        xf = self.xf_fmt; sst = self.sst; d1904 = self.date1904
        cells = sh.cells
        # row hidden flags
        for m in _row_re.finditer(body):
            a = dict(_attr.findall(m.group(1)))
            if a.get('hidden') in ('1', 'true') and 'r' in a: sh.hidden_rows.add(int(a['r']))
        for m in _cell_re.finditer(body):
            cl, rs, attrs, inner = m.group(1), m.group(2), m.group(3), m.group(4)
            if not inner: continue
            a = dict(_attr.findall(attrs))
            t = a.get('t', 'n')
            s = int(a.get('s', 0)) if a.get('s', '0').isdigit() else 0
            fmt = xf[s] if s < len(xf) else 'General'
            wrap = self.xf_wrap[s] if s < len(self.xf_wrap) else False
            hasf = bool(_f_re.search(inner))
            vm = _v_re.search(inner)
            raw = vm.group(1) if vm else None
            val = None
            if t == 's' and raw is not None:
                try: val = sst[int(raw)]
                except (ValueError, IndexError): val = None
            elif t in ('str', 'e'):
                val = html.unescape(raw) if raw is not None else None
            elif t == 'b':
                val = (raw == '1') if raw is not None else None
            elif t == 'inlineStr':
                im = _is_re.search(inner)
                val = html.unescape(''.join(_t_re.findall(im.group(1)))) if im else None
            elif raw is not None:
                try: val = float(raw)
                except ValueError: val = None
            if val is None or val == '':
                continue
            if isinstance(val, float): disp = format_value(val, fmt, d1904)
            elif isinstance(val, bool): disp = 'TRUE' if val else 'FALSE'
            else: disp = val
            r, c = int(rs), col_index(cl)
            cells[(r, c)] = Cell(val, disp, hasf, fmt, t, wrap)
            if r > sh.max_row: sh.max_row = r
            if c > sh.max_col: sh.max_col = c
        for m in re.finditer(r'<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"', x):
            sh.merges.append((int(m.group(2)), col_index(m.group(1)), int(m.group(4)), col_index(m.group(3))))
        return sh
