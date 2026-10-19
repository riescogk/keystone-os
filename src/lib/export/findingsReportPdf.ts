import { jsPDF } from "jspdf";
import { toPdfSafeText } from "@/lib/export/pdfText";
import {
  DISCLAIMER_FOOTER,
  DISCLAIMER_FULL,
  EMPTY_STATE_TEXT,
  EXPORT_TITLE,
  MODEL_FINDING_NOTE,
  deterministicCheckLabels,
  describeModelCoverage,
  formatUtc,
  labelCategory,
  labelSeverity,
  sortFindingsForReport,
  summarizeFindings,
  type ExportFinding,
  type ExportReport,
} from "@/lib/export/findingsReportData";

/**
 * Builds the standalone "Pre-Delivery Review — Findings Summary" PDF
 * (PRD Section 23, FR-6).
 *
 * Requirements this implements, and how:
 * - Standalone PDF, text-based and selectable (PRD accessibility
 *   rules): drawn with the PDF standard fonts, never as images.
 * - Visibly distinct from an appraisal report: dark "Pre-Delivery
 *   Review" banner, its own title, and a "not part of the appraisal
 *   report" line on page one.
 * - Mandatory disclaimer: the full statement in a bordered box on
 *   page one, and a condensed restatement in the footer of EVERY page.
 * - All findings with category / severity / confidence / status, the
 *   user's acknowledge/dismiss decisions and reasons (their QC audit
 *   trail), and the review date/time.
 * - Severity and confidence are always spelled out in words, never
 *   conveyed by color alone.
 * - An honest coverage statement, so the export never implies checks
 *   that did not run.
 *
 * Pure function: data in, bytes out. No database, no network.
 */

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
/** Content must stay above this line; the footer lives below it. */
const BOTTOM_LIMIT = PAGE_HEIGHT - 78;

const SEVERITY_COLORS: Record<string, [number, number, number]> = {
  CRITICAL: [185, 28, 28],
  MODERATE: [180, 83, 9],
  LOW: [71, 85, 105],
};

export interface FindingsReportInput {
  report: ExportReport;
  findings: ExportFinding[];
  /** When the export was generated (injectable for tests). */
  exportedAt?: Date;
}

