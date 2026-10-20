import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildZip, type TestEntry } from "./helpers/zipBuilder";
import { openZipArchive, type ZipArchive } from "@/lib/review/source/zipArchive";
import { readWorkbookModel } from "@/lib/review/source/workbookModel";
import { inspectWorkbookPackage } from "@/lib/review/source/workbookPackage";
import { parseXml, textOf, childrenNamed } from "@/lib/review/source/xmlTree";
import {
  classifyNumberFormat,
  compareFigure,
  formatAmount,
  formatPercent,
  parseFigureAt,
  type ReportFigure,
} from "@/lib/review/source/figures";
import { linkReportToWorkbook } from "@/lib/review/source/linking";
import { crossValidateWorkbook, MAX_SOURCE_FINDINGS } from "@/lib/review/source/crossValidate";
import { checkWorkbookUpload } from "@/lib/review/source/workbookUpload";
import { SourceWorkbookError } from "@/lib/review/source/errors";
import { MAX_WORKBOOK_BYTES } from "@/lib/review/source/workbookFile";
import type { PageText } from "@/lib/review/types";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures");
const readFixture = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));

const SHEET_NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** A minimal but structurally valid package, built from explicit sheet XML. */
function minimalPackage(opts: {
  sheets: { name: string; rows: string; state?: string }[];
  format?: "xlsx" | "xlsm";
  definedNames?: string;
  extra?: TestEntry[];
}): Uint8Array {
  const format = opts.format ?? "xlsx";
  const main =
    format === "xlsx"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
      : "application/vnd.ms-excel.sheet.macroEnabled.main+xml";
  const sheetOverrides = opts.sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join("");
  const sheetsXml = opts.sheets
    .map(
      (sheet, i) =>
        `<sheet name="${sheet.name}" sheetId="${i + 1}"${sheet.state ? ` state="${sheet.state}"` : ""} r:id="rId${i + 1}"/>`
    )
    .join("");
  const relsXml = opts.sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    )
    .join("");
  const entries: TestEntry[] = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="${main}"/>${sheetOverrides}</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0"?><workbook ${SHEET_NS}><sheets>${sheetsXml}</sheets>${opts.definedNames ? `<definedNames>${opts.definedNames}</definedNames>` : ""}</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relsXml}</Relationships>`,
    },
    ...opts.sheets.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: `<?xml version="1.0"?><worksheet ${SHEET_NS}><sheetData>${sheet.rows}</sheetData></worksheet>`,
    })),
    ...(opts.extra ?? []),
  ];
  return buildZip(entries);
}

function pages(...texts: string[]): PageText[] {
  return texts.map((text, index) => ({ pageNumber: index + 1, text }));
}

/* ------------------------------------------------------------------ */

describe("ZIP reader: hostile and malformed packages", () => {
  it("reads stored and deflated entries back exactly", () => {
    const archive = openZipArchive(
      buildZip([
        { name: "a.txt", data: "hello", method: 0 },
        { name: "b.txt", data: "compressed compressed compressed", method: 8 },
      ])
    );
    assert.equal(new TextDecoder().decode(archive.read("a.txt")!), "hello");
    assert.equal(
      new TextDecoder().decode(archive.read("b.txt")!),
      "compressed compressed compressed"
    );
    assert.equal(archive.read("missing.txt"), null);
  });

  it("refuses an encrypted entry", () => {
    const bytes = buildZip([{ name: "secret.bin", data: "x", encrypted: true }]);
    assert.throws(() => openZipArchive(bytes), (error: unknown) =>
      error instanceof SourceWorkbookError && error.reason === "encrypted"
    );
  });

  it("refuses duplicate part names rather than guessing which one is the workbook", () => {
    const bytes = buildZip([
      { name: "xl/workbook.xml", data: "one" },
      { name: "xl/workbook.xml", data: "two" },
    ]);
    assert.throws(() => openZipArchive(bytes), (error: unknown) =>
      error instanceof SourceWorkbookError && error.reason === "unsupported"
    );
  });

  it("rejects a package whose DECLARED size is a bomb, before decompressing anything", () => {
    const bytes = buildZip([{ name: "xl/sheet.xml", data: "x", declaredSize: 300 * 1024 * 1024 }]);
    assert.throws(() => openZipArchive(bytes), (error: unknown) =>
      error instanceof SourceWorkbookError && error.reason === "too_large"
    );
  });

  it("enforces the read budget as entries are actually read", () => {
    const bytes = buildZip([{ name: "xl/big.xml", data: "x".repeat(1000) }]);
    const archive = openZipArchive(bytes, {
      maxEntries: 10,
      maxDeclaredBytes: 10_000,
      maxReadBytes: 100,
    });
    assert.throws(() => archive.read("xl/big.xml"), (error: unknown) =>
      error instanceof SourceWorkbookError && error.reason === "too_large"
    );
  });

  it("treats random bytes as unreadable, never as a crash", () => {
    const junk = new Uint8Array(512).map((_, i) => (i * 31) & 0xff);
    assert.throws(() => openZipArchive(junk), (error: unknown) =>
      error instanceof SourceWorkbookError && error.reason === "unreadable"
    );
  });

  it("rejects a truncated package", () => {
    const full = buildZip([{ name: "a.xml", data: "<a/>" }]);
    assert.throws(() => openZipArchive(full.slice(0, full.length - 30)));
  });
});

