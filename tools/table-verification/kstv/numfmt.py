"""Render an Excel cached value as Excel would DISPLAY it (number-format engine).

Covers the formats that occur in appraisal workbooks: General, 0.00, #,##0, $ and
accounting formats (_(, _), *fill), percentages, scaling commas, scientific,
conditions/colours, text sections, and the common date/time codes.
"""
from __future__ import annotations
import re, datetime
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation

BUILTIN = {0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
           12: '# ?/?', 13: '# ??/??', 14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM',
           19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yyyy h:mm', 37: '#,##0_);(#,##0)',
           38: '#,##0_);[Red](#,##0)', 39: '#,##0.00_);(#,##0.00)', 40: '#,##0.00_);[Red](#,##0.00)',
           41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)', 42: '_($* #,##0_);_($* (#,##0);_($* "-"_);_(@_)',
           43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)',
           44: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0',
           48: '##0.0E+0', 49: '@'}
_cache: dict = {}
MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
          'November', 'December']
DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']


def _split_sections(code):
    out, cur, q, esc = [], [], False, False
    i = 0
    while i < len(code):
        c = code[i]
        if esc: cur.append(c); esc = False
        elif c == '\\': cur.append(c); esc = True
        elif c == '"': q = not q; cur.append(c)
        elif c == ';' and not q: out.append(''.join(cur)); cur = []
        else: cur.append(c)
        i += 1
    out.append(''.join(cur))
    return out


_tok = re.compile(r'"[^"]*"|\\.|_.|\*.|\[[^\]]*\]|[0#?]+|\.|,|%|E[+-]|@|General|AM/PM|A/P|am/pm|[yYmMdDhHsS]+|.', re.S)


def _tokens(sec):
    return _tok.findall(sec)


def _is_date(tokens):
    for t in tokens:
        if t[0] in '"\\_*[':
            if t.startswith('[') and re.fullmatch(r'\[(h+|m+|s+)\]', t, re.I): return True
            continue
        if re.fullmatch(r'[yYdD]+|AM/PM|A/P|am/pm', t): return True
        if re.fullmatch(r'[hHsS]+', t): return True
        if re.fullmatch(r'[mM]+', t): return True
    return False


def _pick_section(code, value):
    secs = _split_sections(code)
    cond = lambda s: re.match(r'\s*\[(<=|>=|<>|<|>|=)\s*(-?[\d.]+)\]', s)
    if len(secs) >= 2 and (cond(secs[0]) or (len(secs) > 1 and cond(secs[1]))):
        for i, s in enumerate(secs[:3]):
            m = cond(s)
            if m:
                op, n = m.group(1), float(m.group(2))
                if {'<': value < n, '>': value > n, '<=': value <= n, '>=': value >= n, '=': value == n, '<>': value != n}[op]:
                    return s, i
        return secs[-1] if len(secs) < 3 else secs[2 if len(secs) > 2 else 1], len(secs) - 1
    if len(secs) == 1: return secs[0], 0
    if value < 0: return secs[1], 1
    if value == 0 and len(secs) >= 3: return secs[2], 2
    return secs[0], 0


def _round(value, places):
    try:
        d = Decimal(repr(float(value)))
    except InvalidOperation:
        d = Decimal(0)
    q = Decimal(1).scaleb(-places)
    return d.quantize(q, rounding=ROUND_HALF_UP)


def _fmt_general(v):
    if isinstance(v, int) or float(v).is_integer():
        if abs(v) < 1e11: return str(int(v))
    s = repr(float(v))
    a = abs(v)
    if a >= 1e11 or (a < 1e-9 and a):
        m = '%.5E' % v
        mant, ex = m.split('E')
        mant = mant.rstrip('0').rstrip('.')
        return f"{mant}E{ex[0]}{abs(int(ex)):02d}"
    d = Decimal(repr(float(v)))
    digits = 10 - (len(str(int(abs(d)))) if abs(d) >= 1 else 1)
    q = _round(v, max(0, digits))
    s = format(q, 'f')
    if '.' in s: s = s.rstrip('0').rstrip('.')
    return s


