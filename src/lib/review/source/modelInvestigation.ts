import type { ModelReviewProvider } from "@/lib/review/model/provider";
import type { ModelFindingDraft, PageText, SourceReference } from "@/lib/review/types";
import { formatWorkbookValue, classifyNumberFormat, type WorkbookFigure } from "@/lib/review/source/figures";
import { rangeReference } from "@/lib/review/source/cellRef";
import type { CellRecord, WorkbookModel } from "@/lib/review/source/workbookModel";

/**
 * Bounded, model-assisted source investigation. This is deliberately a SECOND
 * tier after deterministic linking: the model never sees the whole workbook,
 * only compact workbook regions whose explicit name/label is also present in
 * the report. A returned finding is grounded again in ordinary code.
 */
export const SOURCE_MODEL_CHECK_VERSION = "source-workbook-context-v1";
const MAX_CANDIDATES = 12;
const MAX_CELLS_PER_CANDIDATE = 24;
const MAX_FINDINGS = 3;
const MAX_OUTPUT_TOKENS = 3000;
const TIMEOUT_MS = 30_000;

export interface SourceModelCandidate {
  id: string;
  key: string;
  page: number;
  reportText: string;
  sheet: string;
  range: string;
  definedName: string | null;
  table: string | null;
  cells: CellRecord[];
}

function normalize(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 350);
  const end = Math.min(text.length, index + length + 650);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}
function linkable(cell: CellRecord): boolean {
  return cell.type === "number" && typeof cell.value === "number" && !cell.uncached && !cell.externalFormula && !["date","text"].includes(classifyNumberFormat(cell.numberFormat));
}
function display(cell: CellRecord): string {
  if (typeof cell.value !== "number") return String(cell.value ?? "");
  const kind = classifyNumberFormat(cell.numberFormat);
  return formatWorkbookValue({ value: cell.value, kind } as WorkbookFigure);
}

export function selectSourceModelCandidates(pages: PageText[], model: WorkbookModel): SourceModelCandidate[] {
  const candidates: SourceModelCandidate[] = [];
  const seen = new Set<string>();
  const add = (key: string, sheet: string, range: string, definedName: string | null, table: string | null, cells: CellRecord[]) => {
    if (candidates.length >= MAX_CANDIDATES || seen.has(`${sheet}!${range}|${key}`)) return;
    const normalizedKey = normalize(key);
    if (normalizedKey.length < 4) return;
    for (const page of pages) {
      const hay = normalize(page.text);
      const idxNorm = hay.indexOf(normalizedKey);
      if (idxNorm < 0) continue;
      // Locate a case-insensitive literal occurrence in original text when possible.
      const literal = page.text.toLowerCase().indexOf(key.toLowerCase());
      const excerpt = excerptAround(page.text, literal >= 0 ? literal : 0, key.length);
      const usable = cells.filter(linkable).slice(0, MAX_CELLS_PER_CANDIDATE);
      if (usable.length === 0) return;
      candidates.push({ id: `S${candidates.length + 1}`, key, page: page.pageNumber, reportText: excerpt, sheet, range, definedName, table, cells: usable });
      seen.add(`${sheet}!${range}|${key}`);
      return;
    }
  };

  for (const d of model.definedNames) {
    if (!d.resolved) continue;
    const sheet = model.sheets.find(s => s.name === d.resolved!.sheet);
    if (!sheet) continue;
    const r = d.resolved.range;
    const cells = sheet.cells.filter(c => c.row >= r.startRow && c.row <= r.endRow && c.col >= r.startCol && c.col <= r.endCol);
    add(d.name, sheet.name, rangeReference(r), d.name, null, cells);
  }
  for (const sheet of model.sheets) for (const table of sheet.tables) {
    const r = table.range;
    const cells = sheet.cells.filter(c => c.row >= r.startRow && c.row <= r.endRow && c.col >= r.startCol && c.col <= r.endCol);
    add(table.displayName ?? table.name, sheet.name, rangeReference(r), null, table.name, cells);
  }
  return candidates;
}