describe("XML parsing: strict subset", () => {
  it("strips namespace prefixes, decodes entities, and reads CDATA", () => {
    const root = parseXml(
      `<?xml version="1.0"?><x:root xmlns:x="u" r:id="rId9"><x:t>A &amp; B &lt;C&gt; &#65;</x:t><x:t><![CDATA[raw <text>]]></x:t></x:root>`
    );
    assert.equal(root.name, "root");
    assert.equal(root.attributes.id, "rId9");
    assert.equal(childrenNamed(root, "t")[0].text, "A & B <C> A");
    assert.equal(textOf(root), "A & B <C> Araw <text>");
  });

  it("refuses DTDs and entity declarations outright", () => {
    assert.throws(
      () => parseXml(`<!DOCTYPE r [<!ENTITY x "boom">]><r>&x;</r>`),
      (error: unknown) => error instanceof SourceWorkbookError && error.reason === "unsupported"
    );
  });

  it("fails loudly on malformed markup instead of returning a partial tree", () => {
    assert.throws(() => parseXml("<a><b></a>"));
    assert.throws(() => parseXml("<a>unclosed"));
    assert.throws(() => parseXml(""));
  });
});

describe("figures: parsing report text", () => {
  it("parses currency, grouped, negative, and scaled amounts", () => {
    const money = parseFigureAt("$69,500,000", 0);
    assert.ok(money.ok);
    assert.equal(money.figure.value, 69_500_000);
    assert.equal(money.figure.decimals, 0);

    const scaled = parseFigureAt("$69.5 million", 0);
    assert.ok(scaled.ok);
    assert.equal(scaled.figure.value, 69_500_000);
    assert.equal(scaled.figure.decimals, 1);

    const negative = parseFigureAt("($1,234)", 0);
    assert.ok(negative.ok);
    assert.equal(negative.figure.value, -1234);
  });

  it("parses percentages as percent points", () => {
    const pct = parseFigureAt("5.00%", 0);
    assert.ok(pct.ok);
    assert.equal(pct.figure.kind, "percent");
    assert.equal(pct.figure.value, 5);
    assert.equal(pct.figure.decimals, 2);
  });

  it("never treats a bare integer as a figure (years, unit counts)", () => {
    assert.deepEqual(parseFigureAt("2026", 0), { ok: false, reason: "not_figure" });
    assert.deepEqual(parseFigureAt("24", 0), { ok: false, reason: "not_figure" });
  });

  it("refuses a figure that runs into more digits instead of truncating it", () => {
    assert.deepEqual(parseFigureAt("$12,34", 0), { ok: false, reason: "not_figure" });
  });

  it("refuses unit rates such as '$85 per SF' (never a total)", () => {
    assert.deepEqual(parseFigureAt("$85 per SF", 0), { ok: false, reason: "per_unit" });
    assert.deepEqual(parseFigureAt("$85/SF", 0), { ok: false, reason: "per_unit" });
  });

  it("refuses a percentage with a scale word", () => {
    assert.deepEqual(parseFigureAt("5% million", 0), { ok: false, reason: "unsupported_scale" });
  });
});

