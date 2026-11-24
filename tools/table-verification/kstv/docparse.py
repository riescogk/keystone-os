"""Read-only parser for legacy Word 97-2003 (.doc) files.

Recovers, with no Word/LibreOffice:
  * main-story text with a CP index (piece table)
  * paragraph boundaries and TRUE native table structure (PAPX: in-table / TTP /
    TDefTable cell boundaries)
  * inline pictures in true DOCUMENT ORDER (CHPX sprmCPicLocation -> Data stream),
    with their OfficeArt BLIP (EMF/WMF/PNG/JPEG/DIB/TIFF) bytes.
Nothing is executed or modified.
"""
from __future__ import annotations
import struct, zlib
from dataclasses import dataclass, field
from .ole import OleReader

BLIP_TYPES = {0xF01A: "emf", 0xF01B: "wmf", 0xF01C: "pict", 0xF01D: "jpeg",
              0xF01E: "png", 0xF01F: "dib", 0xF029: "tiff", 0xF02A: "jpeg"}
SPRA_SIZE = {0: 1, 1: 1, 2: 2, 3: 4, 4: 2, 5: 2, 7: 3}


def parse_grpprl(buf: bytes):
    """Yield (opcode, operand_bytes) from a sprm array."""
    out, p = [], 0
    while p + 2 <= len(buf):
        op = struct.unpack_from('<H', buf, p)[0]; p += 2
        spra = op >> 13
        if spra == 6:
            if op == 0xD608:  # TDefTable: 2-byte length (stored as size-1 incl. itself semantics)
                if p + 2 > len(buf): break
                n = struct.unpack_from('<H', buf, p)[0]
                operand = buf[p:p + 1 + n]; p += 1 + n
            elif op == 0xC615:  # PChgTabs
                n = buf[p];
                if n == 255:
                    dele = buf[p + 1]; add = buf[p + 2 + dele * 2]
                    n = 1 + dele * 2 + 1 + add * 3
                operand = buf[p:p + 1 + n]; p += 1 + n
            else:
                if p >= len(buf): break
                n = buf[p]; operand = buf[p + 1:p + 1 + n]; p += 1 + n
        else:
            n = SPRA_SIZE[spra]; operand = buf[p:p + n]; p += n
        out.append((op, operand))
    return out


@dataclass
class Picture:
    cp: int
    data_offset: int
    kind: str            # emf/wmf/png/jpeg/dib/tiff/none
    blob: bytes
    width_twips: int = 0
    height_twips: int = 0
    scale_x: int = 1000
    scale_y: int = 1000
    order: int = 0


@dataclass
class NativeTable:
    start_cp: int
    end_cp: int
    rows: list            # list[list[str]] cell texts (row-major, raw per physical row)
    row_cell_edges: list  # list[list[int]] rgdxaCenter per row
    nested: bool = False
    row_cps: list = field(default_factory=list)


