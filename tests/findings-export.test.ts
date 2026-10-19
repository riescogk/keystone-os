import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractText, getDocumentProxy } from "unpdf";
import { buildFindingsReportPdf } from "@/lib/export/findingsReportPdf";
import { toPdfSafeText } from "@/lib/export/pdfText";
import {
  DISCLAIMER_FOOTER,
  DISCLAIMER_FULL,
  EMPTY_STATE_TEXT,
  EXPORT_TITLE,
  buildExportFileName,
  describeModelCoverage,
  isExportable,
  sortFindingsForReport,
  summarizeFindings,
  type ExportFinding,
  type ExportReport,
} from "@/lib/export/findingsReportData";

const REPORT: ExportReport = {
  fileName: "123 Main Street Appraisal (FINAL).pdf",
  uploadedAt: "2026-10-12T09:30:00Z",
  pageCount: 142,
  reviewCompletedAt: "2026-10-12T09:31:20Z",
  reviewVersion: "review-pipeline-v5",
  modelReviewStatus: "complete",
  modelReviewError: null,
  modelReviewCompletedAt: "2026-10-12T09:31:50Z",
  modelReviewVersion: "narrative-contradiction-v1:gpt-5.4-mini-2026-03-17",
};

function finding(overrides: Partial<ExportFinding> = {}): ExportFinding {
  return {
    category: "internal_arithmetic_verification",
    severity: "critical",
    confidence: "deterministic",
    status: "open",
    description: "Net Operating Income does not match EGI minus expenses.",
    evidence: "Stated NOI: $700,000 (Page 21). Expected $600,000.",
    location: "Page 20, Page 21",
    dismissedReason: null,
    acknowledgedAt: null,
    dismissedAt: null,
    createdAt: "2026-10-12T09:31:10Z",
    ...overrides,
  };
}

/** Generates the PDF and returns its per-page text, whitespace-normalized. */
async function render(
  findings: ExportFinding[],
  report: ExportReport = REPORT
): Promise<{ pages: string[]; bytes: Uint8Array }> {
  const bytes = await buildFindingsReportPdf({
    report,
    findings,
    exportedAt: new Date("2026-10-13T14:05:00Z"),
  });
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((page) =>
    page.replace(/\s+/g, " ").trim()
  );
  return { pages, bytes };
}

const norm = (value: string) => value.replace(/\s+/g, " ").trim();