describe("figures: workbook number formats and comparison", () => {
  it("classifies Excel number formats", () => {
    assert.equal(classifyNumberFormat("0.00%"), "percent");
    assert.equal(classifyNumberFormat('"$"#,##0_);("$"#,##0)'), "currency");
    assert.equal(classifyNumberFormat("\\$#,##0_);\"($\"#,##0\\)"), "currency");
    assert.equal(classifyNumberFormat("[$$-409]#,##0.00"), "currency");
    assert.equal(classifyNumberFormat("m/d/yyyy"), "date");
    assert.equal(classifyNumberFormat("@"), "text");
    assert.equal(classifyNumberFormat("#,##0"), "number");
    assert.equal(classifyNumberFormat('0.0"x"'), "number");
    assert.equal(classifyNumberFormat(null), "number");
  });

  const figure = (raw: string): ReportFigure => {
    const parsed = parseFigureAt(raw, 0);
    assert.ok(parsed.ok, raw);
    return parsed.figure;
  };

  it("matches equivalent presentations: 0.05 vs 5.00%, 69500000 vs $69,500,000", () => {
    assert.equal(compareFigure(figure("5.00%"), { value: 0.05, kind: "percent" }), "match");
    assert.equal(compareFigure(figure("$69,500,000"), { value: 69_500_000, kind: "currency" }), "match");
  });

  it("tolerates rounding at the precision the report displays", () => {
    assert.equal(compareFigure(figure("$69.5 million"), { value: 69_512_345, kind: "currency" }), "match");
    assert.equal(compareFigure(figure("$69,500,000"), { value: 69_500_000.4, kind: "number" }), "match");
    assert.equal(compareFigure(figure("6.5%"), { value: 0.0649, kind: "percent" }), "match");
  });

  it("reports a real difference beyond rounding as a mismatch", () => {
    assert.equal(compareFigure(figure("$1,000,000"), { value: 1_234_567, kind: "currency" }), "mismatch");
    assert.equal(compareFigure(figure("5.00%"), { value: 0.0501, kind: "percent" }), "mismatch");
  });

  it("treats a thousands/millions difference as ambiguous, never a discrepancy", () => {
    assert.equal(compareFigure(figure("$1,425"), { value: 1_425_000, kind: "currency" }), "ambiguous_scale");
    assert.equal(compareFigure(figure("$69.5 million"), { value: 69.5, kind: "number" }), "ambiguous_scale");
  });

  it("does not compare a dollar amount with a percentage cell", () => {
    assert.equal(compareFigure(figure("$1,000"), { value: 0.05, kind: "percent" }), "incompatible");
    assert.equal(compareFigure(figure("6.5%"), { value: 1000, kind: "currency" }), "incompatible");
  });

  it("formats values for display", () => {
    assert.equal(formatAmount(69_500_000), "$69,500,000");
    assert.equal(formatAmount(-1234.5), "-$1,234.5");
    assert.equal(formatPercent(5.2), "5.2%");
    assert.equal(formatPercent(5), "5%");
  });
});

