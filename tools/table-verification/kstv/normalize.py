"""Text/number normalisation and display-aware value comparison (Word vs Excel)."""
from __future__ import annotations
import re, unicodedata
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
from dataclasses import dataclass

_ws = re.compile(r'\s+')
_num = re.compile(r'^\(?\s*[-+]?\s*[$€£]?\s*[-+]?\s*(\d[\d,]*\.?\d*|\.\d+)\s*(%|x|X)?\s*\)?$')
DASHES = {'-', '–', '—', '$-', '$ -', '$–', '- ', '($-)', '(-)'}


def clean(s: str) -> str:
    s = unicodedata.normalize('NFKC', s or '').replace('\xa0', ' ')
    return _ws.sub(' ', s).strip()


@dataclass(frozen=True)
class Num:
    value: Decimal       # as displayed, percent kept as printed (e.g. 5.1 for "5.1%")
    decimals: int
    percent: bool
    negative_paren: bool
    suffix: str = ''


def parse_num(s: str):
    t = clean(s).replace(' ', '')
    if t in ('-', '–', '—', '$-', '$–', '(-)', '($-)'):
        return Num(Decimal(0), 0, False, False, 'dash')
    m = re.fullmatch(r'(\(?)([-+]?)([$€£]?)([-+]?)(\d[\d,]*\.?\d*|\.\d+)(%|x|X)?(\)?)', t)
    if not m: return None
    lp, sg1, cur, sg2, digits, suf, rp = m.groups()
    if bool(lp) != bool(rp): return None
    raw = digits.replace(',', '')
    try: v = Decimal(raw)
    except InvalidOperation: return None
    dec = len(raw.split('.')[1]) if '.' in raw else 0
    neg = sg1 == '-' or sg2 == '-' or bool(lp)
    if neg: v = -v
    return Num(v, dec, suf == '%', bool(lp), suf if suf in ('x', 'X') else '')


def key_of(s: str) -> str:
    """Stable lookup key: numbers by displayed value, text by case-folded alnum."""
    n = parse_num(s)
    if n is not None:
        if n.suffix == 'dash': return 'n:0'
        return ('p:' if n.percent else 'n:') + format(n.value, 'f')
    t = clean(s).casefold()
    t = re.sub(r'[^0-9a-z%$#/&.]+', '', t)
    return 't:' + t


def text_key(s: str) -> str:
    return re.sub(r'[^0-9a-z]+', '', clean(s).casefold())


def _round_dec(x: Decimal, places: int) -> Decimal:
    return x.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)


@dataclass
class Cmp:
    status: str           # 'match' | 'format_only' | 'mismatch'
    kind: str = ''        # numeric/text/missing...
    note: str = ''
    diff: str = ''


def compare_display(word_text: str, excel_disp: str, excel_value=None, wrap=False) -> Cmp:
    """Compare what Word shows to what Excel displays, honouring displayed rounding."""
    w, e = clean(word_text), clean(excel_disp)
    if w == e: return Cmp('match', 'exact')
    wn, en = parse_num(w), parse_num(e)
    if wn is not None and (en is not None or isinstance(excel_value, (int, float))):
        # compare numerically at the precision Word DISPLAYS
        if wn.suffix == 'dash':
            ez = (en is not None and en.value == 0) or (isinstance(excel_value, (int, float)) and abs(excel_value) < 0.5 * 10 ** -(wn.decimals))
            return Cmp('match', 'numeric', 'dash=zero') if ez else Cmp('mismatch', 'numeric', diff=f'Word shows "-" (zero); Excel {e}')
        if isinstance(excel_value, (int, float)) and not isinstance(excel_value, bool):
            ev = Decimal(repr(float(excel_value)))
            if wn.percent:
                ev = ev * 100 if (en is None or en.percent or abs(ev) <= 10) else ev
                if en is not None and not en.percent:  # Excel shows plain number where Word shows percent
                    ev = Decimal(repr(float(excel_value))) * (100 if abs(float(excel_value)) <= 10 else 1)
            ev_r = _round_dec(ev, wn.decimals)
            if ev_r == wn.value:
                return Cmp('format_only' if (en is None or en.decimals != wn.decimals or en.percent != wn.percent) else 'match', 'numeric', 'same value at displayed precision')
            # near-miss caused by Excel display rounding vs raw value (value consistent with displayed text)
            if en is not None and en.value == wn.value and en.percent == wn.percent:
                return Cmp('match', 'numeric')
            diff = wn.value - ev_r
            return Cmp('mismatch', 'numeric', diff=f'difference {format(diff, "f")}')
        if en is not None:
            e_val = en.value
            if _round_dec(e_val, wn.decimals) == wn.value and en.percent == wn.percent:
                return Cmp('format_only', 'numeric')
            return Cmp('mismatch', 'numeric', diff=f'difference {format(wn.value - e_val, "f")}')
    wt, et = text_key(w), text_key(e)
    if wt != et and len(wt) >= 4 and et.startswith(wt) and parse_num(w) is None:
        return Cmp('format_only', 'clipped', 'Word shows only the leading part of the Excel text (Excel clips text at the cell edge / row height)')
    if wt == et: return Cmp('format_only', 'text', 'differs only in punctuation/spacing/case')
    return Cmp('mismatch', 'text')
