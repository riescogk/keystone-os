"""Word-table -> Excel-region alignment and cell-by-cell comparison.

Design (replaces the old heuristic matchers):
  1. Inverted index of every displayed Excel cell (label/number keys, idf weights).
  2. Per Word row: candidate Excel rows (shared distinctive tokens), scored by an
     ORDERED weighted LCS (so a label + its values must appear in the same order).
  3. Per sheet: a monotone chain DP aligns Word rows -> Excel rows (hidden rows are
     skipped, skipped content rows are penalised).  Best sheet/region wins; a runner-up
     region is recorded so ambiguity is reported, never hidden.
  4. Columns: ordered LCS anchors, then a geometry-consistency refinement
     (left/right/centre x of Word text vs. already-anchored columns).
  5. Every Word cell in an aligned row is compared with its Excel cell using
     Excel's DISPLAY text and Word's displayed precision.  Excel cells inside the
     aligned range that Word does not show are reported separately.
"""
from __future__ import annotations
import bisect, math
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from .normalize import key_of, parse_num, compare_display, text_key, clean
from .xlsx import col_letters, addr


@dataclass
class ECell:
    c: int
    key: str
    disp: str
    cell: object


class ExcelIndex:
    def __init__(self, wb):
        self.wb = wb
        self.rows = {}            # sheet -> {r: [ECell]}  (visible cols only, non-empty display)
        self.content_rows = {}    # sheet -> sorted list of visible rows with content
        self.post = defaultdict(list)
        self.freq = Counter()
        self.longtext = defaultdict(set)   # first-6-chars of alnum key -> set of full alnum keys (wrapped/multi-line candidates)
        for name in wb.names:
            sh = wb.sheet(name)
            rows = defaultdict(list)
            for (r, c), cell in sh.cells.items():
                if c in sh.hidden_cols: continue
                d = cell.disp
                if d is None or str(d).strip() == '': continue
                k = key_of(str(d))
                rows[r].append(ECell(c, k, str(d), cell))
                if isinstance(cell.v, str) and (len(d) >= 9 or '\n' in d):
                    ak = text_key(str(d))
                    if len(ak) >= 6: self.longtext[ak[:6]].add(ak)
            for r in rows: rows[r].sort(key=lambda e: e.c)
            self.rows[name] = rows
            vis = sorted(r for r in rows if r not in sh.hidden_rows)
            self.content_rows[name] = vis
            for r in vis:
                for e in rows[r]:
                    self.post[e.key].append((name, r))
                    self.freq[e.key] += 1

    def weight(self, key: str) -> float:
        f = max(1, self.freq.get(key, 1))
        idf = 1.0 / (1.0 + 0.35 * math.log(f))
        return _base_weight(key) * (0.35 + 0.65 * idf)

    def weight_full(self, key: str) -> float:
        f = max(1, self.freq.get(key, 1))
        return _base_weight_full(key) * (0.35 + 0.65 / (1.0 + 0.35 * math.log(f)))

    def between(self, sheet, r1, r2):
        lst = self.content_rows[sheet]
        return max(0, bisect.bisect_left(lst, r2) - bisect.bisect_right(lst, r1))


NUMERIC_WEIGHT = 0.18          # numbers are what is being AUDITED: they must not decide where a table is


def _is_year(body: str) -> bool:
    return len(body) == 4 and body.isdigit() and 1900 <= int(body) <= 2100


def _base_weight_full(key: str) -> float:
    """Old full-strength weighting; used ONLY to place rows inside an already-located region."""
    kind, _, body = key.partition(':')
    if kind == 't':
        n = len(body); return 0.5 if n < 3 else 1.0 + min(n, 40) / 20.0
    digits = sum(ch.isdigit() for ch in body)
    w = 0.5 if digits <= 2 else 1.1 if digits == 3 else 1.6
    if '.' in body: w += 0.4
    return w + (0.3 if kind == 'p' else 0)


def _base_weight(key: str) -> float:
    """Labels/headings carry the evidence; numbers are only a weak tie-breaker."""
    kind, _, body = key.partition(':')
    if kind == 't':
        n = len(body)
        return 0.5 if n < 3 else 1.0 + min(n, 40) / 20.0
    if kind == 'n' and _is_year(body): return 1.0          # year column headings are labels
    return NUMERIC_WEIGHT + (0.05 if '.' in body else 0.0)