describe("workbook model: real files", () => {
  it("reads sheet names, states, cached values, and number formats from an Excel-saved file", () => {
    const model = readWorkbookModel(openZipArchive(readFixture("real-excel-sample.xlsx")), "xlsx");
    assert.deepEqual(model.sheets.map((sheet) => sheet.name), ["Sheet1"]);
    const cells = model.sheets[0].cells;
    assert.equal(cells.find((cell) => cell.ref === "B3")?.value, "Rental Income");
    assert.equal(cells.find((cell) => cell.ref === "A4")?.value, 110);
    assert.equal(model.containsMacros, false);
  });

  it("reads the synthetic model: formulas with cached results, names, a table, a hidden sheet", () => {
    const model = readWorkbookModel(openZipArchive(readFixture("source-model.xlsx")), "xlsx");
    const byName = Object.fromEntries(model.sheets.map((sheet) => [sheet.name, sheet]));

    assert.deepEqual(model.sheets.map((sheet) => sheet.name), [
      "Assumptions",
      "Pro Forma",
      "Valuation",
      "Rent Roll",
      "Calc",
    ]);
    assert.equal(byName.Calc.state, "hidden");

    const noi = byName["Pro Forma"].cells.find((cell) => cell.ref === "C9")!;
    assert.equal(noi.value, 925_000);
    assert.equal(noi.formula, "=C7-C8");
    assert.equal(noi.uncached, false);
    assert.equal(noi.numberFormat !== null && classifyNumberFormat(noi.numberFormat), "currency");

    assert.equal(byName["Rent Roll"].tables[0].name, "tblRentRoll");
    assert.deepEqual(byName["Rent Roll"].tables[0].headers, ["Unit", "Tenant", "Rent"]);

    const subjectNoi = model.definedNames.filter((name) => name.name === "Subject_NOI");
    assert.equal(subjectNoi.length, 2, "workbook-level and sheet-scoped definitions are both kept");
    assert.equal(model.definedNames.find((name) => name.name === "Derived_Name")?.resolved, null);
    assert.equal(model.definedNames.find((name) => name.name === "Rent_Range")?.resolved?.range.endRow, 4);
  });

  it("detects a VBA project in an .xlsm, and never reads it", () => {
    const bytes = readFixture("source-model.xlsm");
    const archive = openZipArchive(bytes);
    const reads: string[] = [];
    const spy: ZipArchive = {
      entries: archive.entries,
      has: (name) => archive.has(name),
      read: (name) => {
        reads.push(name);
        return archive.read(name);
      },
    };
    const model = readWorkbookModel(spy, "xlsm");
    assert.equal(model.containsMacros, true);
    assert.equal(reads.includes("xl/vbaProject.bin"), false, "the macro payload must never be read");
  });

  it("refuses to read an .xlsm whose content type says .xlsx (and vice versa)", () => {
    const xlsmBytes = readFixture("source-model.xlsm");
    assert.throws(
      () => inspectWorkbookPackage(openZipArchive(xlsmBytes), "xlsx"),
      (error: unknown) => error instanceof SourceWorkbookError && error.reason === "format_mismatch"
    );
  });

  it("applies the read budget to a real workbook", () => {
    assert.throws(
      () =>
        readWorkbookModel(
          openZipArchive(readFixture("source-model.xlsx"), {
            maxEntries: 100,
            maxDeclaredBytes: 10_000_000,
            maxReadBytes: 500,
          }),
          "xlsx",
          {}
        ),
      (error: unknown) => error instanceof SourceWorkbookError && error.reason === "too_large"
    );
  });

  it("enforces the populated-cell cap", () => {
    assert.throws(
      () => readWorkbookModel(openZipArchive(readFixture("source-model.xlsx")), "xlsx", { maxPopulatedCells: 5 }),
      (error: unknown) => error instanceof SourceWorkbookError && error.reason === "too_large"
    );
  });

  it("never follows external-link targets, and counts them only", () => {
    const bytes = minimalPackage({
      sheets: [{ name: "S", rows: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
      extra: [
        { name: "xl/externalLinks/externalLink1.xml", data: "<externalLink>https://example.invalid/steal</externalLink>" },
        { name: "xl/externalLinks/_rels/externalLink1.xml.rels", data: "<Relationships/>" },
      ],
    });
    const model = readWorkbookModel(openZipArchive(bytes), "xlsx");
    assert.equal(model.externalLinkCount, 1);
  });
});

describe("workbook model: formula and value edge cases", () => {
  it("marks a formula with no cached result as uncached (never invents a value)", () => {
    const bytes = minimalPackage({
      sheets: [
        {
          name: "S",
          rows: '<row r="5"><c r="B5" t="inlineStr"><is><t>Effective Gross Income</t></is></c><c r="C5"><f>1+1</f></c></row>',
        },
      ],
    });
    const cell = readWorkbookModel(openZipArchive(bytes), "xlsx").sheets[0].cells.find((c) => c.ref === "C5")!;
    assert.equal(cell.uncached, true);
    assert.equal(cell.value, null);
    assert.equal(cell.formula, "=1+1");
  });

  it("flags formulas that reference another workbook", () => {
    const bytes = minimalPackage({
      sheets: [{ name: "S", rows: '<row r="1"><c r="C1"><f>[1]Other!A1</f><v>99</v></c></row>' }],
    });
    const cell = readWorkbookModel(openZipArchive(bytes), "xlsx").sheets[0].cells[0];
    assert.equal(cell.externalFormula, true);
  });

  it("reads shared strings, inline strings, booleans, and errors", () => {
    const bytes = minimalPackage({
      sheets: [
        {
          name: "S",
          rows:
            '<row r="1"><c r="A1" t="inlineStr"><is><t>inline &amp; text</t></is></c><c r="B1" t="b"><v>1</v></c><c r="C1" t="e"><v>#DIV/0!</v></c></row>',
        },
      ],
    });
    const cells = readWorkbookModel(openZipArchive(bytes), "xlsx").sheets[0].cells;
    assert.equal(cells.find((c) => c.ref === "A1")?.value, "inline & text");
    assert.equal(cells.find((c) => c.ref === "B1")?.value, true);
    assert.equal(cells.find((c) => c.ref === "C1")?.type, "error");
  });
});

describe("linking and cross-validation against the synthetic model", () => {
  const model = readWorkbookModel(openZipArchive(readFixture("source-model.xlsx")), "xlsx");

  it("links the figures a report states clearly, and they agree", () => {
    const result = crossValidateWorkbook({
      model,
      fileName: "source-model.xlsx",
      pages: pages(
        "Subject_Cap_Rate: 6.50%\nSubject_SF: 36,000 SF\nSubject_Value: $14,230,769\nEffective Gross Income: $1,425,000\nOperating Expenses: $500,000",
      ),
    });
    assert.equal(result.stats.linked, 5);
    assert.equal(result.stats.matched, 5);
    assert.equal(result.stats.flagged, 0);
    assert.deepEqual(result.drafts, []);
  });

  it("produces a traceable finding for a genuine defined-name mismatch", () => {
    const result = crossValidateWorkbook({
      model,
      fileName: "source-model.xlsx",
      pages: pages("Subject_Value: $15,000,000"),
    });
    assert.equal(result.drafts.length, 1);
    const [draft] = result.drafts;
    assert.equal(draft.category, "source_workbook_discrepancy");
    assert.equal("confidence" in draft, false, "confidence is set by the pipeline, not the check");
    assert.match(draft.description, /"Subject_Value"/);
    assert.match(draft.evidence, /Report: "\$15,000,000"/);
    assert.match(draft.evidence, /sheet "Valuation", cell C5/);
    assert.equal(draft.sourceReference?.sheet, "Valuation");
    assert.equal(draft.sourceReference?.cell, "C5");
    assert.equal(draft.sourceReference?.definedName, "Subject_Value");
    assert.equal(draft.sourceReference?.linkedBy, "defined_name");
    assert.equal(draft.sourceReference?.workbook, "source-model.xlsx");
  });

  it("produces a finding for a unique-label mismatch and says how the link was made", () => {
    const result = crossValidateWorkbook({
      model,
      fileName: "source-model.xlsx",
      pages: pages("Effective Gross Income: $1,350,000"),
    });
    assert.equal(result.drafts.length, 1);
    assert.equal(result.drafts[0].sourceReference?.linkedBy, "context_label");
    assert.match(result.drafts[0].evidence, /contextual label "Effective Gross Income"/);
  });

  it("accepts rounding: $1.4 million against $1,425,000 is a match, not a finding", () => {
    const result = crossValidateWorkbook({
      model,
      fileName: "source-model.xlsx",
      pages: pages("Effective Gross Income: $1.4 million"),
    });
    assert.equal(result.stats.matched, 1);
    assert.equal(result.drafts.length, 0);
  });

  it("does NOT treat an unrelated duplicate number as a finding", () => {
    // 1,425,000 appears in the report, but not on a linkable identifier or label.
    const result = crossValidateWorkbook({
      model,
      fileName: "source-model.xlsx",
      pages: pages("The property generated about $1,425,000 of collections last year."),
    });
    assert.equal(result.stats.linked, 0);
    assert.equal(result.drafts.length, 0);
  });

  it("does NOT link a figure whose label appears twice in the report (ambiguous)", () => {
    const result = crossValidateWorkbook({
      model,
      fileName: "source-model.xlsx",
      pages: pages("Effective Gross Income: $1,350,000", "Effective Gross Income is discussed here."),
    });
    assert.equal(result.stats.linked, 0);
    assert.equal(result.drafts.length, 0);
    assert.ok(result.stats.ambiguous >= 1);
  });

  it("does NOT trust a defined name that the workbook defines twice", () => {
    const result = crossValidateWorkbook({
      model,
      fileName: "source-model.xlsx",
      pages: pages("Subject_NOI: $999"),
    });
    assert.equal(result.drafts.length, 0);
    assert.equal(result.stats.ambiguous, 1);
  });

  it("does NOT link a multi-figure table row", () => {
    const result = crossValidateWorkbook({
      model,
      fileName: "source-model.xlsx",
      pages: pages("Operating Expenses: $500,000   $450,000"),
    });
    assert.equal(result.stats.linked, 0);
    assert.equal(result.drafts.length, 0);
  });

  it("does NOT link a row of a range or a figure that is a unit rate", () => {
    const result = crossValidateWorkbook({
      model,
      fileName: "source-model.xlsx",
      pages: pages("Subject_SF: $85 per SF", "Monthly Rent Roll: $1,000"),
    });
    assert.equal(result.stats.linked, 0);
  });

  it("does NOT flag a figure that is a units difference (thousands vs dollars)", () => {
    const result = crossValidateWorkbook({
      model,
      fileName: "source-model.xlsx",
      pages: pages("Effective Gross Income: $1,425"),
    });
    assert.equal(result.drafts.length, 0);
    assert.equal(result.stats.skipped, 1);
  });

  it("does NOT compare a dollar figure against a percentage cell", () => {
    const result = crossValidateWorkbook({
      model,
      fileName: "source-model.xlsx",
      pages: pages("Subject_Cap_Rate: 6.5"),
    });
    assert.equal(result.drafts.length, 0);
    assert.equal(result.stats.skipped, 1);
  });

  it("does NOT link a formula whose cached value Excel never stored", () => {
    const bytes = minimalPackage({
      sheets: [
        {
          name: "S",
          rows:
            '<row r="5"><c r="B5" t="inlineStr"><is><t>Effective Gross Income</t></is></c><c r="C5"><f>1+1</f></c></row>',
        },
      ],
    });
    const uncached = readWorkbookModel(openZipArchive(bytes), "xlsx");
    const result = crossValidateWorkbook({
      model: uncached,
      fileName: "x.xlsx",
      pages: pages("Effective Gross Income: $1,000"),
    });
    assert.equal(result.stats.linked, 0);
  });

  it("refuses an identifier whose two figures in the report disagree", () => {
    const result = crossValidateWorkbook({
      model,
      fileName: "source-model.xlsx",
      pages: pages("Subject_Cap_Rate: 6.50%", "Subject_Cap_Rate: 7.00%"),
    });
    assert.equal(result.stats.linked, 0);
    assert.equal(result.drafts.length, 0);
  });

  it("caps the number of findings shown, while still counting every mismatch", () => {
    const many = Array.from({ length: MAX_SOURCE_FINDINGS + 5 }, (_, i) => `Subject_Value: $${15_000_000 + i}`);
    const result = crossValidateWorkbook({ model, fileName: "source-model.xlsx", pages: pages(...many) });
    assert.ok(result.drafts.length <= MAX_SOURCE_FINDINGS);
  });
});

describe("linking: on a workbook with no figures in common", () => {
  it("links nothing and reports zero", () => {
    const model = readWorkbookModel(openZipArchive(readFixture("real-excel-sample.xlsx")), "xlsx");
    const linked = linkReportToWorkbook(pages("Total of nothing relevant: $12,345"), model);
    assert.equal(linked.links.length, 0);
  });
});

describe("upload validation (server, before anything is stored)", () => {
  it("accepts a real .xlsm and reports that it contains macros", async () => {
    const file = new File([readFixture("source-model.xlsm")], "25194AvignonApts.xlsm");
    const check = await checkWorkbookUpload(file);
    assert.equal(check.ok, true);
    if (check.ok) {
      assert.equal(check.format, "xlsm");
      assert.equal(check.containsMacros, true);
    }
  });

  it("rejects an unsupported extension", async () => {
    const check = await checkWorkbookUpload(new File([readFixture("source-model.xlsx")], "model.csv"));
    assert.equal(check.ok, false);
  });

  it("rejects a password-protected / OLE container with a message that explains the fix", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const check = await checkWorkbookUpload(new File([ole], "locked.xlsx"));
    assert.equal(check.ok, false);
    if (!check.ok) {
      assert.equal(check.reason, "encrypted");
      assert.match(check.message, /password/i);
    }
  });

  it("rejects bytes that are not a package, even with a valid name", async () => {
    const check = await checkWorkbookUpload(new File([new TextEncoder().encode("not a workbook")], "fake.xlsx"));
    assert.equal(check.ok, false);
    if (!check.ok) assert.equal(check.reason, "unreadable");
  });

  it("rejects a file whose extension disagrees with its contents", async () => {
    const check = await checkWorkbookUpload(new File([readFixture("source-model.xlsm")], "renamed.xlsx"));
    assert.equal(check.ok, false);
    if (!check.ok) assert.equal(check.reason, "format_mismatch");
  });

  it("rejects an oversized workbook before reading it", async () => {
    const check = await checkWorkbookUpload(
      new File([new Uint8Array(MAX_WORKBOOK_BYTES + 1)], "huge.xlsx")
    );
    assert.equal(check.ok, false);
    if (!check.ok) assert.equal(check.reason, "too_large");
  });

  it("rejects a package with no workbook part", async () => {
    const bytes = buildZip([{ name: "random.txt", data: "hi" }]);
    const check = await checkWorkbookUpload(new File([new Uint8Array(bytes)], "empty.xlsx"));
    assert.equal(check.ok, false);
  });
});
