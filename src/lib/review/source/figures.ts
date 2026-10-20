/**
 * Figure parsing, number-format classification, and tolerant comparison
 * (pure). This is where Keystone decides whether a report figure and a
 * workbook value "say the same thing", so the rules here are deliberately
 * conservative: when in doubt the answer is "not comparable", never a
 * discrepancy.
 */

export type FigureKind = "percent" | "amount";

export interface ReportFigure {
  /** The figure exactly as written in the report, trimmed. */
  raw: string;
  kind: FigureKind;
  /** Amount: absolute value in dollars (scale applied). Percent: points (5.00 for "5.00%"). */
  value: number;
  /** Decimal places as written, in the displayed unit. Drives the tolerance. */
  decimals: number;
  /** Multiplier from a scale word ("million" = 1e6). 1 for percentages. */
  scale: number;
}

export type FigureParseFailure = "not_figure" | "per_unit" | "unsupported_scale";

export type FigureParse =
  | { ok: true; figure: ReportFigure; end: number }
  | { ok: false; reason: FigureParseFailure };

/**
 * Captures: 1 "(" 2 "-" 3 "$" 4 integer part 5 decimal part 6 "%" 7 ")" 8 scale word.
 * Matched sticky at a known position, so the caller controls context.
 */
const FIGURE = new RegExp(
  String.raw`(\()?\s*(-)?\s*(\$)?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(%)?\s*(\))?(?:\s*(million|thousand|billion)\b)?`,
  "iy"
);

const SCALE: Record<string, number> = {
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
};

/** "per SF", "/unit", "per annum": a unit rate, never a total. Not compared. */
const PER_UNIT_AFTER = /^\s*(?:\/|per\b)/i;

/**
 * Parses a figure that starts exactly at `index`. A bare integer with no
 * $, grouping comma, decimal point, percent sign, or scale word (for example
 * "2026" or "12") is NOT a figure: those are too often years, counts, or
 * identifiers to compare safely.
 */
export function parseFigureAt(text: string, index: number): FigureParse {
  FIGURE.lastIndex = index;
  const match = FIGURE.exec(text);
  if (!match || match.index !== index) return { ok: false, reason: "not_figure" };

  const [whole, openParen, minus, dollar, integerPart, decimalPart, percent, closeParen, scaleWord] =
    match;
  const hasGrouping = integerPart.includes(",");
  const figureLike =
    Boolean(dollar) || Boolean(percent) || hasGrouping || Boolean(decimalPart) || Boolean(scaleWord);
  if (!figureLike) return { ok: false, reason: "not_figure" };

  const end = index + whole.length;
  // The match must end at a real boundary. Otherwise "$12,34" would read as
  // "$12" followed by a separate, unrelated fragment.
  if (/^(?:\d|,\d|\.\d)/.test(text.slice(end, end + 2))) {
    return { ok: false, reason: "not_figure" };
  }
  if (PER_UNIT_AFTER.test(text.slice(end, end + 24))) {
    return { ok: false, reason: "per_unit" };
  }

  const magnitude = Number(integerPart.replace(/,/g, "") + (decimalPart ?? ""));
  if (!Number.isFinite(magnitude)) return { ok: false, reason: "not_figure" };
  const negative = minus === "-" || (openParen === "(" && closeParen === ")");
  const sign = negative ? -1 : 1;
  const decimals = decimalPart ? decimalPart.length - 1 : 0;
  const raw = whole.trim();

  if (percent) {
    if (scaleWord) return { ok: false, reason: "unsupported_scale" };
    return {
      ok: true,
      end,
      figure: { raw, kind: "percent", value: sign * magnitude, decimals, scale: 1 },
    };
  }

  const scale = scaleWord ? SCALE[scaleWord.toLowerCase()] : 1;
  return {
    ok: true,
    end,
    figure: { raw, kind: "amount", value: sign * magnitude * scale, decimals, scale },
  };
}

/**
 * The rounding tolerance implied by how the report DISPLAYS the figure:
 * half of its last displayed digit. "$69,500,000" tolerates ±0.5 dollars;
 * "$69.5 million" tolerates ±$50,000; "5.00%" tolerates ±0.005 points. This
 * is what keeps ordinary rounding from becoming a finding.
 */
