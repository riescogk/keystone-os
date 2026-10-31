import type {
  IEVerificationDocument,
  IEVerificationRow,
} from "./ieTypes";
import {
  chargeCodeSetsEqual,
  currencyValuesEqual,
  isBlankVsZero,
  normalizeChargeCodes,
  normalizeInternalNumber,
  normalizeMoney,
  normalizePeriodLabel,
  normalizeResidentName,
  normalizeText,
  normalizeUnitIdentifier,
  scalarValuesEqual,
} from "./normalize";
import type {
  RentRollVerificationDocument,
  RentRollVerificationUnit,
} from "./rentRollTypes";
import type {
  AIVerificationComparisonResult,
  AIVerificationDiscrepancy,
  AIVerificationDiscrepancyType,
} from "./types";

interface KeyedRecord<T> {
  key: string;
  record: T;
}

function resultFrom(
  comparedRecordCount: number,
  discrepancies: AIVerificationDiscrepancy[]
): AIVerificationComparisonResult {
  return {
    status: discrepancies.length === 0 ? "passed" : "discrepancies",
    comparedRecordCount,
    discrepancyCount: discrepancies.length,
    discrepancies,
  };
}

function mismatchType(left: unknown, right: unknown): AIVerificationDiscrepancyType {
  return isBlankVsZero(left, right) ? "blank_vs_zero" : "value_mismatch";
}

function keyedRentRollUnits(
  units: RentRollVerificationUnit[]
): KeyedRecord<RentRollVerificationUnit>[] {
  const occurrences = new Map<string, number>();

  return units.map((record) => {
    const unit = normalizeUnitIdentifier(record.unit) ?? "<blank-unit>";
    const occurrence = (occurrences.get(unit) ?? 0) + 1;
    occurrences.set(unit, occurrence);

    return {
      key: `${unit}#${occurrence}`,
      record,
    };
  });
}

function rentRollEvidence(unit: RentRollVerificationUnit) {
  return {
    aiEvidence: unit.evidence,
    aiExplanation: unit.explanation,
    aiConfidence: unit.confidence,
  };
}

export function compareRentRollDocuments(
  keystone: RentRollVerificationDocument,
  ai: RentRollVerificationDocument
): AIVerificationComparisonResult {
  const discrepancies: AIVerificationDiscrepancy[] = [];

  if (keystone.units.length !== ai.units.length) {
    discrepancies.push({
      recordKey: "rent-roll",
      field: "unitCount",
      keystoneValue: keystone.units.length,
      aiValue: ai.units.length,
      type: "unit_count_mismatch",
    });
  }

  if (
    keystone.expectedUnitCount !== null &&
    ai.expectedUnitCount !== null &&
    keystone.expectedUnitCount !== ai.expectedUnitCount
  ) {
    discrepancies.push({
      recordKey: "rent-roll",
      field: "expectedUnitCount",
      keystoneValue: keystone.expectedUnitCount,
      aiValue: ai.expectedUnitCount,
      type: "unit_count_mismatch",
    });
  }

  const keystoneRecords = new Map(
    keyedRentRollUnits(keystone.units).map((item) => [item.key, item.record])
  );
  const aiRecords = new Map(
    keyedRentRollUnits(ai.units).map((item) => [item.key, item.record])
  );
  const allKeys = new Set([...keystoneRecords.keys(), ...aiRecords.keys()]);

  for (const key of allKeys) {
    const keystoneUnit = keystoneRecords.get(key);
    const aiUnit = aiRecords.get(key);

    if (!keystoneUnit && aiUnit) {
      discrepancies.push({
        recordKey: key,
        field: "record",
        keystoneValue: null,
        aiValue: aiUnit,
        type: "missing_in_keystone",
        ...rentRollEvidence(aiUnit),
      });
      continue;
    }

    if (keystoneUnit && !aiUnit) {
      discrepancies.push({
        recordKey: key,
        field: "record",
        keystoneValue: keystoneUnit,
        aiValue: null,
        type: "missing_in_ai",
      });
      continue;
    }

    if (!keystoneUnit || !aiUnit) {
      continue;
    }

    const textFields: Array<
      [keyof RentRollVerificationUnit, (value: unknown) => unknown]
    > = [
      ["unitType", normalizeText],
      ["sqft", normalizeText],
      ["unitCategory", normalizeText],
      ["residentName", normalizeResidentName],
    ];

    for (const [field, normalize] of textFields) {
      if (normalize(keystoneUnit[field]) !== normalize(aiUnit[field])) {
        discrepancies.push({
          recordKey: key,
          field,
          keystoneValue: keystoneUnit[field],
          aiValue: aiUnit[field],
          type: "value_mismatch",
          ...rentRollEvidence(aiUnit),
        });
      }
    }

    for (const field of ["marketRent", "rentAmount"] as const) {
      if (!currencyValuesEqual(keystoneUnit[field], aiUnit[field])) {
        discrepancies.push({
          recordKey: key,
          field,
          keystoneValue: keystoneUnit[field],
          aiValue: aiUnit[field],
          type: mismatchType(keystoneUnit[field], aiUnit[field]),
          ...rentRollEvidence(aiUnit),
        });
      }
    }

    if (!chargeCodeSetsEqual(keystoneUnit.chargeCodes, aiUnit.chargeCodes)) {
      discrepancies.push({
        recordKey: key,
        field: "chargeCodes",
        keystoneValue: normalizeChargeCodes(keystoneUnit.chargeCodes),
        aiValue: normalizeChargeCodes(aiUnit.chargeCodes),
        type: "value_mismatch",
        ...rentRollEvidence(aiUnit),
      });
    }
  }

  return resultFrom(allKeys.size, discrepancies);
}

