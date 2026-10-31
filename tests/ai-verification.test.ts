import assert from "node:assert/strict";
import test from "node:test";
import {
  compareIEDocuments,
  compareRentRollDocuments,
} from "../src/lib/automation/ai-verification/compare";
import {
  AIVerificationError,
  verificationFailureState,
} from "../src/lib/automation/ai-verification/errors";
import { parseRentRollAIOutput } from "../src/lib/automation/ai-verification/openaiRentRollProvider";
import { parseIEAIOutput } from "../src/lib/automation/ai-verification/openaiIEProvider";
import { runIEAIVerification } from "../src/lib/automation/ai-verification/runIEVerification";
import { deriveRentRollCategoriesFromAI } from "../src/lib/automation/ai-verification/rentRollPostProcess";
import { runRentRollAIVerification } from "../src/lib/automation/ai-verification/runRentRollVerification";
import {
  chargeCodeSetsEqual,
  currencyValuesEqual,
  normalizeMoney,
  normalizeText,
  normalizePeriodLabel,
  normalizeUnitIdentifier,
} from "../src/lib/automation/ai-verification/normalize";
import type { IEVerificationDocument } from "../src/lib/automation/ai-verification/ieTypes";
import type { RentRollVerificationDocument } from "../src/lib/automation/ai-verification/rentRollTypes";

const rentRollBase: RentRollVerificationDocument = {
  propertyName: "Example Apartments",
  asOfDate: "2026-10-31",
  expectedUnitCount: 1,
  warnings: [],
  units: [
    {
      unit: "001",
      unitType: "1BR",
      sqft: 582,
      unitCategory: "Occupied",
      residentName: "Smith, John",
      marketRent: 1029,
      chargeCodes: ["RENT", "SUBRENT"],
      rentAmount: 1029,
    },
  ],
};

const ieBase: IEVerificationDocument = {
  propertyName: "Example Apartments",
  sources: [],
  periodLabels: ["2025", "T12"],
  warnings: [],
  rows: [
    {
      accountCode: "4100",
      internalNumber: 160,
      lineItem: "Other Income",
      values: { "2025": 1000, T12: 1200 },
      isSummary: false,
    },
  ],
};

test("normalizes currency and accounting negatives", () => {
  assert.equal(normalizeMoney("$1,425.00"), 1425);
  assert.equal(normalizeMoney("1,425"), 1425);
  assert.equal(normalizeMoney("(1,425.00)"), -1425);
  assert.equal(normalizeMoney("-1,425.00"), -1425);
  assert.equal(normalizeMoney("—"), null);
  assert.equal(normalizeMoney("$-"), null);
  assert.equal(currencyValuesEqual("1425.004", 1425), true);
  assert.equal(currencyValuesEqual("1425.005", 1425), false);
});

test("normalizes text without erasing meaningful values", () => {
  assert.equal(normalizeText("  Occupied   Unit "), "occupied unit");
  assert.equal(normalizeText(""), null);
});

test("preserves leading zeroes in unit identifiers", () => {
  assert.equal(normalizeUnitIdentifier("001"), "001");
  assert.notEqual(normalizeUnitIdentifier("001"), "1");
});

test("normalizes charge codes as order-independent sets", () => {
  assert.equal(chargeCodeSetsEqual("RENT, SUBRENT", ["subrent", "rent"]), true);
});

test("equal Rent Roll rows pass after normalization", () => {
  const ai: RentRollVerificationDocument = {
    ...rentRollBase,
    units: [
      {
        ...rentRollBase.units[0],
        residentName: "John Smith",
        marketRent: "$1,029.00",
        chargeCodes: "subrent,rent",
      },
    ],
  };

  const result = compareRentRollDocuments(rentRollBase, ai);
  assert.equal(result.status, "passed");
  assert.equal(result.discrepancyCount, 0);
});

test("Rent Roll value discrepancy is flagged", () => {
  const ai: RentRollVerificationDocument = {
    ...rentRollBase,
    units: [{ ...rentRollBase.units[0], rentAmount: 1079 }],
  };

  const result = compareRentRollDocuments(rentRollBase, ai);
  assert.equal(result.status, "discrepancies");
  assert.equal(result.discrepancies.some((item) => item.field === "rentAmount"), true);
});