export function toleranceFor(figure: ReportFigure): number {
  const halfUnit = 0.5 * Math.pow(10, -figure.decimals);
  return figure.kind === "percent" ? halfUnit : halfUnit * figure.scale;
}

/* ------------------------------------------------------------------ */
/* Workbook side                                                       */
/* ------------------------------------------------------------------ */

export type WorkbookValueKind = "percent" | "currency" | "number" | "date" | "text";

/**
 * Classifies an Excel number-format code. Quoted literals and [bracketed]
 * tokens are removed first so that text like "sq ft" or a "$" inside quotes
 * cannot be mistaken for the format's meaning.
 */
export function classifyNumberFormat(code: string | null): WorkbookValueKind {
  if (!code) return "number";
  // A dollar sign counts wherever it appears, including inside quotes
  // ("$"#,##0 is how Excel writes currency) and in [$...] locale tokens.
  const isCurrency = /\[\$|\$/.test(code);
  const stripped = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");

  if (stripped.trim() === "@") return "text";
  if (/[ymd]/i.test(stripped) && !/[0#?]/.test(stripped)) return "date";
  if (stripped.includes("%")) return "percent";
  if (isCurrency) return "currency";
  return "number";
}

export interface WorkbookFigure {
  value: number;
  kind: WorkbookValueKind;
}

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

export type ComparisonOutcome =
  | "match"
  | "mismatch"
  /** The two cannot be compared (for example a dollar amount against a percent cell). */
  | "incompatible"
  /** The values differ only by a power of a thousand: likely a units difference, not an error. */
  | "ambiguous_scale";

function within(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance + 1e-9 * Math.max(1, Math.abs(a));
}

export function compareFigure(figure: ReportFigure, workbook: WorkbookFigure): ComparisonOutcome {
  const tolerance = toleranceFor(figure);

  if (figure.kind === "percent") {
    if (workbook.kind === "currency") return "incompatible";
    if (workbook.kind === "percent") {
      // Excel stores 6.5% as 0.065 and formats it; compare in percent points.
      return within(figure.value, workbook.value * 100, tolerance) ? "match" : "mismatch";
    }
    // Unformatted numbers may hold either points (6.5) or a fraction (0.065).
    // Either reading matching counts as agreement, so this can only ever
    // reduce findings, never create one.
    if (
      within(figure.value, workbook.value, tolerance) ||
      within(figure.value, workbook.value * 100, tolerance)
    ) {
      return "match";
    }
    return "mismatch";
  }

  if (workbook.kind === "percent") return "incompatible";
  if (within(figure.value, workbook.value, tolerance)) return "match";

  // A "$1,234" (thousands) report figure against a workbook in dollars, or a
  // "69.5 million" figure against a workbook in millions, is a units question
  // this check cannot settle. Report it as ambiguous instead of a discrepancy.
  for (const factor of [1e3, 1e6, 1e-3, 1e-6]) {
    if (within(figure.value * factor, workbook.value, tolerance * factor)) {
      return "ambiguous_scale";
    }
  }
  return "mismatch";
}

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

function groupThousands(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 69500000 -> "$69,500,000"; 1234.5 -> "$1,234.50" -> "$1,234.5". */
export function formatAmount(value: number): string {
  const sign = value < 0 ? "-" : "";
  const [integer, decimal] = Math.abs(value).toFixed(2).split(".");
  const fraction = decimal === "00" ? "" : `.${decimal.replace(/0+$/, "")}`;
  return `${sign}$${groupThousands(integer)}${fraction}`;
}

/** Percent points -> "5.2%". */
export function formatPercent(points: number): string {
  const text = points.toFixed(4).replace(/\.?0+$/, "");
  return `${text}%`;
}

export function formatWorkbookValue(workbook: WorkbookFigure): string {
  if (workbook.kind === "percent") return formatPercent(workbook.value * 100);
  if (workbook.kind === "currency") return formatAmount(workbook.value);
  const text = workbook.value.toFixed(4).replace(/\.?0+$/, "");
  const [integer, decimal] = text.split(".");
  return decimal ? `${groupThousands(integer)}.${decimal}` : groupThousands(integer);
}
