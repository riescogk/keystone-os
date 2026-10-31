const NULL_TOKENS = new Set(["", "-", "$-", "—", "–"]);

export const CURRENCY_ABSOLUTE_TOLERANCE = 0.005;

export function normalizeText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value)
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();

  return normalized || null;
}

/**
 * Unit identifiers are always strings. Never numeric-coerce them, because
 * values such as 001 and 0102 are meaningful identifiers in Rent Rolls.
 */
export function normalizeUnitIdentifier(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim().replace(/\s+/g, " ");
  return normalized || null;
}

export function normalizeResidentName(value: unknown): string | null {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  // Conservatively normalize the common "Last, First" representation while
  // leaving more complex multi-comma names untouched.
  const parts = normalized.split(",").map((part) => part.trim()).filter(Boolean);

  if (parts.length === 2) {
    return `${parts[1]} ${parts[0]}`.replace(/\s+/g, " ").trim();
  }

  return normalized;
}

export function normalizeMoney(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  let text = String(value).trim();

  if (NULL_TOKENS.has(text)) {
    return null;
  }

  let negative = false;

  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  text = text
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/\*/g, "")
    .trim();

  if (NULL_TOKENS.has(text)) {
    return null;
  }

  const parsed = Number(text);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return negative ? -Math.abs(parsed) : parsed;
}

export function currencyValuesEqual(
  left: unknown,
  right: unknown,
  tolerance = CURRENCY_ABSOLUTE_TOLERANCE
): boolean {
  const normalizedLeft = normalizeMoney(left);
  const normalizedRight = normalizeMoney(right);

  if (normalizedLeft === null || normalizedRight === null) {
    return normalizedLeft === normalizedRight;
  }

  return Math.abs(normalizedLeft - normalizedRight) < tolerance;
}

export function isBlankVsZero(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeMoney(left);
  const normalizedRight = normalizeMoney(right);

  return (
    (normalizedLeft === null && normalizedRight === 0) ||
    (normalizedLeft === 0 && normalizedRight === null)
  );
}

export function normalizeChargeCodes(value: unknown): string[] {
  const input = Array.isArray(value) ? value : [value];
  const normalized = input
    .flatMap((item) => {
      if (item === null || item === undefined) {
        return [];
      }

      return String(item).split(/[,;+]/g);
    })
    .map((item) => normalizeText(item))
    .filter((item): item is string => Boolean(item));

  return [...new Set(normalized)].sort();
}

export function chargeCodeSetsEqual(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeChargeCodes(left);
  const normalizedRight = normalizeChargeCodes(right);

  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

export function normalizeInternalNumber(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

export function scalarValuesEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "number" || typeof right === "number") {
    const leftNumber = normalizeMoney(left);
    const rightNumber = normalizeMoney(right);

    if (leftNumber !== null || rightNumber !== null) {
      return currencyValuesEqual(left, right);
    }
  }

  return normalizeText(left) === normalizeText(right);
}

export function normalizePeriodLabel(value: unknown): string | null {
  const normalized = normalizeText(value)?.replace(/[’`]/g, "'");

  if (!normalized) {
    return null;
  }

  const t12Match = normalized.match(
    /\bt12\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[^0-9]*(\d{2,4})\b/i
  );

  if (t12Match) {
    const month = t12Match[1].slice(0, 3).toLocaleLowerCase();
    const year = t12Match[2].slice(-2);
    return `t12 ${month} '${year}`;
  }

  if (normalized.includes("budget")) {
    const year = normalized.match(/\b(?:19|20)\d{2}\b/)?.[0];
    if (year) {
      return `${year} budget`;
    }
  }

  return normalized;
}