class WordDoc:
    def __init__(self, path):
        self.o = OleReader(path, 200_000_000)
        self.word = self.o.get('WordDocument')
        w = self.word
        if struct.unpack_from('<H', w, 0)[0] != 0xA5EC:
            raise ValueError('Not a Word 97+ binary document')
        self.table = self.o.get('1Table' if w[11] & 2 else '0Table')
        self.ccp_text = struct.unpack_from('<I', w, 0x4C)[0]
        self._pieces()
        self._fib_pairs()
        names = [n for n, _ in self.o.list_streams()]
        self.data = self.o.get('Data') if 'Data' in names else b''
        self._build_text()

    # ---- FIB / piece table -------------------------------------------------
    def _fib_pairs(self):
        w = self.word
        cb = struct.unpack_from('<H', w, 0x98)[0]
        self.fc = {}
        for i in range(min(cb, 93)):
            self.fc[i] = struct.unpack_from('<II', w, 0x9A + 8 * i)

    def _pieces(self):
        w, t = self.word, self.table
        clx_off, clx_len = struct.unpack_from('<II', w, 0x1A2)
        blob = t[clx_off:clx_off + clx_len]
        pos = 0
        while pos < len(blob):
            typ = blob[pos]
            if typ == 1:
                pos += 3 + struct.unpack_from('<H', blob, pos + 1)[0]
            elif typ == 2:
                num = struct.unpack_from('<I', blob, pos + 1)[0]
                raw = blob[pos + 5:pos + 5 + num]
                n = (num - 4) // 12
                cps = struct.unpack_from(f'<{n + 1}I', raw, 0)
                self.pieces = []
                for i in range(n):
                    fcraw = struct.unpack_from('<I', raw, 4 * (n + 1) + 8 * i + 2)[0]
                    comp = bool(fcraw & 0x40000000)
                    fcb = (fcraw & 0x3FFFFFFF) // 2 if comp else (fcraw & 0x3FFFFFFF)
                    self.pieces.append((cps[i], cps[i + 1], fcb, comp))
                return
            else:
                raise ValueError('Bad CLX')
        raise ValueError('No piece table')

    def _build_text(self):
        parts = []
        for cp0, cp1, fcb, comp in self.pieces:
            n = cp1 - cp0
            raw = self.word[fcb:fcb + n * (1 if comp else 2)]
            parts.append(raw.decode('cp1252', 'replace') if comp else raw.decode('utf-16le', 'replace'))
        self.text = ''.join(parts)

    def fc_to_cp(self, fc):
        for cp0, cp1, fcb, comp in self.pieces:
            step = 1 if comp else 2
            if fcb <= fc <= fcb + (cp1 - cp0) * step:
                return cp0 + (fc - fcb) // step
        return None

    # ---- FKP readers -------------------------------------------------------
    def _plc_bte(self, idx):
        off, ln = self.fc[idx]
        if not ln: return []
        n = (ln - 4) // 8
        fcs = struct.unpack_from(f'<{n + 1}I', self.table, off)
        pns = struct.unpack_from(f'<{n}I', self.table, off + 4 * (n + 1))
        return [pn & 0x3FFFFF for pn in pns]

    def chpx_runs(self):
        """yield (cp_start, cp_end, grpprl) for character runs."""
        for pn in self._plc_bte(12):
            page = self.word[pn * 512:(pn + 1) * 512]
            crun = page[511]
            fcs = struct.unpack_from(f'<{crun + 1}I', page, 0)
            for i in range(crun):
                b = page[4 * (crun + 1) + i]
                if not b: continue
                o = b * 2; cb = page[o]
                a, e = self.fc_to_cp(fcs[i]), self.fc_to_cp(fcs[i + 1])
                if a is None or e is None: continue
                yield a, e, page[o + 1:o + 1 + cb]

    def papx_runs(self):
        """yield (cp_start, cp_end, grpprl) for paragraphs."""
        for pn in self._plc_bte(13):
            page = self.word[pn * 512:(pn + 1) * 512]
            crun = page[511]
            fcs = struct.unpack_from(f'<{crun + 1}I', page, 0)
            for i in range(crun):
                b = page[4 * (crun + 1) + i * 13]
                if not b: continue
                o = b * 2; cb = page[o]
                if cb == 0:
                    cb2 = page[o + 1]; body = page[o + 2:o + 2 + cb2 * 2]
                else:
                    body = page[o + 1:o + 1 + cb * 2 - 1]
                a, e = self.fc_to_cp(fcs[i]), self.fc_to_cp(fcs[i + 1])
                if a is None or e is None: continue
                yield a, e, body[2:]  # skip istd

    # ---- native tables -----------------------------------------------------
    def native_tables(self):
        """Return NativeTable objects from PAPX table properties (true row/cell structure)."""
        text = self.text
        limit = min(self.ccp_text, len(text))
        ttp_ends, para_by_end = {}, {}
        for a, e, g in self.papx_runs():
            if a >= limit: continue
            ttp = itap = 0; edges = None
            for op, v in parse_grpprl(g):
                if op in (0x2417, 0x244C) and v and v[0]: ttp = 1
                elif op == 0x2416 and v and v[0]: itap = max(itap, 1)
                elif op == 0x6649 and v: itap = v[0]
                elif op == 0xD608 and len(v) >= 4:
                    n = v[2]
                    if 3 + (n + 1) * 2 <= len(v):
                        edges = list(struct.unpack_from(f'<{n + 1}h', v, 3))
            if ttp: ttp_ends[e - 1] = (edges, itap)
            if itap or ttp: para_by_end[e - 1] = a
        tables, cur = [], None
        pending = []          # (start,end) of cells of the row under construction
        last_row_end = None
        for m in (i for i in range(limit) if text[i] == '\x07'):
            if m not in para_by_end and m not in ttp_ends:
                continue      # a \x07 outside a table (rare)
            if m in ttp_ends:
                edges, itap = ttp_ends[m]
                if pending:
                    strs = [self._cell_text(s, e) for s, e in pending]
                    first = pending[0][0]
                    if cur is not None and (last_row_end is None or first - last_row_end > 1):
                        tables.append(cur); cur = None
                    if cur is None:
                        cur = NativeTable(first, m + 1, [], [], nested=itap > 1)
                    cur.rows.append(strs); cur.row_cell_edges.append(edges or [])
                    cur.row_cps.append(first); cur.end_cp = m + 1
                    cur.nested = cur.nested or itap > 1
                    last_row_end = m + 1
                pending = []
            else:
                if pending: s = pending[-1][1] + 1
                elif last_row_end is not None and cur is not None: s = last_row_end
                else:
                    s = para_by_end[m]
                    while s > 0 and (s - 1) in para_by_end and text[s - 1] == '\r': s = para_by_end[s - 1]
                pending.append((s, m))
        if cur is not None: tables.append(cur)
        return tables

    def _cell_text(self, s, e):
        raw = self.text[s:e]
        # use displayed field results only
        res, stack = [], []
        for c in raw:
            if c == '\x13': stack.append('i'); continue
            if c == '\x14':
                if stack: stack[-1] = 'r'
                continue
            if c == '\x15':
                if stack: stack.pop()
                continue
            if not stack or all(x == 'r' for x in stack): res.append(c)
        s2 = ''.join(res).replace('\x0b', '\n').replace('\r', '\n').replace('\x01', '')
        return s2.strip()

    # ---- pictures ----------------------------------------------------------
    def pictures(self):
        text = self.text
        found = {}
        for a, e, g in self.chpx_runs():
            if a >= self.ccp_text: continue
            loc = None; spec = False
            for op, v in parse_grpprl(g):
                if op == 0x6A03 and len(v) == 4: loc = struct.unpack('<i', v)[0]
                elif op == 0x0855 and v and v[0] == 1: spec = True
            if loc is None or not spec or loc < 0: continue
            for cp in range(a, min(e, len(text))):
                if text[cp] == '\x01':
                    found[cp] = loc
        pics = []
        for n, (cp, loc) in enumerate(sorted(found.items()), 1):
            pics.append(self._read_picf(cp, loc, n))
        return pics

    def _read_picf(self, cp, loc, order):
        d = self.data
        if loc + 68 > len(d):
            return Picture(cp, loc, 'none', b'', order=order)
        lcb, cbh, mm = struct.unpack_from('<IHH', d, loc)
        dxa, dya, mx, my = struct.unpack_from('<hhHH', d, loc + 28)
        pic = Picture(cp, loc, 'none', b'', dxa, dya, mx, my, order)
        end = min(loc + lcb, len(d))
        p = loc + cbh
        if mm == 0x66 and p < end:  # MM_SHAPEFILE: cchPicName + name
            p += 1 + d[p]
        blip = self._find_blip(d, p, end)
        if blip:
            pic.kind, pic.blob = blip
        return pic

    def _find_blip(self, d, p, end):
        while p + 8 <= end:
            ver_inst, rtype, ln = struct.unpack_from('<HHI', d, p)
            ver = ver_inst & 0xF
            if rtype in BLIP_TYPES:
                return self._decode_blip(d, p, rtype, ln, ver_inst >> 4)
            if ver == 0xF:
                r = self._find_blip(d, p + 8, min(p + 8 + ln, end))
                if r: return r
                p += 8 + ln
            elif rtype == 0xF007:  # BSE: 36-byte header then embedded blip
                nlen = d[p + 8 + 33] if p + 8 + 34 <= end else 0
                r = self._find_blip(d, p + 8 + 36 + nlen, min(p + 8 + ln, end))
                if r: return r
                p += 8 + ln
            else:
                p += 8 + ln
        return None

    def _decode_blip(self, d, p, rtype, ln, inst):
        kind = BLIP_TYPES[rtype]
        body = d[p + 8:p + 8 + ln]
        if rtype in (0xF01A, 0xF01B, 0xF01C):
            two = (inst in (0x3D5, 0x217, 0x543, 0x6E1) or inst & 1)  # second UID present
            hdr = 16 + (16 if two else 0)
            # metafile header: cb(4) rcBounds(16) ptSize(8) cbSave(4) compression(1) filter(1)
            meta = body[hdr:hdr + 34]
            comp = meta[32]
            blob = body[hdr + 34:]
            if comp == 0:
                try: blob = zlib.decompress(blob)
                except zlib.error:
                    blob = zlib.decompressobj().decompress(blob)
            return kind, blob
        two = inst in (0x46B, 0x6E3, 0x6E1, 0x7A9, 0x7A8, 0x3D5)
        hdr = 16 + (16 if inst in (0x46B, 0x6E3, 0x7A9, 0x3D5) else 0) + 1
        return kind, body[hdr:]