const SCHEMA: Record<string, unknown> = {
  type: "object", additionalProperties: false, required: ["findings"], properties: {
    findings: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["source_id","report_quote","description"], properties: {
        source_id: { type: "string" }, report_quote: { type: "string" }, description: { type: "string" }
      }
    }}
  }
};

const INSTRUCTIONS = `You are checking whether a commercial appraisal REPORT statement conflicts with a small, explicitly related SOURCE WORKBOOK region. Each item has a source id, a report excerpt, and workbook cells selected because a defined name or Excel table name appears in the report.

Report a finding ONLY when the report excerpt makes a concrete factual/numeric statement and the supplied workbook evidence directly contradicts that same fact. Do not judge valuation reasonableness, cap-rate selection, adjustments, methodology, or appraisal conclusions. Do not infer from missing data. Do not use outside knowledge. If the relationship or meaning is ambiguous, return no finding.

For each finding cite one source_id and copy a short report_quote EXACTLY from that source's report excerpt. Description must neutrally state the discrepancy in <= 40 words. Return at most 3 findings. JSON only.`;

function buildInput(candidates: SourceModelCandidate[]): string {
  return candidates.map(c => {
    const cells = c.cells.map(cell => `${cell.ref}=${display(cell)}${cell.formula ? ` [formula ${cell.formula}]` : ""}`).join("; ");
    return `[${c.id}] key=${JSON.stringify(c.key)} workbook=${JSON.stringify(c.sheet + "!" + c.range)}\nREPORT page ${c.page}: ${c.reportText}\nWORKBOOK: ${cells}`;
  }).join("\n\n");
}

function quoteGrounded(candidate: SourceModelCandidate, quote: string): boolean {
  const q = quote.replace(/\s+/g," ").trim().toLowerCase();
  return q.length >= 8 && q.length <= 240 && candidate.reportText.toLowerCase().replace(/\s+/g," ").includes(q);
}

export async function runSourceModelInvestigation(pages: PageText[], model: WorkbookModel, fileName: string, provider: ModelReviewProvider): Promise<ModelFindingDraft[]> {
  const candidates = selectSourceModelCandidates(pages, model);
  if (candidates.length === 0) return [];
  const response = await provider.generateStructured({ instructions: INSTRUCTIONS, input: buildInput(candidates), schemaName: "source_workbook_context_findings", jsonSchema: SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: TIMEOUT_MS });
  if (!response.ok) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(response.text); } catch { return []; }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as {findings?:unknown}).findings)) return [];
  const raw = (parsed as {findings: unknown[]}).findings;
  if (raw.length > MAX_FINDINGS) return [];
  const drafts: ModelFindingDraft[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string,unknown>;
    if (typeof r.source_id !== "string" || typeof r.report_quote !== "string" || typeof r.description !== "string") continue;
    const candidate = candidates.find(c => c.id === r.source_id);
    if (!candidate || !quoteGrounded(candidate, r.report_quote)) continue;
    const description = r.description.replace(/\s+/g," ").trim();
    if (!description || description.length > 320) continue;
    const first = candidate.cells[0];
    const ref: SourceReference = { workbook: fileName.slice(0,200), sheet: candidate.sheet, cell: first.ref, definedName: candidate.definedName, label: candidate.key, table: candidate.table, formula: first.formula?.slice(0,200) ?? null, value: display(first), linkedBy: "model_context", range: candidate.range, header: null };
    drafts.push({ category: "source_workbook_discrepancy", severity: "moderate", confidence: "model_based", description: `Possible source-workbook conflict — worth a second look: ${description}`, evidence: `Page ${candidate.page}: "${r.report_quote.trim()}" vs. workbook ${fileName}, ${candidate.sheet}!${candidate.range}.`, location: `Page ${candidate.page}`, sourceReference: ref });
  }
  return drafts;
}
