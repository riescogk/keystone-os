import type { RentRollVerificationDocument, RentRollVerificationUnit } from "./rentRollTypes";

interface CategoryDefinition {
  key: string;
}

function categoryDefinition(unitType: string | null, sqft: number | string | null): CategoryDefinition {
  const normalized = (unitType ?? "").trim();
  const match = normalized.match(/([A-Za-z]+)(\d+)([A-Za-z]*)$/);

  if (match) {
    const letters = match[1].toUpperCase();
    const number = match[2];
    const rawSuffix = match[3] ?? "";
    const suffix = rawSuffix.toLowerCase() === "r" ? "" : rawSuffix.toLowerCase();
    return { key: `PLAN:${letters}:${number}:${suffix}` };
  }

  return { key: `SQFT:${String(sqft ?? "").trim()}` };
}

function sortParts(key: string) {
  if (key.startsWith("PLAN:")) {
    const [, letters = "", number = "0", suffix = ""] = key.split(":");
    return { fallback: false, letters, number: Number(number), suffix, sqft: 0 };
  }

  const parsedSqft = Number(key.replace(/^SQFT:/, ""));
  return {
    fallback: true,
    letters: "",
    number: 0,
    suffix: "",
    sqft: Number.isFinite(parsedSqft) ? parsedSqft : Number.MAX_SAFE_INTEGER,
  };
}

function compareKeys(a: string, b: string): number {
  const left = sortParts(a);
  const right = sortParts(b);

  if (left.fallback !== right.fallback) {
    return left.fallback ? 1 : -1;
  }
  if (!left.fallback && !right.fallback) {
    const letters = left.letters.localeCompare(right.letters);
    if (letters !== 0) return letters;
    if (left.number !== right.number) return left.number - right.number;
    return left.suffix.localeCompare(right.suffix);
  }
  return left.sqft - right.sqft;
}

function excelColumnLabel(index: number): string {
  let number = index + 1;
  let result = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}

/**
 * Apply only Keystone's deterministic display-category rule to the AI-extracted
 * source data. The AI remains responsible for the actual source extraction.
 * This prevents meaningless category mismatches when category letters are not
 * present in the source document itself.
 */
export function deriveRentRollCategoriesFromAI(
  document: RentRollVerificationDocument
): RentRollVerificationDocument {
  const definitions = new Set<string>();
  for (const unit of document.units) {
    definitions.add(categoryDefinition(unit.unitType, unit.sqft).key);
  }

  const ordered = [...definitions].sort(compareKeys);
  const categoryByKey = new Map(ordered.map((key, index) => [key, excelColumnLabel(index)]));

  const units: RentRollVerificationUnit[] = document.units.map((unit) => ({
    ...unit,
    unitCategory: categoryByKey.get(categoryDefinition(unit.unitType, unit.sqft).key) ?? null,
  }));

  return { ...document, units };
}