test("missing Rent Roll unit is flagged and duplicates are preserved", () => {
  const keystone: RentRollVerificationDocument = {
    ...rentRollBase,
    expectedUnitCount: 2,
    units: [rentRollBase.units[0], { ...rentRollBase.units[0], residentName: "Jane Doe" }],
  };

  const result = compareRentRollDocuments(keystone, rentRollBase);
  assert.equal(result.discrepancies.some((item) => item.recordKey === "001#2" && item.type === "missing_in_ai"), true);
});

test("blank and zero remain distinct", () => {
  const ai: RentRollVerificationDocument = {
    ...rentRollBase,
    units: [{ ...rentRollBase.units[0], marketRent: null }],
  };

  const keystone: RentRollVerificationDocument = {
    ...rentRollBase,
    units: [{ ...rentRollBase.units[0], marketRent: 0 }],
  };

  const result = compareRentRollDocuments(keystone, ai);
  assert.equal(result.discrepancies.some((item) => item.field === "marketRent" && item.type === "blank_vs_zero"), true);
});

test("equal I&E rows pass", () => {
  const ai: IEVerificationDocument = {
    ...ieBase,
    periodLabels: ["2025", "t12"],
    rows: [{ ...ieBase.rows[0], internalNumber: "160", values: { "2025": "1,000.00", t12: 1200 } }],
  };

  const result = compareIEDocuments(ieBase, ai);
  assert.equal(result.status, "passed");
});

test("I&E value discrepancy is flagged", () => {
  const ai: IEVerificationDocument = {
    ...ieBase,
    rows: [{ ...ieBase.rows[0], values: { "2025": 1000, T12: 1250 } }],
  };

  const result = compareIEDocuments(ieBase, ai);
  assert.equal(result.discrepancies.some((item) => item.field === "values.t12"), true);
});

test("missing I&E row with blank account code uses line item plus occurrence", () => {
  const keystone: IEVerificationDocument = {
    ...ieBase,
    rows: [
      ...ieBase.rows,
      { accountCode: null, internalNumber: null, lineItem: "Misc Income", values: { "2025": 10, T12: 12 }, isSummary: false },
      { accountCode: null, internalNumber: null, lineItem: "Misc Income", values: { "2025": 20, T12: 24 }, isSummary: false },
    ],
  };

  const ai: IEVerificationDocument = {
    ...ieBase,
    rows: [
      ...ieBase.rows,
      { accountCode: null, internalNumber: null, lineItem: "Misc Income", values: { "2025": 10, T12: 12 }, isSummary: false },
    ],
  };

  const result = compareIEDocuments(keystone, ai);
  assert.equal(result.discrepancies.some((item) => item.recordKey === "misc income#2" && item.type === "missing_in_ai"), true);
});

test("provider failure reasons map to unavailable versus failed", () => {
  assert.deepEqual(verificationFailureState("insufficient_credits"), {
    status: "unavailable",
    failureReason: "insufficient_credits",
  });
  assert.equal(verificationFailureState("not_configured").status, "unavailable");
  assert.equal(verificationFailureState("rate_limited").status, "unavailable");
  assert.equal(verificationFailureState("invalid_output").status, "failed");
  assert.equal(verificationFailureState("timeout").status, "failed");
});

test("parses strict Rent Roll AI JSON and preserves leading zeroes", () => {
  const parsed = parseRentRollAIOutput(JSON.stringify({
    propertyName: "Example Apartments",
    asOfDate: "2026-10-31",
    expectedUnitCount: 1,
    units: [{
      unit: "001",
      unitType: "A1",
      sqft: 582,
      unitCategory: null,
      residentName: "Smith, John",
      marketRent: 1029,
      chargeCodes: ["RENT", "SUBRENT"],
      rentAmount: 1029,
      evidence: [],
      explanation: null,
      confidence: "high",
    }],
    warnings: [],
  }));

  assert.equal(parsed.units[0].unit, "001");
  assert.deepEqual(parsed.units[0].chargeCodes, ["RENT", "SUBRENT"]);
});