def lcs_pairs(wkeys, wweights, ecells, bonus=None):
    """Ordered weighted LCS. Returns (score, [(wi, ei)])."""
    n, m = len(wkeys), len(ecells)
    if not n or not m: return 0.0, []
    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        wi = wkeys[i - 1]
        for j in range(1, m + 1):
            best = dp[i - 1][j] if dp[i - 1][j] >= dp[i][j - 1] else dp[i][j - 1]
            if wi == ecells[j - 1].key:
                w = wweights[i - 1] * (1.0 + (bonus(i - 1, j - 1) if bonus else 0.0))
                v = dp[i - 1][j - 1] + w
                if v > best: best = v
            dp[i][j] = best
    out = []; i, j = n, m
    while i and j:
        if wkeys[i - 1] == ecells[j - 1].key:
            w = wweights[i - 1] * (1.0 + (bonus(i - 1, j - 1) if bonus else 0.0))
            if abs(dp[i][j] - (dp[i - 1][j - 1] + w)) < 1e-9:
                out.append((i - 1, j - 1)); i -= 1; j -= 1; continue
        if dp[i - 1][j] >= dp[i][j - 1]: i -= 1
        else: j -= 1
    out.reverse()
    return dp[n][m], out


@dataclass
class Chain:
    sheet: str
    pairs: list            # (word_row_idx, excel_row, lcs_weight)
    score: float
    cover: float = 0.0
    vertical_sibling: bool = False


def find_chains(index: ExcelIndex, table, topk=3, only_sheet=None):
    rows = table.rows
    n = len(rows)
    rtoks = []
    for r in rows:
        keys = [c.key for c in r]
        ws = [index.weight(k) for k in keys]
        rtoks.append((keys, ws, sum(ws)))
    total_w = sum(t[2] for t in rtoks) or 1.0
    # candidate rows per sheet
    per_sheet = defaultdict(lambda: defaultdict(float))
    for i, (keys, ws, tw) in enumerate(rtoks):
        has_label = any(k.startswith('t:') or (k.startswith('n:') and _is_year(k[2:])) for k in keys)
        for k, w in zip(keys, ws):
            if has_label and not (k.startswith('t:') or (k.startswith('n:') and _is_year(k[2:]))): continue
            posts = index.post.get(k)
            if not posts or len(posts) > 600: continue
            for sr in set(posts):
                per_sheet[sr[0]][(i, sr[1])] += w
    sheet_rank = sorted(per_sheet, key=lambda s: -sum(sorted(per_sheet[s].values(), reverse=True)[:60]))
    if only_sheet: sheet_rank = [s for s in sheet_rank if s == only_sheet]
    chains = []
    for sname in sheet_rank[:12]:
        cands = defaultdict(list)
        scored = sorted(per_sheet[sname].items(), key=lambda kv: -kv[1])[:n * 25]
        for (i, r), _ in scored:
            keys, ws, tw = rtoks[i]
            ecs = index.rows[sname][r]
            sub = [e for e in ecs if e.key in set(keys)]
            sc, _p = lcs_pairs(keys, ws, sub)
            if sc <= 0: continue
            cov = sc / tw if tw else 0
            if sc >= 0.8 and (cov >= 0.3 or sc >= 2.0):
                cands[i].append((r, sc))
        if not cands: continue
        ch = _chain_dp(index, sname, cands, n)
        if ch:
            ch.cover = sum(s for _, _, s in ch.pairs) / total_w
            chains.append(ch)
            rr = [r for _, r, _ in ch.pairs]
            ch2 = _chain_dp(index, sname, cands, n, banned=(min(rr) - 1, max(rr) + 1))   # stacked sibling block (same labels elsewhere)
            if ch2 and ch2.score >= 0.7 * ch.score:
                ch2.cover = sum(s for _, _, s in ch2.pairs) / total_w
                ch2.vertical_sibling = True
                chains.append(ch2)
    chains.sort(key=lambda c: -c.score)
    return chains[:topk], total_w, rtoks


def _chain_dp(index, sname, cands, n, banned=None):
    nodes = []   # (i, r, sc)
    by_row = defaultdict(list)
    for i in range(n):
        for r, sc in cands.get(i, []):
            if banned and banned[0] <= r <= banned[1]: continue
            by_row[i].append(len(nodes)); nodes.append((i, r, sc))
    if not nodes: return None
    best = [0.0] * len(nodes); prev = [-1] * len(nodes)
    for idx, (i, r, sc) in enumerate(nodes):
        best[idx] = sc
        for j in range(i - 1, max(-1, i - 15), -1):
            for pidx in by_row.get(j, []):
                pi, pr, psc = nodes[pidx]
                if pr >= r: continue
                skipped_w = i - j - 1
                g = index.between(sname, pr, r)
                if g - skipped_w > 6: continue
                pen = 0.3 * max(0, g - skipped_w) + 0.6 * max(0, skipped_w - g)
                v = best[pidx] + sc - pen
                if v > best[idx]: best[idx] = v; prev[idx] = pidx
    top = max(range(len(nodes)), key=lambda k: best[k])
    chain = []; k = top
    while k != -1:
        chain.append(nodes[k]); k = prev[k]
    chain.reverse()
    return Chain(sname, chain, best[top])