def _toc_pages(doc: 'WordDoc'):
    """[(heading_cp, page)] from PAGEREF fields (last-saved TOC page numbers) tied to bookmark positions."""
    import re
    t, tb = doc.text, doc.table
    limit = min(doc.ccp_text, len(t))
    # bookmark names (SttbfBkmk) and start CPs (PlcfBkf)
    names, starts = [], []
    try:
        off, ln = doc.fc[21]
        if ln:
            p = off
            fExt, cData, cbExtra = struct.unpack_from('<HHH', tb, p); p += 6
            for _ in range(cData):
                cch = struct.unpack_from('<H', tb, p)[0]; p += 2
                names.append(tb[p:p + cch * 2].decode('utf-16le', 'replace')); p += cch * 2 + cbExtra
        off, ln = doc.fc[22]
        if ln:
            n = (ln - 4) // 8
            starts = list(struct.unpack_from(f'<{n}I', tb, off))
    except (struct.error, KeyError):
        return []
    bm = {nm: cp for nm, cp in zip(names, starts)}
    out = []
    for m in re.finditer(r'\x13\s*PAGEREF\s+(\S+)[^\x14\x15]*\x14([^\x15\x13]{0,12})\x15', t[:limit]):
        name, res = m.group(1), re.sub(r'[^0-9]', '', m.group(2))
        if name in bm and res: out.append((bm[name], int(res), m.start()))
    out.sort()
    # coherent TOC: page numbers must not decrease as position increases
    pages = [p for _, p, _ in out]
    if len(out) < 3 or any(b < a for a, b in zip(pages, pages[1:])): return []
    return [(cp, pg) for cp, pg, _ in out]