def _format_number(v, sec):
    toks = _tokens(sec)
    neg = v < 0
    # strip colour/condition brackets
    toks = [t for t in toks if not (t.startswith('[') and not re.fullmatch(r'\[(h+|m+|s+)\]', t, re.I))]
    pct = sum(1 for t in toks if t == '%')
    x = abs(Decimal(repr(float(v)))) * (Decimal(100) ** pct)
    # find digit placeholders
    idx = [i for i, t in enumerate(toks) if re.fullmatch(r'[0#?]+', t)]
    sci = any(t in ('E+', 'E-') for t in toks)
    dot = next((i for i, t in enumerate(toks) if t == '.'), None)
    if not idx:
        # no placeholders: pure literal
        return ''.join(_lit(t) for t in toks), neg
    first, last = idx[0], idx[-1]
    # scaling commas: commas after last placeholder in integer part (before '.') or directly following digits at end
    scale = 0
    j = last + 1
    if dot is None or j < (dot if dot is not None else 10**9):
        while j < len(toks) and toks[j] == ',': scale += 1; j += 1
    # also commas right after the last integer placeholder before the dot
    if dot is not None:
        int_idx = [i for i in idx if i < dot]
        if int_idx:
            j = int_idx[-1] + 1; sc = 0
            while j < len(toks) and toks[j] == ',': sc += 1; j += 1
            scale = max(scale, sc)
    x = x / (Decimal(1000) ** scale)
    thousands = False
    for k in range(len(idx) - 1):  # comma between placeholders
        for t in toks[idx[k] + 1: idx[k + 1]]:
            if t == ',': thousands = True
    eidx0 = next((i for i, t in enumerate(toks) if t in ('E+', 'E-')), None)
    if eidx0 is not None:
        idx = [i for i in idx if i < eidx0]
    if dot is not None:
        int_idx = [i for i in idx if i < dot]; frac_idx = [i for i in idx if i > dot]
    else:
        int_idx, frac_idx = idx, []
    if sci:
        return _format_sci(x, toks, int_idx, frac_idx, neg), neg
    nfrac = sum(len(toks[i]) for i in frac_idx)
    q = x.quantize(Decimal(1).scaleb(-nfrac), rounding=ROUND_HALF_UP) if nfrac >= 0 else x
    s = format(q, 'f')
    ip, fp = (s.split('.') + [''])[:2]
    if int(ip or 0) == 0 and not any(c == '0' for i in int_idx for c in toks[i]): ip = ''
    # integer digit fill
    placeholders = ''.join(toks[i] for i in int_idx)
    nint = len(placeholders)
    digits = ip
    if len(digits) < nint:
        pad = placeholders[:nint - len(digits)]
        digits = ''.join('0' if c == '0' else (' ' if c == '?' else '') for c in pad) + digits
    # build output scanning tokens
    out = []
    # distribute integer digits right-to-left across int placeholder tokens
    di = len(digits)
    int_tokens = {}
    remaining = digits
    # compute per-token digit strings
    sizes = [len(toks[i]) for i in int_idx]
    parts = []
    r = len(digits)
    for n, sz in reversed(list(zip(range(len(int_idx)), sizes))):
        take = min(sz, r); parts.append(take); r -= take
    parts.reverse()
    if r > 0 and parts: parts[0] += r
    pos = 0; int_tok_str = {}
    for n, i in enumerate(int_idx):
        int_tok_str[i] = digits[pos:pos + parts[n]]; pos += parts[n]
    # thousands grouping applied on the whole integer string when thousands flag
    if thousands:
        # re-group total integer part
        whole = digits.lstrip(' ')
        g = format(int(whole) if whole.strip('0') or whole else 0, ',') if whole.strip() else ''
        # preserve zero padding
        raw = digits
        grouped = ''
        cnt = 0
        for ch in reversed(raw.rstrip()):
            if cnt and cnt % 3 == 0: grouped = ',' + grouped
            grouped = ch + grouped; cnt += 1
        lead = ' ' * (len(raw) - len(raw.lstrip(' ')))
        int_text = (lead + grouped.lstrip(' ')) if raw.strip() else ''
    else:
        int_text = None
    emitted_int = False
    fp_chars = list(fp)
    fi = 0
    for i, t in enumerate(toks):
        if i in int_idx:
            if thousands:
                if not emitted_int: out.append(int_text); emitted_int = True
            else: out.append(int_tok_str[i])
        elif i in frac_idx:
            for c in t:
                ch = fp_chars[fi] if fi < len(fp_chars) else ''
                fi += 1
                if c == '0': out.append(ch or '0')
                elif c == '#': out.append(ch if ch != '0' or any(x != '0' for x in fp_chars[fi - 1:]) else '')
                else: out.append(ch if ch != '0' or any(x != '0' for x in fp_chars[fi - 1:]) else ' ')
        elif t == ',' :
            continue
        elif t == '.':
            # drop decimal point if no fraction digits survive for '#'-only
            out.append('.')
        else: out.append(_lit(t, pct_ok=True))
    res = ''.join(out)
    if dot is not None and res.count('.') :
        # remove trailing '.' when all fraction digits suppressed
        k = res.find('.')
        after = res[k + 1:]
        if not re.match(r'\s*\d', after) and all(c in '#?0' for c in ''.join(toks[i] for i in frac_idx)) and not any(c == '0' for c in ''.join(toks[i] for i in frac_idx)):
            res = res[:k] + after
    return res, neg


def _format_sci(x, toks, int_idx, frac_idx, neg):
    nint = sum(len(toks[i]) for i in int_idx) or 1
    nfrac = sum(len(toks[i]) for i in frac_idx)
    if x == 0: exp = 0; mant = Decimal(0)
    else:
        exp = x.adjusted() - (nint - 1)
        mant = x.scaleb(-exp)
    mant = mant.quantize(Decimal(1).scaleb(-nfrac), rounding=ROUND_HALF_UP)
    s = format(mant, 'f')
    eidx = next(i for i, t in enumerate(toks) if t in ('E+', 'E-'))
    ndig = sum(len(t) for t in toks[eidx + 1:] if re.fullmatch(r'[0#?]+', t)) or 2
    sign = '-' if exp < 0 else ('+' if toks[eidx] == 'E+' else '')
    return f"{s}E{sign}{abs(exp):0{ndig}d}"