export async function buildFindingsReportPdf(
  input: FindingsReportInput
): Promise<Uint8Array> {
  const { report } = input;
  const findings = sortFindingsForReport(input.findings);
  const summary = summarizeFindings(findings);
  const exportedAt = (input.exportedAt ?? new Date()).toISOString();

  const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
  doc.setProperties({
    title: EXPORT_TITLE,
    subject: `Findings summary for ${toPdfSafeText(report.fileName)}`,
    author: "Keystone OS",
    creator: "Keystone OS",
  });
  doc.setLanguage("en-US");

  let y = 0;

  const setBody = (size = 10) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(size);
    doc.setTextColor(30, 41, 59);
  };
  const setBold = (size = 10) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(size);
    doc.setTextColor(15, 23, 42);
  };
  const lineHeightFor = (size: number) => size * 1.35;

  const newPage = () => {
    doc.addPage();
    y = MARGIN;
  };

  const ensureSpace = (height: number) => {
    if (y + height > BOTTOM_LIMIT) {
      newPage();
    }
  };

  /** Draws wrapped text, breaking across pages line by line. Returns nothing; advances y. */
  interface TextRow {
    text: string;
    size?: number;
    bold?: boolean;
    indent?: number;
    width?: number;
    gapAfter?: number;
    color?: [number, number, number];
  }

  const applyFont = (row: TextRow) => {
    const size = row.size ?? 10;
    if (row.bold) setBold(size);
    else setBody(size);
    if (row.color) doc.setTextColor(row.color[0], row.color[1], row.color[2]);
  };

  const wrapRow = (row: TextRow): string[] => {
    applyFont(row);
    const width = (row.width ?? CONTENT_WIDTH) - (row.indent ?? 0);
    return doc.splitTextToSize(toPdfSafeText(row.text), width) as string[];
  };

  /** Height a row will occupy, without drawing it. */
  const measureRow = (row: TextRow): number =>
    wrapRow(row).length * lineHeightFor(row.size ?? 10) + (row.gapAfter ?? 0);

  /** Draws wrapped text, breaking across pages line by line; advances y. */
  const writeWrapped = (text: string, options: Omit<TextRow, "text"> = {}) => {
    writeRow({ text, ...options });
  };

  const writeRow = (row: TextRow) => {
    const size = row.size ?? 10;
    const lines = wrapRow(row);
    const step = lineHeightFor(size);
    for (const line of lines) {
      ensureSpace(step);
      // Re-assert the font for every line (a page break must not leak state).
      applyFont(row);
      doc.text(line, MARGIN + (row.indent ?? 0), y + size);
      y += step;
    }
    y += row.gapAfter ?? 0;
  };

  const sectionHeading = (text: string) => {
    ensureSpace(34);
    y += 6;
    setBold(12);
    doc.text(toPdfSafeText(text), MARGIN, y + 12);
    y += 18;
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.75);
    doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
    y += 8;
  };

  /* ---------------------------- Page 1 ---------------------------- */

  // Distinct banner — never mistakable for an appraisal report page.
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, PAGE_WIDTH, 40, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text("KEYSTONE OS  |  PRE-DELIVERY REVIEW", MARGIN, 25);
  doc.text("NOT PART OF THE APPRAISAL REPORT", PAGE_WIDTH - MARGIN, 25, {
    align: "right",
  });
  y = 66;

  setBold(20);
  doc.text(toPdfSafeText(EXPORT_TITLE), MARGIN, y + 20);
  y += 30;
  setBody(10);
  doc.setFont("helvetica", "italic");
  doc.text(
    "A supplementary quality-control aid for the appraiser's own files.",
    MARGIN,
    y + 10
  );
  y += 26;

  // Report metadata
  const metadata: [string, string][] = [
    ["Reviewed report", report.fileName],
    ["Report uploaded", formatUtc(report.uploadedAt)],
    [
      "Review completed",
      report.reviewCompletedAt
        ? formatUtc(report.reviewCompletedAt)
        : "unknown",
    ],
    ...(report.pageCount
      ? ([["Report length", `${report.pageCount} pages`]] as [string, string][])
      : []),
    ["Summary generated", formatUtc(exportedAt)],
  ];
  for (const [label, value] of metadata) {
    ensureSpace(16);
    setBold(10);
    doc.text(`${label}:`, MARGIN, y + 10);
    setBody(10);
    const valueLines = doc.splitTextToSize(
      toPdfSafeText(value),
      CONTENT_WIDTH - 120
    ) as string[];
    valueLines.forEach((line, index) => {
      if (index > 0) ensureSpace(14);
      setBody(10);
      doc.text(line, MARGIN + 120, y + 10);
      if (index < valueLines.length - 1) y += 14;
    });
    y += 16;
  }
  y += 6;

  // Mandatory disclaimer box (page one). Measured first so the box fits.
  setBody(9.5);
  const disclaimerLines = doc.splitTextToSize(
    toPdfSafeText(DISCLAIMER_FULL),
    CONTENT_WIDTH - 24
  ) as string[];
  const disclaimerStep = lineHeightFor(9.5);
  const boxHeight = 22 + disclaimerLines.length * disclaimerStep + 10;
  ensureSpace(boxHeight);
  doc.setFillColor(241, 245, 249);
  doc.setDrawColor(100, 116, 139);
  doc.setLineWidth(1);
  doc.rect(MARGIN, y, CONTENT_WIDTH, boxHeight, "FD");
  setBold(10);
  doc.text("Important \u2014 please read", MARGIN + 12, y + 17);
  setBody(9.5);
  disclaimerLines.forEach((line, index) => {
    doc.text(line, MARGIN + 12, y + 31 + index * disclaimerStep);
  });
  y += boxHeight + 10;

  /* ---------------------------- Summary --------------------------- */

  sectionHeading("Summary");
  writeWrapped(`Total findings: ${summary.total}`, { bold: true });
  writeWrapped(
    `By severity: Critical ${summary.bySeverity.critical}; Moderate ${summary.bySeverity.moderate}; Low ${summary.bySeverity.low}.`
  );
  writeWrapped(
    `By status: Open ${summary.byStatus.open}; Acknowledged ${summary.byStatus.acknowledged}; Dismissed ${summary.byStatus.dismissed}.`
  );
  writeWrapped(
    `By confidence: Deterministic ${summary.byConfidence.deterministic}; Model-based ${summary.byConfidence.model_based}.`
  );

  /* --------------------------- Coverage --------------------------- */

  sectionHeading("Checks included in this review");
  writeWrapped(
    `Deterministic checks${
      report.reviewVersion ? ` (${report.reviewVersion})` : ""
    }: ${deterministicCheckLabels().join("; ")}.`,
    { gapAfter: 4 }
  );
  writeWrapped(describeModelCoverage(report));

  /* ---------------------------- Findings -------------------------- */

  sectionHeading("Findings");

  if (findings.length === 0) {
    writeWrapped(EMPTY_STATE_TEXT, { bold: true });
  }

  findings.forEach((finding, index) => {
    const severityLabel = labelSeverity(finding.severity);
    const confidenceLabel =
      finding.confidence === "model_based" ? "Model-based" : "Deterministic";
    const statusLabel =
      finding.status === "open"
        ? "Open"
        : finding.status === "acknowledged"
          ? "Acknowledged"
          : "Dismissed";

    const color = SEVERITY_COLORS[severityLabel] ?? [15, 23, 42];
    const rows: TextRow[] = [
      {
        // Severity, spelled out in words and (secondarily) colored.
        text: `${index + 1}. [${severityLabel}] ${labelCategory(finding.category)}`,
        size: 10.5,
        bold: true,
        color,
      },
      {
        text: `Confidence: ${confidenceLabel}   |   Status: ${statusLabel}   |   Severity: ${severityLabel.charAt(0)}${severityLabel.slice(1).toLowerCase()}`,
        size: 9,
        indent: 12,
      },
      { text: finding.description, indent: 12, gapAfter: 2 },
      { text: `Evidence: ${finding.evidence}`, size: 9.5, indent: 12 },
    ];
    if (finding.location) {
      rows.push({
        text: `Location: ${finding.location}`,
        size: 9.5,
        indent: 12,
      });
    }
    if (finding.confidence === "model_based") {
      rows.push({ text: MODEL_FINDING_NOTE, size: 9, indent: 12 });
    }

    // The user's own triage decisions — their QC audit trail.
    if (finding.status === "acknowledged") {
      rows.push({
        text: `Acknowledged${
          finding.acknowledgedAt
            ? ` on ${formatUtc(finding.acknowledgedAt)}`
            : ""
        }.`,
        size: 9.5,
        bold: true,
        indent: 12,
      });
    }
    if (finding.status === "dismissed") {
      rows.push({
        text: `Dismissed${
          finding.dismissedAt ? ` on ${formatUtc(finding.dismissedAt)}` : ""
        }. Reason recorded: ${finding.dismissedReason ?? "(none recorded)"}`,
        size: 9.5,
        bold: true,
        indent: 12,
      });
    }
    if (finding.status === "open") {
      rows.push({
        text: "Not yet acknowledged or dismissed.",
        size: 9,
        indent: 12,
      });
    }

    // Keep a finding together on one page when it fits on one page;
    // only a finding taller than a whole page is split (line by line).
    const blockHeight = rows.reduce((sum, row) => sum + measureRow(row), 0);
    const pageCapacity = BOTTOM_LIMIT - MARGIN;
    if (blockHeight <= pageCapacity) {
      ensureSpace(blockHeight + 8);
    } else {
      ensureSpace(70);
    }
    y += 8;
    rows.forEach((row) => writeRow(row));
    y += 4;
  });

  /* --------------------- Footer on EVERY page --------------------- */

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page);
    doc.setDrawColor(148, 163, 184);
    doc.setLineWidth(0.75);
    doc.line(MARGIN, PAGE_HEIGHT - 66, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 66);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(71, 85, 105);
    const footerLines = doc.splitTextToSize(
      toPdfSafeText(DISCLAIMER_FOOTER),
      CONTENT_WIDTH
    ) as string[];
    footerLines.forEach((line, index) => {
      doc.text(line, MARGIN, PAGE_HEIGHT - 54 + index * 10);
    });
    doc.text(
      `Keystone OS \u2014 ${toPdfSafeText(EXPORT_TITLE)} \u2014 Page ${page} of ${pageCount}`,
      MARGIN,
      PAGE_HEIGHT - 28
    );
  }

  return new Uint8Array(doc.output("arraybuffer"));
}