def page_locator(doc: 'WordDoc'):
    """Return f(cp) -> dict(page_min, page_max, basis) or None. Never guesses beyond the saved TOC."""
    toc = _toc_pages(doc)
    if not toc: return lambda cp: None
    t = doc.text
    heads = [cp for cp, _ in toc]
    import bisect

    def locate(cp):
        k = bisect.bisect_right(heads, cp) - 1
        if k < 0:
            return dict(page_min=1, page_max=toc[0][1], basis='before the first table-of-contents entry')
        hcp, pg = toc[k]
        hard = t.count('\x0c', hcp, cp)
        lo = pg + hard
        hi = toc[k + 1][1] if k + 1 < len(toc) else None
        if hi is not None and hi < lo: hi = lo
        return dict(page_min=lo, page_max=hi, basis='table-of-contents page of the preceding heading' + (f' + {hard} manual page break(s)' if hard else ''))
    return locate


def doc_page_count(doc: 'WordDoc'):
    """Total pages recorded in the file's SummaryInformation (PIDSI_PAGECOUNT), or None."""
    try:
        raw = doc.o.get('\x05SummaryInformation')
        nsec = struct.unpack_from('<I', raw, 24)[0]
        sec_off = struct.unpack_from('<I', raw, 44)[0]
        size, nprops = struct.unpack_from('<II', raw, sec_off)
        for i in range(nprops):
            pid, off = struct.unpack_from('<II', raw, sec_off + 8 + 8 * i)
            if pid == 14:
                vt = struct.unpack_from('<I', raw, sec_off + off)[0]
                if vt == 3: return struct.unpack_from('<i', raw, sec_off + off + 4)[0]
    except Exception:
        pass
    return None