describe("findings export PDF (PRD Section 23, FR-6)", () => {
  it("is a real, text-based PDF with selectable text and no images", async () => {
    const { pages, bytes } = await render([finding()]);
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString("latin1"), "%PDF-");
    assert.ok(pages[0].length > 200, "text was extracted, so it is selectable");
    assert.ok(
      !Buffer.from(bytes).toString("latin1").includes("/Subtype /Image"),
      "no flattened images"
    );
  });

  it("is visibly distinct from an appraisal report and carries required metadata", async () => {
    const { pages } = await render([finding()]);
    const first = pages[0];
    assert.ok(
      first.includes(norm(EXPORT_TITLE)),
      "titled Pre-Delivery Review — Findings Summary"
    );
    assert.ok(first.includes("NOT PART OF THE APPRAISAL REPORT"));
    assert.ok(
      first.includes("123 Main Street Appraisal (FINAL).pdf"),
      "reviewed report file name"
    );
    assert.ok(
      first.includes("2026-10-12 09:31 UTC"),
      "review date/time, explicit zone"
    );
    assert.ok(first.includes("2026-10-12 09:30 UTC"), "upload date");
    assert.ok(first.includes("142 pages"));
  });

  it("prints the full mandatory disclaimer on page one", async () => {
    const { pages } = await render([finding()]);
    assert.ok(pages[0].includes(norm(DISCLAIMER_FULL)));
    assert.match(
      pages[0],
      /does not determine, confirm, or opine on market value/
    );
  });

  it("repeats the disclaimer in the footer of EVERY page of a long export", async () => {
    const many = Array.from({ length: 45 }, (_, i) =>
      finding({
        description: `Finding number ${i + 1}: the stated figures on these pages do not agree with one another.`,
        createdAt: `2026-10-12T09:31:${String(10 + (i % 40)).padStart(2, "0")}Z`,
      })
    );
    const { pages } = await render(many);
    assert.ok(
      pages.length >= 3,
      `expected a multi-page export, got ${pages.length}`
    );
    pages.forEach((page, index) => {
      assert.ok(
        page.includes(norm(DISCLAIMER_FOOTER)),
        `disclaimer missing on page ${index + 1}`
      );
      assert.ok(
        page.includes(`Page ${index + 1} of ${pages.length}`),
        `page numbering on page ${index + 1}`
      );
    });
    for (let i = 1; i <= 45; i++) {
      assert.ok(
        pages.join(" ").includes(`Finding number ${i}:`),
        `finding ${i} present`
      );
    }
  });

  it("never splits a finding across two pages when it fits on one", async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      finding({
        description: `Entry ${i + 1} description text that is long enough to take more than one line when it is laid out on the page.`,
        evidence: `Evidence for entry ${i + 1}: stated figures on these pages do not agree.`,
        createdAt: `2026-10-12T09:31:${String(10 + (i % 40)).padStart(2, "0")}Z`,
      })
    );
    const { pages } = await render(many);
    assert.ok(pages.length >= 3);
    for (let i = 1; i <= 40; i++) {
      const heading = `${i}. [CRITICAL] Internal Arithmetic Verification`;
      const page = pages.find((p) => p.includes(heading));
      assert.ok(page, `finding ${i} present`);
      assert.ok(
        page.includes(`Entry ${i} description`) &&
          page.includes(`Evidence for entry ${i}:`) &&
          page.includes(
            "Not yet acknowledged or dismissed.",
            page.indexOf(heading)
          ),
        `finding ${i} was split across pages`
      );
    }
  });

  it("states severity, confidence and status in words (never color alone)", async () => {
    const { pages } = await render([
      finding({ severity: "critical" }),
      finding({
        severity: "moderate",
        category: "template_leftover_detection",
        description: "Placeholder found.",
      }),
      finding({
        severity: "low",
        category: "typo_and_formatting_inconsistency",
        description: "Doubled word.",
      }),
    ]);
    const all = pages.join(" ");
    assert.ok(all.includes("[CRITICAL] Internal Arithmetic Verification"));
    assert.ok(all.includes("[MODERATE] Template Leftover Detection"));
    assert.ok(all.includes("[LOW] Typo & Formatting Inconsistency"));
    assert.ok(all.includes("Confidence: Deterministic"));
    assert.ok(all.includes("Status: Open"));
  });

  it("includes the user's acknowledge/dismiss decisions and reasons (audit trail)", async () => {
    const { pages } = await render([
      finding({
        status: "acknowledged",
        acknowledgedAt: "2026-10-12T10:00:00Z",
      }),
      finding({
        status: "dismissed",
        dismissedAt: "2026-10-12T10:05:00Z",
        dismissedReason: "Confirmed intentional per client instruction.",
        description: "Second finding.",
      }),
    ]);
    const all = pages.join(" ");
    assert.ok(all.includes("Acknowledged on 2026-10-12 10:00 UTC"));
    assert.ok(all.includes("Dismissed on 2026-10-12 10:05 UTC"));
    assert.ok(
      all.includes(
        "Reason recorded: Confirmed intentional per client instruction."
      )
    );
  });

  it("labels model-based findings and never presents them as exact checks", async () => {
    const { pages } = await render([
      finding({
        category: "narrative_data_contradiction",
        severity: "moderate",
        confidence: "model_based",
        description:
          "Possible conflict in the stated property condition — worth a second look: ...",
      }),
    ]);
    const all = pages.join(" ");
    assert.ok(all.includes("Confidence: Model-based"));
    assert.ok(all.includes("possible conflict, not an exact check"));
  });

  it("shows the mandated empty-state wording when there are no findings", async () => {
    const { pages } = await render([]);
    assert.ok(pages[0].includes(norm(EMPTY_STATE_TEXT)));
    assert.ok(pages[0].includes("Total findings: 0"));
  });

  it("reports accurate summary counts", async () => {
    const findings = [
      finding({ severity: "critical" }),
      finding({
        severity: "critical",
        status: "dismissed",
        dismissedReason: "n/a",
      }),
      finding({
        severity: "low",
        confidence: "model_based",
        status: "acknowledged",
      }),
    ];
    const summary = summarizeFindings(findings);
    assert.deepEqual(summary.bySeverity, { critical: 2, moderate: 0, low: 1 });
    assert.deepEqual(summary.byStatus, {
      open: 1,
      acknowledged: 1,
      dismissed: 1,
    });
    assert.deepEqual(summary.byConfidence, {
      deterministic: 2,
      model_based: 1,
    });
    const { pages } = await render(findings);
    assert.ok(pages[0].includes("By severity: Critical 2; Moderate 0; Low 1."));
    assert.ok(pages[0].includes("Total findings: 3"));
  });

  it("orders findings by severity, then by time", () => {
    const sorted = sortFindingsForReport([
      finding({
        severity: "low",
        description: "low-late",
        createdAt: "2026-10-12T09:35:00Z",
      }),
      finding({
        severity: "critical",
        description: "crit-late",
        createdAt: "2026-10-12T09:34:00Z",
      }),
      finding({
        severity: "critical",
        description: "crit-early",
        createdAt: "2026-10-12T09:30:00Z",
      }),
    ]);
    assert.deepEqual(
      sorted.map((f) => f.description),
      ["crit-early", "crit-late", "low-late"]
    );
  });
});

