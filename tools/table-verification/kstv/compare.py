"""Evaluate one Word table against its aligned Excel region (cell by cell)."""
from __future__ import annotations
import statistics
from collections import defaultdict
from .align import find_chains, lcs_pairs, ExcelIndex, ECell
from .normalize import compare_display, text_key, parse_num
from .xlsx import col_letters, addr

TOL = 5.0


def _stats(anchors_by_col):
    st = {}
    for c, cells in anchors_by_col.items():
        if len(cells) >= 1:
            st[c] = (statistics.median(w.x0 for w in cells), statistics.median(w.x1 for w in cells),
                     statistics.median(w.xc for w in cells), len(cells))
    return st


def _consistent(w, stat, tol=None):
    if stat is None: return False
    tol = tol if tol is not None else max(TOL, 0.4 * w.h)
    L, R, C, n = stat
    return abs(w.x0 - L) <= tol or abs(w.x1 - R) <= tol or abs(w.xc - C) <= tol


def evaluate(index: ExcelIndex, table, chain, rtoks, force_window=None):
    sname = chain.sheet
    sh = index.wb.sheet(sname)
    rows = table.rows
    pairs = _interpolate(index, sname, rows, _fill_rows(index, sname, rows, chain.pairs))
    # strong/weak classification
    strong = {}
    for (i, r, sc) in pairs:
        tw = rtoks[i][2] or 1.0
        strong[i] = (sc / tw) >= 0.5 and sc > 0
    # --- column-consistent anchoring (iterative, prunes stray repeated-token columns)
    rowE_full = {i: index.rows[sname][r] for i, r, _ in pairs}
    state = {'lo': 0, 'hi': 10 ** 9}

    def getE(i):
        return [e for e in rowE_full[i] if state['lo'] <= e.c <= state['hi']]

    def run_pass(stats):
        anchors = {}
        for (i, r, sc) in pairs:
            W = rows[i]; E = getE(i)
            keys = [c.key for c in W]; ws = [index.weight(k) for k in keys]
            if stats:
                def bonus(wi, ej, W=W, E=E):
                    st = stats.get(E[ej].c)
                    if st is None or st[3] < 2: return 0.0
                    return 0.8 if _consistent(W[wi], st) else -0.6
            else: bonus = None
            _, p = lcs_pairs(keys, ws, E, bonus)
            anchors[i] = p
        return anchors

    def collect(anchors):
        byc = defaultdict(list)
        for i, p in anchors.items():
            E = getE(i)
            for wi, ej in p: byc[E[ej].c].append(rows[i][wi])
        return byc

    # --- choose the Excel column window that best explains the Word table
    if force_window: state['lo'], state['hi'] = force_window; sibling = None
    else:
        state['lo'], state['hi'] = _choose_window(index, sname, rows, pairs, rowE_full)
        sibling = _choose_window.last_alt
    anchors = run_pass(None)
    stats = {}
    for it in range(3):                      # refine repeated-token ties with x-geometry
        stats = _stats(collect(anchors))
        anchors = run_pass(stats)
    # extend over edge columns whose values ALL changed (no anchors, yet Word shows text there)
    for _ in range(4):
        stats = _stats(collect(anchors))
        if not stats: break
        Lm = min(v[0] for v in stats.values()); Rm = max(v[1] for v in stats.values())
        tolx = max(TOL, 0.4 * (rows[0][0].h if rows and rows[0] else 12))
        right = left = 0
        for (i, r, sc) in pairs:
            W = rows[i]; used = {wi for wi, _ in anchors[i]}
            for wi, w in enumerate(W):
                if wi in used: continue
                if w.x0 > Rm + tolx: right += 1
                elif w.x1 < Lm - tolx: left += 1
        content_cols = sorted({e.c for i in rowE_full for e in rowE_full[i]})
        moved = False
        if right >= max(2, len(pairs) // 4):
            nxt = next((c for c in content_cols if c > state['hi']), None)
            if nxt is not None: state['hi'] = nxt; moved = True
        if left >= max(2, len(pairs) // 4):
            prv = next((c for c in reversed(content_cols) if c < state['lo']), None)
            if prv is not None: state['lo'] = prv; moved = True
        if not moved: break
        anchors = run_pass(stats)
    byc = collect(anchors)
    stats = _stats(byc)
    col_lo, col_hi = state['lo'], state['hi']
    from collections import Counter as _C

    cells_out = []      # per word cell results
    findings = []
    paired_cols = defaultdict(int)
    word_status = {}    # (i,wi) -> record
    rowmap = {i: r for i, r, _ in pairs}
    excel_used = set()
    pairlist = {i: (r, sc) for i, r, sc in pairs}

    def rec(i, wi, ecell, status, kind='', diff='', method='', note=''):
        w = rows[i][wi]
        d = dict(row_idx=i, cell_idx=wi, merged_from=w.parts, word_row=i + 1, word_text=w.text, x0=round(w.x0, 1), x1=round(w.x1, 1), status=status, kind=kind, diff=diff,
                 method=method, note=note, sheet=sname if ecell else None)
        if ecell is not None:
            r = rowmap[i]
            d.update(excel_cell=addr(r, ecell.c), excel_row=r, excel_col=ecell.c, excel_display=ecell.disp,
                     excel_value=ecell.cell.v if not isinstance(ecell.cell.v, float) else ecell.cell.v,
                     formula=ecell.cell.f)
        word_status[(i, wi)] = d
        return d

    for (i, r, sc) in pairs:
        W = rows[i]; E = getE(i)
        anch = dict(anchors[i])             # wi -> ej
        aE = set(anch.values())
        weak = not strong[i]
        if weak:
            # accept weak rows only when an adjacent chain neighbour is strong and adjacent in Excel
            ok = False
            for (j, rj, _s) in pairs:
                if abs(j - i) == 1 and strong.get(j) and index.between(sname, min(r, rj), max(r, rj)) == 0: ok = True
            if not ok:
                for wi, ej in anch.items():
                    cmp_ = compare_display(W[wi].text, E[ej].disp, E[ej].cell.v, E[ej].cell.wrap)
                    rec(i, wi, E[ej], 'match' if cmp_.status == 'match' else cmp_.status if cmp_.status == 'format_only' else 'match', 'weak_anchor', method='anchor-weak')
                    excel_used.add((r, E[ej].c))
                continue
        # exact anchors
        for wi, ej in anch.items():
            cmp_ = compare_display(W[wi].text, E[ej].disp, E[ej].cell.v, E[ej].cell.wrap)
            st = cmp_.status if cmp_.status in ('match', 'format_only') else 'match'
            rec(i, wi, E[ej], st, 'exact', diff='', method='anchor', note=cmp_.note)
            excel_used.add((r, E[ej].c)); paired_cols[E[ej].c] += 1
        # gaps between anchors
        a_sorted = sorted(anch.items())
        bounds = [(-1, -1)] + a_sorted + [(len(W), len(E))]
        for (wa, ea), (wb, eb) in zip(bounds, bounds[1:]):
            wgap = [wi for wi in range(wa + 1, wb)]
            egap = [ej for ej in range(ea + 1, eb)]
            if not wgap and not egap: continue
            used_e = set()
            # pair by order if equal counts; else by x-consistency
            plan = []
            if len(wgap) == len(egap): plan = list(zip(wgap, egap))
            else:
                last = -1
                for wi in wgap:
                    best = None
                    for ej in egap:
                        if ej <= last: continue
                        st = stats.get(E[ej].c)
                        if _consistent(W[wi], st): best = ej; break
                    if best is not None: plan.append((wi, best)); last = best
            paired_w = {wi for wi, _ in plan}; paired_e = {ej for _, ej in plan}
            for wi, ej in plan:
                cmp_ = compare_display(W[wi].text, E[ej].disp, E[ej].cell.v, E[ej].cell.wrap)
                d = rec(i, wi, E[ej], 'clipped' if cmp_.kind == 'clipped' else cmp_.status, cmp_.kind, cmp_.diff, 'positional', cmp_.note)
                excel_used.add((r, E[ej].c)); paired_cols[E[ej].c] += 1
            for wi in wgap:
                if wi in paired_w: continue
                rec(i, wi, None, 'unmatched', 'word_only', method='none',
                    note='No Excel cell could be aligned to this Word cell')
            for ej in egap:
                if ej in paired_e: continue
                findings.append(dict(type='excel_only', word_row=i + 1, sheet=sname, excel_cell=addr(r, E[ej].c), excel_display=E[ej].disp,
                                     excel_value=E[ej].cell.v, note='Excel cell has a value that does not appear in the Word table row'))
    # Word rows not in the chain
    chain_rows = {i for i, _, _ in pairs}
    unaligned = []
    for i, row in enumerate(rows):
        if i in chain_rows: continue
        for wi, w in enumerate(row):
            word_status[(i, wi)] = dict(row_idx=i, cell_idx=wi, word_row=i + 1, word_text=w.text, x0=round(w.x0, 1), x1=round(w.x1, 1), status='unaligned', kind='row_not_found',
                                        sheet=None, note='Row not located in the Excel region')
        unaligned.append(i)
    # wrapped-text resolution: unaligned/unmatched word fragments that concatenate to an excel-only text cell
    _resolve_wrapped(index, rows, word_status, findings, rowmap, sname, anchors)
    _resolve_runs(rows, word_status)
    _resolve_outside_window(index, rows, word_status, rowmap, rowE_full, sname)
    _resolve_clipping(index, sname, rows, word_status, rowmap, rowE_full, table)
    # missing rows: visible content Excel rows inside the aligned span but not aligned
    span = sorted(r for _, r, _ in pairs)
    missing_rows = []
    if span:
        lo, hi = span[0], span[-1]
        aligned_r = set(span)
        cols_used = sorted(paired_cols)
        for r in index.content_rows[sname]:
            if lo < r < hi and r not in aligned_r:
                ecs = [e for e in index.rows[sname][r] if cols_used and cols_used[0] <= e.c <= cols_used[-1]]
                if ecs:
                    missing_rows.append(dict(type='excel_row_not_in_word', sheet=sname, excel_row=r,
                                             cells=[dict(cell=addr(r, e.c), display=e.disp) for e in ecs[:8]],
                                             note='Visible Excel row inside the matched range has no counterpart in the Word table'))
    # table columns / headers
    cols_sorted = sorted(paired_cols)
    colno = {c: k + 1 for k, c in enumerate(cols_sorted)}
    header = {}
    for c in cols_sorted:
        parts = []
        for (i, wi), d in sorted(word_status.items()):
            if d.get('excel_col') == c and parse_num(d['word_text']) is None:
                parts.append(d['word_text'])
                if len(parts) >= 2 or i > 4: break
            elif d.get('excel_col') == c: break
        header[c] = ' / '.join(parts)[:60]
    row_label = {}
    for i, row in enumerate(rows):
        lab = next((w.text for w in row if parse_num(w.text) is None), row[0].text if row else '')
        row_label[i + 1] = lab[:60]
    for (i, wi), d in word_status.items():
        if d.get('excel_col'):
            d['word_col'] = colno.get(d['excel_col'])
            d['col_header'] = header.get(d['excel_col'], '')
        d['row_label'] = row_label.get(d['word_row'], '')
        cells_out.append(d)
    cells_out.sort(key=lambda d: (d['word_row'], d['x0']))
    return dict(sibling_columns=(dict(lo=sibling[0], hi=sibling[1], excel_cols=f'{col_letters(sibling[0])}:{col_letters(sibling[1])}', score_ratio=round(sibling[2], 3)) if sibling else None), cells=cells_out, findings=findings, missing_rows=missing_rows, unaligned_rows=unaligned,
                columns={colno[c]: dict(excel_col=col_letters(c), header=header[c]) for c in cols_sorted},
                excel_rows=(span[0], span[-1]) if span else None, strong_rows=sum(strong.values()))


def _resolve_wrapped(index, rows, word_status, findings, rowmap, sname, anchors):
    """Match multi-line (wrapped) Excel text cells to stacked Word line fragments."""
    todo = [f for f in findings if f['type'] == 'excel_only' and len(str(f.get('excel_display') or '')) > 8]
    if not todo: return
    for f in todo[:]:
        target = text_key(f['excel_display'])
        wr = f['word_row'] - 1
        # (a) rich-text runs: consecutive unmatched Word cells in the SAME row that jointly equal the Excel cell
        row = rows[wr]; done = False
        for a0 in range(len(row)):
            if word_status.get((wr, a0), {}).get('status') != 'unmatched': continue
            acc = ''; chain = []
            for k in range(a0, len(row)):
                if word_status.get((wr, k), {}).get('status') != 'unmatched': break
                acc += text_key(row[k].text); chain.append(k)
                if acc == target and len(chain) > 1:
                    for k2 in chain:
                        word_status[(wr, k2)].update(status='match', kind='text_runs', sheet=f['sheet'], excel_cell=f['excel_cell'], excel_display=f['excel_display'],
                                                     excel_value=f['excel_value'], excel_col=None, method='joined-runs', note='Several text runs in Word equal one Excel cell')
                    findings.remove(f); done = True; break
                if not target.startswith(acc): break
            if done: break
        if done: continue
        # candidate start fragments: unmatched word cells in this row
        for wi, w in enumerate(rows[wr]):
            d = word_status.get((wr, wi))
            if not d or d['status'] not in ('unmatched',): continue
            acc = w.text; chain = [(wr, wi)]
            cur = w
            for nr in range(wr + 1, min(len(rows), wr + 12)):
                nxt = next(((nr, k, c) for k, c in enumerate(rows[nr]) if abs(c.x0 - cur.x0) <= max(4, 0.35 * cur.h) and word_status.get((nr, k), {}).get('status') in ('unaligned', 'unmatched')), None)
                if not nxt: break
                acc += ' ' + nxt[2].text; chain.append((nxt[0], nxt[1])); cur = nxt[2]
                if text_key(acc) == target:
                    for (ri, ci) in chain:
                        dd = word_status[(ri, ci)]
                        dd.update(status='match', kind='wrapped_text', sheet=f['sheet'], excel_cell=f['excel_cell'], excel_display=f['excel_display'],
                                  excel_value=f['excel_value'], excel_col=None, method='wrapped-lines', note='Multi-line cell matched as one Excel cell')
                    findings.remove(f); break
            else: continue
            break


def _resolve_runs(rows, word_status):
    """Rich-text runs (same row) / wrapped lines (rows below) that jointly equal one Excel text cell."""
    for key, d in list(word_status.items()):
        if d.get('status') != 'mismatch' or d.get('kind') != 'text' or not d.get('excel_display'): continue
        target = text_key(d['excel_display']); i, wi = key
        acc = text_key(d['word_text'])
        if not acc or not target.startswith(acc) or len(target) == len(acc): continue
        chain = [key]; ok = False
        # (a) following runs in same row
        for k in range(wi + 1, len(rows[i])):
            dd = word_status.get((i, k))
            if not dd or dd['status'] not in ('unmatched', 'unaligned'): break
            acc += text_key(rows[i][k].text); chain.append((i, k))
            if acc == target: ok = True; break
            if not target.startswith(acc): break
        # (b) wrapped lines below
        if not ok:
            acc = text_key(d['word_text']); chain = [key]; cur = rows[i][wi]
            for nr in range(i + 1, min(len(rows), i + 12)):
                nxt = next(((nr, k, c) for k, c in enumerate(rows[nr]) if abs(c.x0 - cur.x0) <= max(4, 0.35 * cur.h)
                            and word_status.get((nr, k), {}).get('status') in ('unaligned', 'unmatched')), None)
                if not nxt: break
                acc += text_key(nxt[2].text); chain.append((nxt[0], nxt[1])); cur = nxt[2]
                if acc == target: ok = True; break
                if not target.startswith(acc): break
        if ok:
            for ck in chain:
                dd = word_status[ck]
                dd.update(status='match', kind='text_runs', diff='', sheet=d['sheet'], excel_cell=d['excel_cell'], excel_row=d.get('excel_row'),
                          excel_display=d['excel_display'], excel_value=d.get('excel_value'), method='joined-runs',
                          note='Several text runs/lines in Word equal one Excel cell')


def _interpolate(index, sname, rows, pairs):
    """Align still-unaligned Word rows to the Excel content rows that sit between (or right after)
    aligned rows when the counts agree and the row shares a token or the same cell count."""
    pairs = sorted(pairs, key=lambda p: p[0])
    out = list(pairs)
    content = index.content_rows[sname]
    import bisect
    def rows_between(r1, r2):
        return content[bisect.bisect_right(content, r1):bisect.bisect_left(content, r2)]
    def share(i, r):
        wk = {c.key for c in rows[i]}
        return any(e.key in wk for e in index.rows[sname][r])
    def same_n(i, r):
        return abs(len(rows[i]) - len(index.rows[sname][r])) <= 1
    add = []
    for (i1, r1, _), (i2, r2, _) in zip(pairs, pairs[1:]):
        un = list(range(i1 + 1, i2)); L = rows_between(r1, r2)
        if un and len(un) == len(L):
            if all(share(i, r) or same_n(i, r) for i, r in zip(un, L)):
                add += [(i, r, 0.0) for i, r in zip(un, L)]
    if pairs:
        ilast, rlast, _ = pairs[-1]
        un = list(range(ilast + 1, len(rows)))
        L = content[bisect.bisect_right(content, rlast):]
        k = 0
        for i in un:
            if k < len(L) and share(i, L[k]): add.append((i, L[k], 0.0)); k += 1
            else: break
    return sorted(out + add, key=lambda p: p[0])


def _is_label_key(k):
    return k.startswith('t:') or (k.startswith('n:') and len(k) == 6 and k[2:].isdigit() and 1900 <= int(k[2:]) <= 2100)


def _choose_window(index, sname, rows, pairs, rowE_full, lam=0.6):
    """Best contiguous window of Excel content columns for the aligned rows.

    score(window) = idf-weighted Word cells the window explains  -  lam * idf-weighted Excel
    cells inside the window that the Word table does not show.  Ties -> leftmost, then narrowest.
    A second, LABEL-ONLY score (numbers ignored) detects sibling ranges: other disjoint windows that
    carry the same labels/headings, which numbers alone must not be allowed to arbitrate silently.
    """
    from collections import Counter
    _choose_window.last_alt = None
    content_cols = sorted({e.c for i in rowE_full for e in rowE_full[i]})
    if not content_cols: return 0, 10 ** 9
    wkeys = {i: Counter(c.key for c in rows[i]) for i, _, _ in pairs}
    by_col = defaultdict(list)                       # col -> [(row_i, key, weight, is_label)]
    for i, _, _ in pairs:
        for e in rowE_full[i]: by_col[e.c].append((i, e.key, index.weight(e.key), _is_label_key(e.key)))
    cand = [c for c in content_cols if any(k in wkeys[i] for i, k, _, _ in by_col[c])]
    if not cand: return content_cols[0], content_cols[-1]
    best = None
    allw = []
    for lo in cand:
        seen = {i: Counter() for i in wkeys}
        matched = excess = ml = el = 0.0
        for c in content_cols:
            if c < lo: continue
            for i, k, w, lab in by_col[c]:
                seen[i][k] += 1
                ok = seen[i][k] <= wkeys[i].get(k, 0)
                if ok: matched += w
                else: excess += w
                if lab:
                    if ok: ml += w
                    else: el += w
            if c in cand:
                key = (round(matched - lam * excess, 6), -lo, -(c - lo))
                allw.append((key, lo, c, ml - lam * el))
                if best is None or key > best[0]: best = (key, lo, c)
    _choose_window.last_alt = None
    if best and best[0][0] > 0:
        bl, bh = best[1], best[2]
        best_label = next(w[3] for w in allw if w[1] == bl and w[2] == bh)
        if best_label > 0:
            alts = [w for w in allw if (w[2] < bl or w[1] > bh) and w[3] >= 0.90 * best_label]
            if alts:
                a = max(alts, key=lambda w: (w[3], -w[1]))
                _choose_window.last_alt = (a[1], a[2], a[3] / best_label)
    return best[1], best[2]


def _fill_rows(index, sname, rows, pairs):
    """Phase 2 (region already fixed by LABELS): place still-unaligned Word rows on the Excel content rows
    that lie between/next to aligned neighbours, using full-strength token evidence."""
    import bisect
    pairs = sorted(pairs, key=lambda p: p[0])
    if not pairs: return pairs
    content = index.content_rows[sname]
    aligned = {i for i, _, _ in pairs}
    used = {r for _, r, _ in pairs}

    def score(i, r):
        keys = [c.key for c in rows[i]]; ws = [index.weight_full(k) for k in keys]
        sub = [e for e in index.rows[sname][r] if e.key in set(keys)]
        sc, _p = lcs_pairs(keys, ws, sub)
        return sc

    def assign(U, L):
        # monotone max-weight matching of Word rows U to Excel rows L (both ascending)
        if not U or not L: return []
        S = [[score(u, l) for l in L] for u in U]
        n, m = len(U), len(L)
        dp = [[0.0] * (m + 1) for _ in range(n + 1)]
        for a in range(1, n + 1):
            for b in range(1, m + 1):
                v = dp[a - 1][b - 1] + (S[a - 1][b - 1] if S[a - 1][b - 1] >= 0.5 else -1)
                dp[a][b] = max(dp[a - 1][b], dp[a][b - 1], v)
        out = []; a, b = n, m
        while a and b:
            if S[a - 1][b - 1] >= 0.5 and abs(dp[a][b] - (dp[a - 1][b - 1] + S[a - 1][b - 1])) < 1e-9: out.append((U[a - 1], L[b - 1], S[a - 1][b - 1])); a -= 1; b -= 1
            elif dp[a - 1][b] >= dp[a][b - 1]: a -= 1
            else: b -= 1
        return out[::-1]
    add = []
    for (i1, r1, _), (i2, r2, _) in zip(pairs, pairs[1:]):
        U = [i for i in range(i1 + 1, i2) if i not in aligned]
        L = [r for r in content[bisect.bisect_right(content, r1):bisect.bisect_left(content, r2)] if r not in used]
        add += assign(U, L)
    # head and tail (bounded window next to the aligned span)
    i0, r0, _ = pairs[0]; U = list(range(0, i0))
    if U:
        k = bisect.bisect_left(content, r0); L = content[max(0, k - len(U) - 3):k]; add += assign(U, L)
    il, rl, _ = pairs[-1]; U = list(range(il + 1, len(rows)))
    if U:
        k = bisect.bisect_right(content, rl); L = content[k:k + len(U) + 3]; add += assign(U, L)
    return sorted(pairs + [(i, r, 0.0) for i, r, _ in add], key=lambda p: p[0])


def _blocked_right(index, sname, r, c):
    """True if the cell at (r,c) cannot overflow: the next visible column of that row (after any merge) is non-empty."""
    sh = index.wb.sheet(sname)
    right = c
    for (r1, c1, r2, c2) in sh.merges:
        if r1 <= r <= r2 and c1 == c: right = c2; break
    nxt = right + 1
    while nxt in sh.hidden_cols: nxt += 1
    cell = sh.cells.get((r, nxt))
    return bool(cell and str(cell.disp).strip())


def _resolve_clipping(index, sname, rows, word_status, rowmap, rowE_full, table):
    """Decide, from picture geometry, whether a shortened Word text is genuine visual clipping.

    confirmed   : the next word of the Excel text does not fit before the next cell / the text reaches
                  as far right as other fully shown text in the same column
    wrapped     : several wrapped lines match the start of the Excel text; further lines hidden by row height
    consistent  : no spare room visible for the rest (not provable from geometry alone)
    unconfirmed : there seemed to be room for more text -> flagged for a human look
    contradicted: other text of the same width fits in that column -> reported as a real discrepancy
    """
    sh = index.wb.sheet(sname)
    width = table.width or 0
    ref = defaultdict(list)       # excel_col -> x1 of fully shown, edge-blocked cells
    for (i, wi), d in word_status.items():
        if d.get('status') == 'match' and d.get('excel_col') and d.get('method') in ('anchor', 'positional') and d.get('kind') != 'wrapped_text':
            r = rowmap.get(i); w = rows[i][wi]
            if r and w.merged_lines == 1 and len(w.text) >= 4 and _blocked_right(index, sname, r, d['excel_col']):
                ref[d['excel_col']].append(w.x1)
    for (i, wi), d in word_status.items():
        if d.get('status') != 'clipped': continue
        w = rows[i][wi]; r = rowmap[i]; c = d['excel_col']
        cell = sh.cells.get((r, c))
        full = text_key(str(d.get('excel_display') or '')); seen = text_key(w.text)
        remainder = max(0, len(full) - len(seen))
        avg = max(1.0, (w.x1 - w.x0) / max(1, len(w.text)))
        nxt = [x for x in rows[i] if x.x0 > w.x1 + 1]
        limit = min((x.x0 for x in nxt), default=width or (w.x1 + 10 ** 6))
        if w.merged_lines > 1:
            d.update(clip_confidence='wrapped', note='Wrapped over several lines: the visible lines match the start of the Excel text; the remaining lines are hidden by the row height in the Word picture.')
            continue
        if cell is not None and cell.wrap:
            rest = str(d.get('excel_display') or '')
            tail = rest[len(w.text.rstrip()):].split() if rest.lower().startswith(w.text.lower().rstrip()) else rest.split()[-1:]
            nxt_w = (len(tail[0]) + 1) * avg if tail else 0
            room = limit - w.x1 - 3
            if nxt_w > room:
                d.update(clip_confidence='confirmed', note=f'Clipped at the cell edge: the next word does not fit in the remaining {room:.0f}px before the next cell (needs about {nxt_w:.0f}px).')
            else:
                d.update(clip_confidence='unconfirmed', note='Word text is shorter than Excel text and the next word looked like it would have fitted - check this cell visually.')
            continue
        refs = ref.get(c, [])
        if _blocked_right(index, sname, r, c) and refs:
            L = max(refs)
            if w.x1 >= L - 1.5 * avg:
                d.update(clip_confidence='confirmed', note='Clipped at the cell edge: the text reaches as far right as other fully shown text in the same column.')
            else:
                d.update(status='mismatch', kind='text', clip_confidence=None, diff='Word text is shorter than Excel text although other text of equal length fits in that same column (not just visual clipping)')
            continue
        room = limit - w.x1
        if room < remainder * avg + 0.6 * w.h:
            d.update(clip_confidence='consistent', note='Shortened text; there was not room for the rest before the next cell, consistent with clipping (not provable from geometry alone).')
        else:
            d.update(clip_confidence='unconfirmed', note='Word text is shorter than Excel text and there appeared to be room for more - check this cell visually.')


_choose_window.last_alt = None


def _resolve_outside_window(index, rows, word_status, rowmap, rowE_full, sname):
    """Longer Word text (>= 8 chars, e.g. a footnote) that was not located may sit in the same aligned Excel row just
    outside the column window, or (for a Word row that matched no Excel row) a few rows around the matched range.
    Short tokens are never matched this way (they could belong to another panel)."""
    from .xlsx import addr
    if not rowmap: return
    lo, hi = min(rowmap.values()), max(rowmap.values())
    for i, row in enumerate(rows):
        pend = [k for k in range(len(row)) if word_status.get((i, k), {}).get('status') in ('unmatched', 'unaligned')]
        if not pend: continue
        cand_rows = [rowmap[i]] if i in rowmap else list(range(max(1, lo - 3), hi + 13))
        used = {d.get('excel_cell') for (ri, _), d in word_status.items() if ri == i and d.get('excel_cell')}
        for a0 in pend:
            if word_status[(i, a0)]['status'] not in ('unmatched', 'unaligned'): continue
            acc = ''; chain = []
            for k in range(a0, len(row)):
                if word_status.get((i, k), {}).get('status') not in ('unmatched', 'unaligned'): break
                acc += text_key(row[k].text); chain.append(k)
                if len(acc) < 8: continue
                hit = None
                for rr in cand_rows:
                    for e in index.rows[sname].get(rr, ()):
                        if addr(rr, e.c) not in used and text_key(e.disp) == acc: hit = (rr, e); break
                    if hit: break
                if hit:
                    rr, e = hit
                    k_end = chain[-1] + 1                      # absorb trailing punctuation-only runs ('.', ')') of the same text
                    while k_end < len(row) and not any(ch.isalnum() for ch in row[k_end].text) and word_status.get((i, k_end), {}).get('status') in ('unmatched', 'unaligned'):
                        chain.append(k_end); k_end += 1
                    for k2 in chain:
                        word_status[(i, k2)].update(status='match', kind='text_runs' if len(chain) > 1 else 'exact', sheet=sname, excel_cell=addr(rr, e.c), excel_row=rr,
                                                    excel_display=e.disp, excel_value=e.cell.v, method='located-near-region',
                                                    note='Located by its text in the Excel region (outside the main column range / next to the matched rows)')
                    break
        # pure-punctuation cells (e.g. a literal "") only inside an ALREADY aligned Excel row, by exact text
        if i in rowmap:
            for k in pend:
                d = word_status.get((i, k), {})
                if d.get('status') not in ('unmatched', 'unaligned') or any(ch.isalnum() for ch in row[k].text): continue
                for e in index.rows[sname].get(rowmap[i], ()):
                    if addr(rowmap[i], e.c) not in used and e.disp.strip() == row[k].text.strip():
                        d.update(status='match', kind='exact', sheet=sname, excel_cell=addr(rowmap[i], e.c), excel_row=rowmap[i], excel_display=e.disp,
                                 excel_value=e.cell.v, method='same-row-exact', note='Exact text found in the aligned Excel row')
                        used.add(addr(rowmap[i], e.c)); break