test("rejects malformed Rent Roll AI output", () => {
  assert.throws(
    () => parseRentRollAIOutput('{"propertyName":"x"}'),
    (error) => error instanceof AIVerificationError && error.reason === "invalid_output"
  );
});

test("derives Keystone-compatible categories from independent AI source fields", () => {
  const result = deriveRentRollCategoriesFromAI({
    propertyName: null,
    asOfDate: null,
    expectedUnitCount: 3,
    warnings: [],
    units: [
      { unit: "1", unitType: "A1r", sqft: 600, unitCategory: null, residentName: null, marketRent: null, chargeCodes: null, rentAmount: 0 },
      { unit: "2", unitType: "A1", sqft: 600, unitCategory: null, residentName: null, marketRent: null, chargeCodes: null, rentAmount: 0 },
      { unit: "3", unitType: "B2", sqft: 800, unitCategory: null, residentName: null, marketRent: null, chargeCodes: null, rentAmount: 0 },
    ],
  });

  assert.equal(result.units[0].unitCategory, "A");
  assert.equal(result.units[1].unitCategory, "A");
  assert.equal(result.units[2].unitCategory, "B");
});

test("Rent Roll AI runner keeps missing provider non-blocking", async () => {
  const result = await runRentRollAIVerification({
    sourceFile: { name: "test.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]) },
    keystoneWorkbookBuffer: new Uint8Array([1]),
    chargeCodes: ["rent"],
    provider: null,
  });

  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable" || result.status === "failed") {
    assert.equal(result.failureReason, "not_configured");
  }
});


test("normalizes common I&E period-label variants", () => {
  assert.equal(normalizePeriodLabel("T12 October 2026"), "t12 oct '26");
  assert.equal(normalizePeriodLabel("T12 Oct '26"), "t12 oct '26");
  assert.equal(normalizePeriodLabel("Budget 2027"), "2027 budget");
  assert.equal(normalizePeriodLabel("2027 Budget"), "2027 budget");
});

test("parses strict I&E AI JSON with dynamic period values", () => {
  const parsed = parseIEAIOutput(JSON.stringify({
    propertyName: "Example Apartments",
    sources: [
      {
        filename: "Example T12.xlsx",
        reportType: "t12",
        periodLabels: ["T12 Oct '26"],
      },
    ],
    periodLabels: ["2025", "T12 Oct '26", "2027 Budget"],
    rows: [
      {
        accountCode: "4100",
        internalNumber: 160,
        lineItem: "Other Income",
        values: [
          { periodLabel: "2025", value: 1000 },
          { periodLabel: "T12 October 2026", value: 1200 },
          { periodLabel: "Budget 2027", value: null },
        ],
        isSummary: false,
        evidence: [],
        explanation: null,
        confidence: "high",
      },
    ],
    warnings: [],
  }));

  assert.equal(parsed.rows[0].values["2025"], 1000);
  assert.equal(parsed.rows[0].values["T12 Oct '26"], 1200);
  assert.equal(parsed.rows[0].values["2027 Budget"], null);
});

test("rejects I&E AI rows that omit a final period", () => {
  assert.throws(
    () => parseIEAIOutput(JSON.stringify({
      propertyName: null,
      sources: [],
      periodLabels: ["2025", "2026"],
      rows: [
        {
          accountCode: null,
          internalNumber: null,
          lineItem: "Rent",
          values: [{ periodLabel: "2025", value: 10 }],
          isSummary: false,
          evidence: [],
          explanation: null,
          confidence: null,
        },
      ],
      warnings: [],
    })),
    (error) => error instanceof AIVerificationError && error.reason === "invalid_output"
  );
});

test("I&E AI runner keeps missing provider non-blocking", async () => {
  const result = await runIEAIVerification({
    sourceFiles: [
      {
        name: "annual.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes: new Uint8Array([1]),
      },
    ],
    keystoneWorkbookBuffer: new Uint8Array([1]),
    provider: null,
  });

  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable" || result.status === "failed") {
    assert.equal(result.failureReason, "not_configured");
  }
});
