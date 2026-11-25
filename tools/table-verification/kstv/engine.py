"""Per-table pipeline: locate region by LABELS -> merge wrapped cells -> align -> compare -> resolve look-alike ranges."""
from __future__ import annotations
import copy
from .align import find_chains
from .premerge import premerge
from .compare import evaluate
from .normalize import text_key
from .xlsx import col_letters


def _score(res):
    st = {}
    for c in res['cells']: st[c['status']] = st.get(c['status'], 0) + 1
    compared = st.get('match', 0) + st.get('format_only', 0) + st.get('mismatch', 0) + st.get('clipped', 0)
    return (compared, -st.get('mismatch', 0))


def _mismatches(res):
    return sum(1 for c in res['cells'] if c['status'] == 'mismatch')


def _context_score(index, table, chain, res):
    """How well the Excel text around/above the region (its titles) matches the Word title and the text around the table."""
    ctx = text_key(' '.join([table.title or '', table.before or '']))      # caption-like evidence
    ctx_after = text_key(table.after or '')                                   # weaker: usually the NEXT table's title
    if not (ctx or ctx_after) or not res['excel_rows']: return 0.0
    sh = index.wb.sheet(chain.sheet)
    r1 = res['excel_rows'][0]
    cols = sorted(c['excel_col'] for c in res['columns'].values()) if res['columns'] else []
    from .xlsx import col_index
    ci = [col_index(c) for c in cols] or [0]
    lo, hi = min(ci) - 1, max(ci) + 1
    score = 0.0
    for r in range(max(1, r1 - 4), r1 + 1):
        for e in index.rows[chain.sheet].get(r, ()):
            if lo <= e.c <= hi and isinstance(e.cell.v, str):
                k = text_key(e.disp)
                if len(k) >= 5:
                    if k in ctx: score += len(k) / 10.0
                    elif k in ctx_after: score += 0.25 * len(k) / 10.0
    return score


def _describe(chain, res):
    cols = res['columns']
    c0 = cols[min(cols)]['excel_col'] if cols else '?'; c1 = cols[max(cols)]['excel_col'] if cols else '?'
    rr = res['excel_rows'] or (0, 0)
    return f"{chain.sheet}!{c0}{rr[0]}:{c1}{rr[1]}"


def analyze_table(index, table):
    chains, tw, rt = find_chains(index, table)
    if not chains: return None
    best = chains[0]
    rows_r = [r for _, r, _ in best.pairs]
    lo, hi = min(rows_r), max(rows_r)
    original = copy.deepcopy(table.rows)
    variants = []
    # variant 1: merge wrapped/multi-line cells and fuse the rows they span
    # variant 2: merge but keep rows apart (wrapped text that spills next to a neighbouring row)
    for fuse in (True, False):
        table.rows = copy.deepcopy(original)
        merged = premerge(table, index, best.sheet, lo, hi, fuse=fuse)
        if not merged and variants: break
        if merged:
            c2, tw2, rt2 = find_chains(index, table, only_sheet=best.sheet)
            chs = (c2 + [c for c in chains if c.sheet != best.sheet]) if c2 else chains
        else:
            chs, tw2, rt2 = chains, tw, rt
        res = evaluate(index, table, chs[0], rt2)
        variants.append((_score(res), fuse, copy.deepcopy(table.rows), chs, rt2, tw2, res))
        if not merged: break
    variants.sort(key=lambda v: v[0], reverse=True)
    sc, fuse, rows, chs, rt2, tw2, res = variants[0]
    table.rows = rows
    table.meta['fused_rows'] = fuse

    # ---- look-alike ranges: same labels/headings elsewhere (side by side, stacked, or on another sheet)
    cands = [dict(kind='best', chain=chs[0], res=res)]
    sib = res.get('sibling_columns')
    if sib:
        try: cands.append(dict(kind='side-by-side', chain=chs[0], res=evaluate(index, table, chs[0], rt2, force_window=(sib['lo'], sib['hi']))))
        except Exception: pass
    for a in chs[1:4]:
        if a.score >= 0.9 * chs[0].score:
            try: cands.append(dict(kind='stacked/other sheet', chain=a, res=evaluate(index, table, a, rt2)))
            except Exception: pass
    siblings, selected_by = [], None
    if len(cands) > 1:
        for c in cands: c['ctx'] = _context_score(index, table, c['chain'], c['res']); c['mism'] = _mismatches(c['res'])
        top_ctx = max(c['ctx'] for c in cands)
        pool = [c for c in cands if c['ctx'] >= top_ctx - 1e-9]
        if top_ctx > 0 and len(pool) < len(cands): selected_by = 'title / surrounding text'
        else: selected_by = 'values as a last resort (labels and titles are identical)'
        chosen = min(pool, key=lambda c: (c['mism'], cands.index(c)))   # within equal evidence prefer fewer mismatches, then the first
        if selected_by.startswith('title') and len(pool) > 1: selected_by = 'title / surrounding text, then fewest mismatches'
        for c in cands:
            if c is chosen: continue
            siblings.append(dict(kind=c['kind'], where=_describe(c['chain'], c['res']), mismatches=c['mism'], context_score=round(c['ctx'], 2)))
        res, chosen_chain = chosen['res'], chosen['chain']
        chosen_info = dict(where=_describe(chosen_chain, res), mismatches=chosen['mism'], context_score=round(chosen['ctx'], 2))
    else:
        chosen_chain, chosen_info = chs[0], None
    return dict(chain=chosen_chain, alternates=[c for c in chs if c is not chosen_chain][:2], rtoks=rt2, total_w=tw2, result=res,
                siblings=siblings, selected_by=selected_by, chosen_info=chosen_info)