def _lit(t, pct_ok=False):
    if t.startswith('"'): return t[1:-1]
    if t.startswith('\\'): return t[1:]
    if t.startswith('_'): return ' '
    if t.startswith('*'): return ''
    if t == '%': return '%'
    if t.startswith('['): return ''
    return t


def _excel_date(v, date1904=False):
    base = datetime.datetime(1904, 1, 1) if date1904 else datetime.datetime(1899, 12, 30)
    if not date1904 and v < 61: base = datetime.datetime(1899, 12, 31) if v >= 1 else base
    return base + datetime.timedelta(days=float(v))


def _format_date(v, sec, date1904=False):
    toks = _tokens(sec)
    try: dt = _excel_date(v, date1904)
    except (OverflowError, ValueError): return '#####'
    has_ampm = any(t.upper() in ('AM/PM', 'A/P') for t in toks)
    out = []
    for i, t in enumerate(toks):
        u = t.upper()
        if t.startswith('['):
            m = re.fullmatch(r'\[(h+|m+|s+)\]', t, re.I)
            if m:
                total = float(v) * 86400
                ch = m.group(1)[0].lower()
                out.append(str(int(total // (3600 if ch == 'h' else 60 if ch == 'm' else 1))).zfill(len(m.group(1))))
            continue
        if re.fullmatch(r'[Yy]+', t): out.append(f'{dt.year:04d}' if len(t) > 2 else f'{dt.year % 100:02d}')
        elif re.fullmatch(r'[Dd]+', t):
            out.append(str(dt.day) if len(t) == 1 else f'{dt.day:02d}' if len(t) == 2 else DAYS[dt.weekday()][:3] if len(t) == 3 else DAYS[dt.weekday()])
        elif re.fullmatch(r'[Hh]+', t):
            h = dt.hour % 12 or 12 if has_ampm else dt.hour
            out.append(str(h) if len(t) == 1 else f'{h:02d}')
        elif re.fullmatch(r'[Ss]+', t): out.append(str(dt.second) if len(t) == 1 else f'{dt.second:02d}')
        elif re.fullmatch(r'[Mm]+', t):
            prev = next((x for x in reversed(toks[:i]) if re.fullmatch(r'[HhSs]+|\[h+\]', x, re.I)), None)
            nxt = next((x for x in toks[i + 1:] if re.fullmatch(r'[Ss]+', x)), None)
            between = toks[toks.index(prev) + 1:i] if prev in toks[:i] else []
            is_min = (prev is not None and all(not re.fullmatch(r'[YyDd]+', b) for b in between)) or (nxt is not None and not any(re.fullmatch(r'[YyDd]+', b) for b in toks[i + 1:toks.index(nxt, i + 1)]))
            if is_min: out.append(str(dt.minute) if len(t) == 1 else f'{dt.minute:02d}')
            else:
                out.append(str(dt.month) if len(t) == 1 else f'{dt.month:02d}' if len(t) == 2 else MONTHS[dt.month - 1][:3] if len(t) == 3 else MONTHS[dt.month - 1] if len(t) == 4 else MONTHS[dt.month - 1][0])
        elif u in ('AM/PM', 'A/P'): out.append(('PM' if dt.hour >= 12 else 'AM') if u == 'AM/PM' else ('P' if dt.hour >= 12 else 'A'))
        else: out.append(_lit(t))
    return ''.join(out)


def format_value(value, code, date1904=False):
    """Display string of a cached numeric/str/bool value under number-format `code`."""
    if value is None: return ''
    if isinstance(value, bool): return 'TRUE' if value else 'FALSE'
    code = code or 'General'
    if isinstance(value, str):
        secs = _split_sections(code)
        sec = secs[3] if len(secs) >= 4 else None
        if sec is None:
            return value
        return ''.join(value if t == '@' else _lit(t) for t in _tokens(sec))
    key = (code, date1904)
    if code.strip().lower() == 'general': return _fmt_general(value)
    sec, i = _pick_section(code, float(value))
    toks = _tokens(sec)
    if _is_date(toks):
        return _format_date(value, sec, date1904)
    if sec.strip() in ('', ';'): return ''
    if all(t in ('@',) or not re.fullmatch(r'[0#?]+|\.|E[+-]', t) for t in toks) and any(t == 'General' for t in toks):
        return ''.join(_fmt_general(value) if t == 'General' else _lit(t) for t in toks)
    if re.search(r'[0#?]\s*/\s*[0#?\d]', ''.join(toks)): return _fmt_general(value)
    s, neg = _format_number(float(value), sec)
    # sign handling: single-section negative gets '-' ; 2+ sections use own section literal
    nsec = len(_split_sections(code))
    if neg and (nsec == 1 or i == 0):
        s = '-' + s
    return s