describe("coverage honesty (a failed model pass must never look like a clean one)", () => {
  const base = {
    modelReviewError: null,
    modelReviewCompletedAt: null,
    modelReviewVersion: null,
  } as const;

  it("describes every model-review state truthfully", () => {
    assert.match(
      describeModelCoverage({ ...base, modelReviewStatus: "not_run" }),
      /not run for this report\. No model-based findings are included/
    );
    assert.match(
      describeModelCoverage({ ...base, modelReviewStatus: "processing" }),
      /still in progress.*not included/
    );
    assert.match(
      describeModelCoverage({
        ...base,
        modelReviewStatus: "failed",
        modelReviewError: "timeout",
      }),
      /could not be completed \(the model provider timed out\)\. No model-based findings are included/
    );
    assert.match(
      describeModelCoverage({
        ...base,
        modelReviewStatus: "unavailable",
        modelReviewError: "not_configured",
      }),
      /could not be completed \(model-based checks were not enabled\)/
    );
    assert.match(
      describeModelCoverage({
        ...base,
        modelReviewStatus: "complete",
        modelReviewCompletedAt: "2026-10-12T09:31:50Z",
        modelReviewVersion: "narrative-contradiction-v1:m",
      }),
      /completed on 2026-10-12 09:31 UTC \(narrative-contradiction-v1:m\)/
    );
  });

  it("the exported PDF still renders fully when the model pass failed", async () => {
    const failedReport: ExportReport = {
      ...REPORT,
      modelReviewStatus: "failed",
      modelReviewError: "provider_error",
      modelReviewCompletedAt: null,
      modelReviewVersion: null,
    };
    const { pages } = await render([finding()], failedReport);
    const all = pages.join(" ");
    assert.ok(
      all.includes(
        "could not be completed (the model provider returned an error)"
      )
    );
    assert.ok(
      all.includes("Internal Arithmetic Verification"),
      "deterministic findings intact"
    );
    assert.ok(all.includes("Deterministic checks (review-pipeline-v5)"));
  });
});

describe("robustness with hostile or unusual content", () => {
  it("never throws on unsupported characters, and replaces them visibly", async () => {
    const nasty =
      "Value \u2265 $5M \u2192 \u4E2D\u6587 \u{1F600} caf\u00E9 \u201Cquoted\u201D \u0000 end";
    const safe = toPdfSafeText(nasty);
    assert.ok(safe.includes(">="));
    assert.ok(safe.includes("->"));
    assert.ok(safe.includes("caf\u00E9"));
    assert.ok(safe.includes("\u201Cquoted\u201D"));
    assert.ok(!safe.includes("\u0000"));
    assert.ok(safe.includes("?"), "unsupported characters become ?");
    const { pages } = await render([
      finding({ evidence: nasty, description: nasty }),
    ]);
    assert.ok(pages.join(" ").includes("caf\u00E9"));
  });

  it("handles very long unbroken strings and large text without failing", async () => {
    const long = "A".repeat(900);
    const { pages } = await render([
      finding({ evidence: long, dismissedReason: null }),
      finding({ status: "dismissed", dismissedReason: "word ".repeat(400) }),
    ]);
    assert.ok(pages.length >= 1);
    assert.ok(pages.every((p) => p.includes(norm(DISCLAIMER_FOOTER))));
  });

  it("handles a hostile report file name", async () => {
    const hostile = { ...REPORT, fileName: 'x"\r\nSet-Cookie: a=b\u202E.pdf' };
    const { pages } = await render([finding()], hostile);
    assert.ok(pages[0].includes("Reviewed report"));
  });
});

describe("export filename and eligibility", () => {
  it("builds a header-safe filename", () => {
    assert.equal(
      buildExportFileName(
        "123 Main Street Appraisal (FINAL).pdf",
        "2026-10-12T09:31:20Z"
      ),
      "Keystone-Findings-123-Main-Street-Appraisal-FINAL-2026-10-12.pdf"
    );
    const hostile = buildExportFileName(
      '..\\..\\evil"\r\nX-Injected: 1\u202E.pdf',
      "2026-10-12T09:31:20Z"
    );
    assert.match(
      hostile,
      /^Keystone-Findings-[A-Za-z0-9._-]+-2026-10-12\.pdf$/
    );
    assert.ok(!/["\r\n\\/]/.test(hostile));
    assert.equal(
      buildExportFileName("\u4E2D\u6587.pdf", null),
      "Keystone-Findings-report-undated.pdf"
    );
  });

  it("only exports a completed review", () => {
    assert.ok(
      isExportable({
        extraction_status: "completed",
        review_status: "complete",
      })
    );
    for (const [e, r] of [
      ["pending", "pending"],
      ["processing", "pending"],
      ["ocr_required", "pending"],
      ["failed", "pending"],
      ["completed", "pending"],
      ["completed", "processing"],
      ["completed", "failed"],
    ]) {
      assert.ok(
        !isExportable({ extraction_status: e, review_status: r }),
        `${e}/${r}`
      );
    }
  });
});