function ieBaseIdentity(row: IEVerificationRow): string {
  const lineItem = normalizeText(row.lineItem) ?? "<blank-line-item>";
  const accountCode = normalizeText(row.accountCode);

  return accountCode ? `${accountCode}|${lineItem}` : lineItem;
}

function keyedIERows(rows: IEVerificationRow[]): KeyedRecord<IEVerificationRow>[] {
  const occurrences = new Map<string, number>();

  return rows.map((record) => {
    const base = ieBaseIdentity(record);
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);

    return {
      key: `${base}#${occurrence}`,
      record,
    };
  });
}

function ieEvidence(row: IEVerificationRow) {
  return {
    aiEvidence: row.evidence,
    aiExplanation: row.explanation,
    aiConfidence: row.confidence,
  };
}

function normalizedPeriods(document: IEVerificationDocument): Map<string, string> {
  const periods = new Map<string, string>();

  for (const period of document.periodLabels) {
    const normalized = normalizePeriodLabel(period);
    if (normalized && !periods.has(normalized)) {
      periods.set(normalized, period);
    }
  }

  return periods;
}

export function compareIEDocuments(
  keystone: IEVerificationDocument,
  ai: IEVerificationDocument
): AIVerificationComparisonResult {
  const discrepancies: AIVerificationDiscrepancy[] = [];
  const keystonePeriods = normalizedPeriods(keystone);
  const aiPeriods = normalizedPeriods(ai);
  const allPeriods = new Set([...keystonePeriods.keys(), ...aiPeriods.keys()]);

  for (const period of allPeriods) {
    if (!keystonePeriods.has(period) || !aiPeriods.has(period)) {
      discrepancies.push({
        recordKey: "ie",
        field: "periodLabels",
        keystoneValue: keystonePeriods.get(period) ?? null,
        aiValue: aiPeriods.get(period) ?? null,
        type: "period_mismatch",
      });
    }
  }

  const keystoneRows = new Map(
    keyedIERows(keystone.rows).map((item) => [item.key, item.record])
  );
  const aiRows = new Map(
    keyedIERows(ai.rows).map((item) => [item.key, item.record])
  );
  const allKeys = new Set([...keystoneRows.keys(), ...aiRows.keys()]);

  for (const key of allKeys) {
    const keystoneRow = keystoneRows.get(key);
    const aiRow = aiRows.get(key);

    if (!keystoneRow && aiRow) {
      discrepancies.push({
        recordKey: key,
        field: "record",
        keystoneValue: null,
        aiValue: aiRow,
        type: "missing_in_keystone",
        ...ieEvidence(aiRow),
      });
      continue;
    }

    if (keystoneRow && !aiRow) {
      discrepancies.push({
        recordKey: key,
        field: "record",
        keystoneValue: keystoneRow,
        aiValue: null,
        type: "missing_in_ai",
      });
      continue;
    }

    if (!keystoneRow || !aiRow) {
      continue;
    }

    if (
      normalizeInternalNumber(keystoneRow.internalNumber) !==
      normalizeInternalNumber(aiRow.internalNumber)
    ) {
      discrepancies.push({
        recordKey: key,
        field: "internalNumber",
        keystoneValue: keystoneRow.internalNumber,
        aiValue: aiRow.internalNumber,
        type: "mapping_mismatch",
        ...ieEvidence(aiRow),
      });
    }

    if (keystoneRow.isSummary !== aiRow.isSummary) {
      discrepancies.push({
        recordKey: key,
        field: "isSummary",
        keystoneValue: keystoneRow.isSummary,
        aiValue: aiRow.isSummary,
        type: "value_mismatch",
        ...ieEvidence(aiRow),
      });
    }

    const rowPeriods = new Set([
      ...Object.keys(keystoneRow.values).map((value) => normalizePeriodLabel(value)).filter(Boolean),
      ...Object.keys(aiRow.values).map((value) => normalizePeriodLabel(value)).filter(Boolean),
    ] as string[]);

    for (const period of rowPeriods) {
      const keystoneEntry = Object.entries(keystoneRow.values).find(
        ([label]) => normalizePeriodLabel(label) === period
      );
      const aiEntry = Object.entries(aiRow.values).find(
        ([label]) => normalizePeriodLabel(label) === period
      );

      if (!keystoneEntry || !aiEntry) {
        discrepancies.push({
          recordKey: key,
          field: `values.${period}`,
          keystoneValue: keystoneEntry?.[1] ?? null,
          aiValue: aiEntry?.[1] ?? null,
          type: "period_mismatch",
          ...ieEvidence(aiRow),
        });
        continue;
      }

      const keystoneValue = keystoneEntry[1];
      const aiValue = aiEntry[1];

      if (!currencyValuesEqual(keystoneValue, aiValue)) {
        const type = keystoneRow.isSummary || aiRow.isSummary
          ? "total_mismatch"
          : mismatchType(keystoneValue, aiValue);

        discrepancies.push({
          recordKey: key,
          field: `values.${period}`,
          keystoneValue: normalizeMoney(keystoneValue),
          aiValue: normalizeMoney(aiValue),
          type,
          ...ieEvidence(aiRow),
        });
      }
    }

    // Account code and line item are part of the comparison identity. This
    // explicit check still protects callers that construct documents manually.
    if (!scalarValuesEqual(keystoneRow.accountCode, aiRow.accountCode)) {
      discrepancies.push({
        recordKey: key,
        field: "accountCode",
        keystoneValue: keystoneRow.accountCode,
        aiValue: aiRow.accountCode,
        type: "value_mismatch",
        ...ieEvidence(aiRow),
      });
    }
  }

  return resultFrom(allKeys.size, discrepancies);
}
