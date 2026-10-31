import assert from "node:assert/strict";
import test from "node:test";
import {
  compareIEDocuments,
  compareRentRollDocuments,
} from "../src/lib/automation/ai-verification/compare";
import { verificationFailureState } from "../src/lib/automation/ai-verification/errors";
import {
  chargeCodeSetsEqual,
  currencyValuesEqual,
  normalizeMoney,
  normalizeText,
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
