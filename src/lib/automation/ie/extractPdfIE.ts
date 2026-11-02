import { extractPdfText } from "@/lib/extraction/pdfTextExtractor";

export type PdfIEReportType =
  | "annual"
  | "t12"
  | "budget"
  | "annualized"
  | "unknown";

export interface PdfIELineItem {
  accountCode: string | null;
  name: string;
  values: Array<number | null>;
}

export interface PdfIEAdditionalReport {
  reportType: PdfIEReportType;
  labels: string[];
  rows: PdfIELineItem[];
}

export interface PdfIEExtractionResult {
  propertyName: string;
  reportType: PdfIEReportType;
  labels: string[];
  rows: PdfIELineItem[];
  pageCount: number;
  warnings: string[];
  additionalReports?: PdfIEAdditionalReport[];
}

function cleanLine(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(value: string): number | null {
  let text = value.trim();

  if (!text) {
    return null;
  }

  let negative = false;

  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  }

  text = text
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .trim();

  if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
    return null;
  }

  const parsed = Number(text);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return negative ? -Math.abs(parsed) : parsed;
}

function isPageNoise(line: string): boolean {
  return (
    /^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s+[AP]M$/i.test(
      line
    ) ||
    /^Page\s+\d+\s+of\s+\d+$/i.test(line) ||
    /^Book\s*=/i.test(line) ||
    /^Period\s*=/i.test(line) ||
    /^EOY(?:\s+EOY)+$/i.test(line)
  );
}

function findPropertyName(pages: string[]): string {
  for (const page of pages) {
    const lines = page
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(Boolean);

    for (const line of lines) {
      const match = line.match(
        /^(.+?)\s+\(([^)]+)\)$/
      );

      if (match) {
        return match[1].trim();
      }
    }
  }

  return "";
}

function findAnnualYears(
  pages: string[]
): string[] {
  const documentText = pages.join("\n");

  /*
   * Prefer the explicit report period.
   *
   * Example:
   * Period = Jan 2021-Dec 2023
   *
   * This is more reliable than reading the individual
   * column headers because PDF extraction can occasionally
   * omit a middle year such as 2022.
   */
  const periodMatch = documentText.match(
    /Period\s*=\s*[A-Za-z]{3,9}\s+((?:19|20)\d{2})\s*[-–]\s*[A-Za-z]{3,9}\s+((?:19|20)\d{2})/i
  );

  if (periodMatch) {
    const startYear = Number(periodMatch[1]);
    const endYear = Number(periodMatch[2]);

    if (
      Number.isFinite(startYear) &&
      Number.isFinite(endYear) &&
      endYear >= startYear
    ) {
      const years: string[] = [];

      for (
        let year = startYear;
        year <= endYear;
        year += 1
      ) {
        years.push(String(year));
      }

      return years;
    }
  }

  /*
   * Fallback: read years from the first-page
   * column headings.
   */
  const firstPage = pages[0] ?? "";

  const lines = firstPage
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean);

  for (const line of lines) {
    const matches = Array.from(
      line.matchAll(
        /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+((?:19|20)\d{2})\b/gi
      )
    );

    if (matches.length >= 2) {
      return matches.map(
        (match) => match[1]
      );
    }
  }

  return [];
}

function findT12Label(
  pages: string[]
): string {
  const documentText = pages.join("\n");

  const match = documentText.match(
    /Period\s*=\s*([A-Za-z]{3,9})\s+(\d{4})\s*[-–]\s*([A-Za-z]{3,9})\s+(\d{4})/i
  );

  if (!match) {
    return "T12";
  }

  const endMonth =
    match[3].charAt(0).toUpperCase() +
    match[3].slice(1, 3).toLowerCase();

  const endYear = match[4];

  return `T12 ${endMonth} '${endYear.slice(-2)}`;
}

function parseAnnualRows(
  pages: string[],
  expectedValueCount: number
): PdfIELineItem[] {
  const rows: PdfIELineItem[] = [];

  const valuePattern =
    String.raw`-?\(?\$?[\d,]+(?:\.\d+)?\)?`;

  const valuesRegex = new RegExp(
    `(${valuePattern}(?:\\s+${valuePattern}){${
      expectedValueCount - 1
    }})$`
  );

  const accountRegex =
    /^(\d{5}-\d{3})\s+(.+)$/;

  for (const page of pages) {
    const lines = page
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(Boolean);

    for (const line of lines) {
      if (isPageNoise(line)) {
        continue;
      }

      if (
        /^Annual Statement$/i.test(line) ||
        /^Period\s*=/i.test(line) ||
        /^Book\s*=/i.test(line) ||
        /^EOY\b/i.test(line) ||
        /^Dec\s+\d{4}/i.test(line)
      ) {
        continue;
      }

      /*
       * Pull the annual values off the END of the row first.
       *
       * Example:
       * 41000-000 Market Rent 6,451,055.00 6,860,212.00 7,537,252.00
       */
      const valueMatch =
        line.match(valuesRegex);

      if (valueMatch) {
        const valueText =
          valueMatch[1];

        const numberMatches =
          valueText.match(
            new RegExp(valuePattern, "g")
          ) ?? [];

        if (
          numberMatches.length !==
          expectedValueCount
        ) {
          continue;
        }

        const values =
          numberMatches.map(parseNumber);

        /*
         * Everything before the annual values is:
         *
         * ACCOUNT CODE + LINE ITEM
         */
        const rowText = cleanLine(
          line.slice(
            0,
            valueMatch.index
          )
        );

        const accountMatch =
          rowText.match(accountRegex);

        if (accountMatch) {
          rows.push({
            accountCode: accountMatch[1],
            name: cleanLine(
              accountMatch[2]
            ),
            values,
          });

          continue;
        }

        /*
         * Fallback for a valued row without
         * an account code.
         */
        if (rowText) {
          rows.push({
            accountCode: null,
            name: rowText,
            values,
          });
        }

        continue;
      }

      /*
       * Preserve coded section/header rows.
       *
       * Examples:
       * 40004-000 Income
       * 40005-000 Rental Income
       * 50000-000 Expenses
       */
      const accountMatch =
        line.match(accountRegex);

      if (accountMatch) {
        rows.push({
          accountCode: accountMatch[1],
          name: cleanLine(
            accountMatch[2]
          ),
          values: Array(
            expectedValueCount
          ).fill(null),
        });
      }
    }
  }

  return rows;
}

function parseT12Rows(
  pages: string[]
): PdfIELineItem[] {
  const rows: PdfIELineItem[] = [];

  const accountRegex =
    /^(\d{4,5}-\d{2,3})\s+(.+)$/;

  for (const page of pages) {
    const lines = page
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(Boolean);

    for (const line of lines) {
      if (isPageNoise(line)) {
        continue;
      }

      if (
        /^Cash Flow\s*\(12 months\)$/i.test(
          line
        ) ||
        /^.+\s+\([^)]+\)$/.test(line) ||
        /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/i.test(
          line
        )
      ) {
        continue;
      }

      const accountMatch =
        line.match(accountRegex);

      /*
       * Some Yardi / Residential-style statements do not print a GL
       * account code at all.  Their rows begin directly with the line
       * item name, followed by 12 monthly values and a final Total.
       *
       * Keep the existing coded behavior when a code is present, but
       * allow the exact same monthly/Total structure to be parsed with
       * accountCode = null when the source genuinely omits codes.
       */
      const accountCode =
        accountMatch?.[1] ?? null;

      const remainder =
        accountMatch?.[2] ?? line;

      const parts =
        remainder.split(/\s+/);

      /*
       * A valued T12 line has:
       *
       * Description
       * + 12 monthly values
       * + Total
       *
       * So we read numeric values backwards from
       * the end of the line.
       */
      const reversedValues:
        Array<number | null> = [];

      let index = parts.length - 1;

      while (
        index >= 0 &&
        reversedValues.length < 13
      ) {
        const parsed =
          parseNumber(parts[index]);

        if (parsed === null) {
          break;
        }

        reversedValues.push(parsed);
        index -= 1;
      }

      const values =
        reversedValues.reverse();

      const name = parts
        .slice(0, index + 1)
        .join(" ")
        .trim();

      /*
       * Section/header account.
       *
       * Examples:
       * 40000-000 Income
       * 40001-000 Rental Income
       * 50000-000 Expenses
       */
      if (values.length === 0) {
        if (name) {
          rows.push({
            accountCode,
            name,
            values: [null],
          });
        }

        continue;
      }

      /*
       * A normal T12 valued row must contain
       * 12 months + Total.
       */
      if (values.length !== 13) {
        continue;
      }

      if (!name) {
        continue;
      }

      const total =
        values[values.length - 1];

      rows.push({
        accountCode,
        name,
        values: [total],
      });
    }
  }

  return rows;
}


interface QuickBooksPeriod {
  startMonth: number;
  startYear: number;
  endMonth: number;
  endYear: number;
}

const QUICKBOOKS_MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function findQuickBooksPeriod(
  pages: string[]
): QuickBooksPeriod | null {
  const text = pages.join("\n");

  const crossYearMatch = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+((?:19|20)\d{2})\s+through\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+((?:19|20)\d{2})\b/i
  );

  if (crossYearMatch) {
    const startMonth =
      QUICKBOOKS_MONTHS[crossYearMatch[1].toLocaleLowerCase()];
    const startYear = Number(crossYearMatch[2]);
    const endMonth =
      QUICKBOOKS_MONTHS[crossYearMatch[3].toLocaleLowerCase()];
    const endYear = Number(crossYearMatch[4]);

    if (
      startMonth &&
      endMonth &&
      Number.isFinite(startYear) &&
      Number.isFinite(endYear)
    ) {
      return {
        startMonth,
        startYear,
        endMonth,
        endYear,
      };
    }
  }

  const sameYearMatch = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+through\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+((?:19|20)\d{2})\b/i
  );

  if (!sameYearMatch) {
    return null;
  }

  const startMonth =
    QUICKBOOKS_MONTHS[sameYearMatch[1].toLocaleLowerCase()];
  const endMonth =
    QUICKBOOKS_MONTHS[sameYearMatch[2].toLocaleLowerCase()];
  const year = Number(sameYearMatch[3]);

  if (!startMonth || !endMonth || !Number.isFinite(year)) {
    return null;
  }

  return {
    startMonth,
    startYear: year,
    endMonth,
    endYear: year,
  };
}

function isQuickBooksProfitLoss(
  pages: string[]
): boolean {
  const text = pages.join("\n");

  return (
    /\bProfit\s*&\s*Loss\b/i.test(text) &&
    findQuickBooksPeriod(pages) !== null
  );
}

function findQuickBooksPropertyName(
  pages: string[]
): string {
  for (const page of pages) {
    const lines = page
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(Boolean);

    const titleIndex = lines.findIndex((line) =>
      /\bProfit\s*&\s*Loss\b/i.test(line)
    );

    if (titleIndex <= 0) {
      continue;
    }

    for (let index = titleIndex - 1; index >= 0; index -= 1) {
      const candidate = cleanLine(
        lines[index].replace(
          /^\d{1,2}\/\d{1,2}\/\d{2,4}\s+/,
          ""
        )
      );

      if (
        candidate &&
        !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(candidate) &&
        !/^Page\s+\d+(?:\s+of\s+\d+)?$/i.test(candidate)
      ) {
        return candidate;
      }
    }
  }

  /*
   * Some PDF text extractors place the date and property on one line
   * immediately before the Profit & Loss title. Fall back to searching
   * the opening lines for a plausible non-title value.
   */
  const firstLines = (pages[0] ?? "")
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean)
    .slice(0, 8);

  for (const rawLine of firstLines) {
    const candidate = cleanLine(
      rawLine.replace(
        /^\d{1,2}\/\d{1,2}\/\d{2,4}\s+/,
        ""
      )
    );

    if (
      candidate &&
      !/\bProfit\s*&\s*Loss\b/i.test(candidate) &&
      !/\bthrough\b/i.test(candidate) &&
      !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(candidate)
    ) {
      return candidate;
    }
  }

  return "";
}

function quickBooksPeriodMonthCount(
  period: QuickBooksPeriod
): number {
  return (
    (period.endYear - period.startYear) * 12 +
    (period.endMonth - period.startMonth) +
    1
  );
}

function quickBooksT12Label(
  period: QuickBooksPeriod
): string {
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  return `T12 ${monthNames[period.endMonth - 1]} '${String(
    period.endYear
  ).slice(-2)}`;
}

function isQuickBooksNoise(line: string): boolean {
  return (
    /^Profit\s*&\s*Loss$/i.test(line) ||
    /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(line) ||
    /^Page\s+\d+(?:\s+of\s+\d+)?$/i.test(line) ||
    /^(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+\d{4})?\s+through\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/i.test(
      line
    ) ||
    /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*-\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2,4}$/i.test(
      line
    )
  );
}

function parseQuickBooksRows(
  pages: string[],
  expectedNumericCount: number
): PdfIELineItem[] {
  const rows: PdfIELineItem[] = [];

  for (const page of pages) {
    const lines = page
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(Boolean);

    for (const line of lines) {
      if (isQuickBooksNoise(line)) {
        continue;
      }

      const parts = line.split(/\s+/);
      const reversedValues: number[] = [];
      let index = parts.length - 1;

      while (
        index >= 0 &&
        reversedValues.length < expectedNumericCount
      ) {
        const parsed = parseNumber(parts[index]);

        if (parsed === null) {
          break;
        }

        reversedValues.push(parsed);
        index -= 1;
      }

      if (reversedValues.length !== expectedNumericCount) {
        continue;
      }

      const rowText = cleanLine(
        parts.slice(0, index + 1).join(" ")
      );

      if (!rowText) {
        continue;
      }

      const values = reversedValues.reverse();
      const outputValue = values[values.length - 1];

      const codedTotal = rowText.match(
        /^Total\s+(\d{4,8})\s*(?:[·•]\s*)?(.+)$/i
      );

      if (codedTotal) {
        rows.push({
          accountCode: codedTotal[1],
          name: `Total ${cleanLine(codedTotal[2])}`,
          values: [outputValue],
        });
        continue;
      }

      const codedRow = rowText.match(
        /^(\d{4,8})\s*(?:[·•]\s*)?(.+)$/
      );

      if (codedRow) {
        rows.push({
          accountCode: codedRow[1],
          name: cleanLine(codedRow[2]),
          values: [outputValue],
        });
        continue;
      }

      /*
       * QuickBooks also prints valued summary lines without an account
       * code, such as Total Income, Net Ordinary Income, and Net Income.
       */
      if (/^(?:Total|Net)\b/i.test(rowText)) {
        rows.push({
          accountCode: null,
          name: rowText,
          values: [outputValue],
        });
      }
    }
  }

  return rows;
}

function isLouisburgCashFlow(
  pages: string[]
): boolean {
  const text = pages.join("\n").toLowerCase();

  return (
    text.includes("cash flow - 12 month") &&
    text.includes("properties:") &&
    text.includes("period range:")
  );
}

function isLouisburgAnnualized(
  pages: string[]
): boolean {
  const text = pages.join("\n").toLowerCase();

  return (
    isLouisburgCashFlow(pages) &&
    text.includes("t8 annualized")
  );
}

function findLouisburgPropertyName(
  pages: string[]
): string {
  const text = pages.join("\n");

  const match = text.match(
    /Properties:\s*(.+?)(?:\r?\n|$)/i
  );

  if (!match) {
    return "";
  }

  let property = cleanLine(match[1]);

  /*
   * Example:
   * Louisburg Landing - Autumn Circle Louisburg, KS 66053
   *
   * We want the property itself:
   * Louisburg Landing
   */
  const dashIndex = property.indexOf(" - ");

  if (dashIndex !== -1) {
    property = property.slice(0, dashIndex);
  }

  return property.trim();
}

function findLouisburgT12Label(
  pages: string[]
): string {
  const text = pages.join("\n");

  const match = text.match(
    /Period Range:\s*([A-Za-z]{3,9})\s+(\d{4})\s+to\s+([A-Za-z]{3,9})\s+(\d{4})/i
  );

  if (!match) {
    return "T12";
  }

  const month =
    match[3].charAt(0).toUpperCase() +
    match[3].slice(1, 3).toLowerCase();

  return `T12 ${month} '${match[4].slice(-2)}`;
}

function isLouisburgNoise(
  line: string
): boolean {
  return (
    /^Cash Flow - 12 Month$/i.test(line) ||
    /^Exported On:/i.test(line) ||
    /^RCW Service/i.test(line) ||
    /^Properties:/i.test(line) ||
    /^Period Range:/i.test(line) ||
    /^Additional Cash GL Accounts:/i.test(line) ||
    /^Level of Detail:/i.test(line) ||
    /^Include Zero Balance GL Accounts:/i.test(line) ||
    /^Account Name\b/i.test(line)
  );
}

function parseLouisburgT12Rows(
  pages: string[]
): PdfIELineItem[] {
  const rows: PdfIELineItem[] = [];

  const valuePattern =
    String.raw`(?:-?\$?[\d,]+(?:\.\d+)?|\(\$?[\d,]+(?:\.\d+)?\))`;

  const rowRegex = new RegExp(
    `^(.+?)\\s+(${valuePattern}(?:\\s+${valuePattern}){12})$`
  );

  for (const page of pages) {
    const lines = page
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(Boolean);

    for (const line of lines) {
      if (isLouisburgNoise(line)) {
        continue;
      }

      const match = line.match(rowRegex);

      if (match) {
        const name = cleanLine(match[1]);

        const numberMatches =
          match[2].match(
            new RegExp(valuePattern, "g")
          ) ?? [];

        if (numberMatches.length !== 13) {
          continue;
        }

        const total = parseNumber(
          numberMatches[12]
        );

        rows.push({
          accountCode: null,
          name,
          values: [total],
        });

        continue;
      }

      /*
       * Keep meaningful hierarchy rows:
       *
       * Operating Income & Expense
       * Income
       * RENTS
       * FEES
       * Expense
       * etc.
       */
      if (
        !/\d/.test(line) &&
        line.length > 1
      ) {
        rows.push({
          accountCode: null,
          name: line,
          values: [null],
        });
      }
    }
  }

  return rows;
}

function parseLouisburgAnnualizedRows(
  pages: string[]
): PdfIELineItem[] {
  const rows: PdfIELineItem[] = [];

  const numberPattern =
    String.raw`(?:-?\$?[\d,]+(?:\.\d+)?|\(\$?[\d,]+(?:\.\d+)?\))`;

  const dashPattern = String.raw`-`;

  const valuePattern =
    `(?:${numberPattern}|${dashPattern})`;

  const rowRegex = new RegExp(
    `^(.+?)\\s+(${valuePattern})\\s+(${valuePattern})\\s+(${valuePattern})$`
  );

  for (const page of pages) {
    const lines = page
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(Boolean);

    for (const line of lines) {
      if (isLouisburgNoise(line)) {
        continue;
      }

      const match = line.match(rowRegex);

      if (match) {
        const name = cleanLine(match[1]);

        /*
         * Columns are:
         *
         * Total
         * August 2026 T8
         * T8 Annualized
         *
         * We only need the final value.
         */
        const annualized =
          match[4] === "-"
            ? null
            : parseNumber(match[4]);

        rows.push({
          accountCode: null,
          name,
          values: [annualized],
        });

        continue;
      }

      if (
        !/\d/.test(line) &&
        line.length > 1
      ) {
        rows.push({
          accountCode: null,
          name: line,
          values: [null],
        });
      }
    }
  }

  return rows;
}

function isYardiBudget(
  pages: string[]
): boolean {
  const text = pages.join("\n").toLowerCase();

  return (
    /\bbudget\b/.test(text) &&
    /period\s*=\s*[a-z]{3}\s+\d{4}\s*-\s*[a-z]{3}\s+\d{4}/i.test(text) &&
    text.includes("total")
  );
}

function findYardiBudgetLabel(
  pages: string[]
): string {
  const text = pages.join("\n");

  const match = text.match(
    /Period\s*=\s*[A-Za-z]{3}\s+(\d{4})\s*-\s*[A-Za-z]{3}\s+(\d{4})/i
  );

  if (!match) {
    return "Budget";
  }

  return match[1] === match[2]
    ? `Budget ${match[1]}`
    : `Budget ${match[1]}-${match[2]}`;
}

function parseYardiBudgetRows(
  pages: string[]
): PdfIELineItem[] {
  const rows: PdfIELineItem[] = [];

  const accountRegex =
    /^(\d{4,5}-\d{2,3})\s+(.+)$/;

  for (const page of pages) {
    const lines = page
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(Boolean);

    for (const line of lines) {
      if (isPageNoise(line)) {
        continue;
      }

      if (
        /^Budget$/i.test(line) ||
        /^.+\s+\([^)]+\)$/.test(line) ||
        /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/i.test(
          line
        )
      ) {
        continue;
      }

      const accountMatch =
        line.match(accountRegex);

      const accountCode =
        accountMatch?.[1] ?? null;

      const remainder =
        accountMatch?.[2] ?? line;

      const parts =
        remainder.split(/\s+/);

      /*
       * Yardi budgets may be coded or code-less, but both layouts use
       * the same 12 monthly values + final Total shape.  Read the 13
       * numeric values from the end so descriptions can contain spaces
       * and punctuation without special-casing the property.
       */
      const reversedValues:
        Array<number | null> = [];

      let index = parts.length - 1;

      while (
        index >= 0 &&
        reversedValues.length < 13
      ) {
        const parsed =
          parseNumber(parts[index]);

        if (parsed === null) {
          break;
        }

        reversedValues.push(parsed);
        index -= 1;
      }

      const values =
        reversedValues.reverse();

      if (values.length !== 13) {
        continue;
      }

      const name = parts
        .slice(0, index + 1)
        .join(" ")
        .trim();

      if (!name) {
        continue;
      }

      rows.push({
        accountCode,
        name,
        values: [values[12]],
      });
    }
  }

  return rows;
}


function findSingleYearStatementYear(
  pages: string[]
): string | null {
  const text = pages.join("\n");

  if (!/(?:statement|cash flow)\s*\(12 months\)/i.test(text)) {
    return null;
  }

  const match = text.match(
    /Period\s*=\s*Jan(?:uary)?\s+((?:19|20)\d{2})\s*[-–]\s*Dec(?:ember)?\s+((?:19|20)\d{2})/i
  );

  if (!match || match[1] !== match[2]) {
    return null;
  }

  return match[1];
}

function detectAvignonReportType(
  pages: string[]
): PdfIEReportType {
  const text = pages
    .join("\n")
    .toLowerCase();

  if (
    text.includes("annual statement") &&
    text.includes("period =")
  ) {
    return "annual";
  }

if (
  (
    text.includes("cash flow (12 months)") ||
    text.includes("statement (12 months)")
  ) &&
  text.includes("period =")
) {
  return "t12";
}

  return "unknown";
}

function isWillowPointActualIE(
  pages: string[]
): boolean {
  const text = pages
    .join("\n")
    .toLowerCase();

  return (
    text.includes("12 month actual income statement") &&
    text.includes("month") &&
    text.includes("ending") &&
    text.includes("actual") &&
    text.includes("total")
  );
}

function findWillowPointPropertyName(
  pages: string[]
): string {
  const lines = pages
    .join("\n")
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean);

  /*
   * Some reports include a Location field.
   */
  for (let i = 0; i < lines.length; i += 1) {
    if (/^Location\b/i.test(lines[i])) {
      const sameLine = lines[i]
        .replace(/^Location\s*:?\s*/i, "")
        .trim();

      if (sameLine) {
        return sameLine;
      }

      if (lines[i + 1]) {
        return lines[i + 1];
      }
    }
  }

  /*
   * Willow / Cohen-Esrey reports can instead put
   * the property at the top:
   *
   * Willow Point - 422
   *
   * Strip the trailing property number.
   */
  for (const line of lines) {
    const match = line.match(
      /^(.+?)\s*-\s*\d+\s*$/
    );

    if (match) {
      return match[1].trim();
    }
  }

  return "";
}

function findWillowPointActualYear(
  pages: string[]
): string {
  const text = pages.join("\n");

  /*
   * Prefer an explicit As of Date when available.
   */
  const asOfMatch = text.match(
    /As of Date\s*:?\s*\d{1,2}\/\d{1,2}\/((?:19|20)\d{2})/i
  );

  if (asOfMatch) {
    return asOfMatch[1];
  }

  /*
   * These reports may extract the header as:
   *
   * Month Month Month...
   * Ending Ending Ending...
   * 12/31/2023 11/30/2023...
   *
   * So use the first full date in the report.
   * The columns are newest-to-oldest.
   */
  const dateMatch = text.match(
    /\b\d{1,2}\/\d{1,2}\/((?:19|20)\d{2})\b/
  );

  if (dateMatch) {
    return dateMatch[1];
  }

  throw new Error(
    "Could not determine the year from this 12 Month Actual Income Statement PDF."
  );
}

function parseWillowPointActualRows(
  pages: string[]
): PdfIELineItem[] {
  const rows: PdfIELineItem[] = [];

  const valuePattern =
    String.raw`(?:-?\$?[\d,]+(?:\.\d+)?|\(\$?[\d,]+(?:\.\d+)?\))`;

  /*
   * 12 monthly values + final Total = 13 values.
   */
  const rowRegex = new RegExp(
    `^(.+?)\\s+(${valuePattern}(?:\\s+${valuePattern}){12})$`
  );

  for (const page of pages) {
    const lines = page
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(Boolean);

    for (const line of lines) {
      /*
       * Ignore report headers / column headings.
       */
      if (
        /^12 Month Actual Income Statement$/i.test(line) ||
        /^As of Date\b/i.test(line) ||
        /^Location\b/i.test(line) ||
        /^Month Ending\b/i.test(line) ||
        /^Actual\b/i.test(line) ||
        /^Page\b/i.test(line)
      ) {
        continue;
      }

      const match = line.match(rowRegex);

      if (match) {
        const name = cleanLine(match[1]);

        const numbers =
          match[2].match(
            new RegExp(valuePattern, "g")
          ) ?? [];

        if (numbers.length !== 13) {
          continue;
        }

        /*
         * The 13th value is the Total column.
         */
        const total =
          parseNumber(numbers[12]);

        if (!name) {
          continue;
        }

        rows.push({
          accountCode: null,
          name,
          values: [total],
        });

        continue;
      }

      /*
       * Preserve meaningful section/header rows that
       * contain no numbers.
       */
      if (
        !/\d/.test(line) &&
        line.length > 1
      ) {
        rows.push({
          accountCode: null,
          name: line,
          values: [null],
        });
      }
    }
  }

  return rows;
}

function isWillowPointBudgetComparison(
  pages: string[]
): boolean {
  const text = pages
    .join("\n")
    .toLowerCase();

  return (
    text.includes("budget comparison cash flow") &&
    text.includes("year to date") &&
    text.includes("actual") &&
    text.includes("annual") &&
    text.includes("budget")
  );
}

function findWillowPointBudgetYear(
  pages: string[]
): string {
  const text = pages.join("\n");

  const asOfMatch = text.match(
    /As of Date\s*:?\s*\d{1,2}\/\d{1,2}\/((?:19|20)\d{2})/i
  );

  if (asOfMatch) {
    return asOfMatch[1];
  }

  const dateMatch = text.match(
    /\b\d{1,2}\/\d{1,2}\/((?:19|20)\d{2})\b/
  );

  if (dateMatch) {
    return dateMatch[1];
  }

  throw new Error(
    "Could not determine the year from this Budget Comparison Cash Flow PDF."
  );
}

function parseWillowPointBudgetComparisonRows(
  pages: string[]
): {
  actualRows: PdfIELineItem[];
  budgetRows: PdfIELineItem[];
} {
  const actualRows: PdfIELineItem[] = [];
  const budgetRows: PdfIELineItem[] = [];

  const valuePattern =
    String.raw`(?:-?\$?[\d,]+(?:\.\d+)?|\(\$?[\d,]+(?:\.\d+)?\))`;

  for (const page of pages) {
    const lines = page
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(Boolean);

    for (const line of lines) {
      if (
        /^Budget Comparison Cash Flow$/i.test(line) ||
        /^As of Date\b/i.test(line) ||
        /^Location\b/i.test(line) ||
        /^Page\b/i.test(line)
      ) {
        continue;
      }

      const numberMatches =
        line.match(
          new RegExp(valuePattern, "g")
        ) ?? [];

      if (numberMatches.length < 2) {
        continue;
      }

      const firstNumberIndex =
        line.search(
          new RegExp(valuePattern)
        );

      if (firstNumberIndex < 0) {
        continue;
      }

      const name = cleanLine(
        line.slice(0, firstNumberIndex)
      );

      if (!name) {
        continue;
      }

if (numberMatches.length !== 9) {
  continue;
}

const actualValue =
  parseNumber(numberMatches[4]);

const budgetValue =
  parseNumber(numberMatches[8]);

      actualRows.push({
        accountCode: null,
        name,
        values: [actualValue],
      });

      budgetRows.push({
        accountCode: null,
        name,
        values: [budgetValue],
      });
    }
  }

  return {
    actualRows,
    budgetRows,
  };
}



function isGaslightAnnualIE(
  pages: string[]
): boolean {
  const text = pages
    .join("\n")
    .toLowerCase();

  return (
    text.includes("gaslight square apartments") &&
    text.includes("12 mo. ytd") &&
    text.includes("jan-dec") &&
    (
      text.includes("income and expenses") ||
      text.includes("income and expense report")
    )
  );
}

function findGaslightYear(
  pages: string[]
): string {
  const text = pages.join("\n");

  /*
   * Header examples:
   * Crownlight LLC Dec-24
   * Crownlight LLC Dec-23
   */
  const match = text.match(
    /\bDec-(\d{2})\b/i
  );

  if (!match) {
    throw new Error(
      "Could not determine the year from this Gaslight I&E PDF."
    );
  }

  const shortYear = Number(match[1]);

  return String(
    shortYear >= 70
      ? 1900 + shortYear
      : 2000 + shortYear
  );
}

function parseGaslightAnnualRows(
  pages: string[]
): PdfIELineItem[] {
  const rows: PdfIELineItem[] = [];

  /*
   * Gaslight has five numeric columns:
   *
   * This Month
   * Last Month
   * Prev-Yr-to-date
   * 12 Mo. YTD Jan-Dec   <-- WE WANT THIS
   * 12 Month AVG
   *
   * Therefore the annual value is the SECOND-TO-LAST
   * numeric value on a normal row.
   */
  const moneyPattern =
    /-?\$[\d,]+(?:\.\d+)?/g;

  for (const page of pages) {
    const lines = page
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(Boolean);

    for (const line of lines) {
      if (
        /Crownlight LLC/i.test(line) ||
        /GASLIGHT SQUARE APARTMENTS/i.test(line) ||
        /^Date:/i.test(line) ||
        /12 Mo\. YTD/i.test(line) ||
        /12 Month AVG/i.test(line) ||
        /^Page\b/i.test(line)
      ) {
        continue;
      }

      const matches =
        line.match(moneyPattern) ?? [];

      if (matches.length < 2) {
        continue;
      }

      /*
       * The YTD value is the second-to-last money
       * value in the extracted row.
       */
      const annualValue =
        parseNumber(
          matches[matches.length - 2]
        );

      /*
       * Remove all numeric columns from the end,
       * leaving the descriptive portion.
       */
      const firstMoneyIndex =
        line.search(moneyPattern);

      if (firstMoneyIndex < 0) {
        continue;
      }

      let name = cleanLine(
        line.slice(0, firstMoneyIndex)
      );

      if (!name) {
        continue;
      }

      /*
       * Remove obvious vendor/comment text from a few
       * rows only where it appears after the actual
       * accounting description.
       *
       * Most importantly, keep the accounting line
       * itself stable between years.
       */
      name = name
        .replace(/\s+/g, " ")
        .trim();

      rows.push({
        accountCode: null,
        name,
        values: [annualValue],
      });
    }
  }

  return rows;
}

export async function extractPdfIE(
  input: Buffer
): Promise<PdfIEExtractionResult> {
  const extraction = await extractPdfText(
    new Uint8Array(input)
  );

  if (!extraction.hasSelectableText) {
    throw new Error(
      "This I&E PDF does not contain selectable text."
    );
  }


  /*
   * ============================================================
   * QUICKBOOKS / PROFIT & LOSS
   * ============================================================
   *
   * Supports:
   * - full-calendar-year Profit & Loss PDFs (Annual)
   * - rolling 12-month Profit & Loss PDFs with 12 months + TOTAL (T12)
   *
   * Scanned/image-only QuickBooks PDFs remain unsupported and are handled
   * by the existing selectable-text guard above.
   */
  if (isQuickBooksProfitLoss(extraction.pages)) {
    const propertyName =
      findQuickBooksPropertyName(extraction.pages);
    const period =
      findQuickBooksPeriod(extraction.pages);

    if (!propertyName || !period) {
      throw new Error(
        "The QuickBooks Profit & Loss PDF was recognized, but its property name or report period could not be determined."
      );
    }

    const monthCount =
      quickBooksPeriodMonthCount(period);

    const isAnnual =
      period.startMonth === 1 &&
      period.endMonth === 12 &&
      period.startYear === period.endYear;

    const isT12 = monthCount === 12;

    if (!isAnnual && !isT12) {
      throw new Error(
        "The QuickBooks Profit & Loss PDF was recognized, but it is not a full-calendar-year Annual or a 12-month T12 report."
      );
    }

    const rows = parseQuickBooksRows(
      extraction.pages,
      isAnnual ? 1 : 13
    );

    if (rows.length === 0) {
      throw new Error(
        "The QuickBooks Profit & Loss PDF was recognized, but no valued I&E rows could be extracted."
      );
    }

    return {
      propertyName,
      reportType: isAnnual ? "annual" : "t12",
      labels: isAnnual
        ? [String(period.endYear)]
        : [quickBooksT12Label(period)],
      rows,
      pageCount: extraction.pageCount,
      warnings: [],
    };
  }

  /*
 * WILLOW POINT / BUDGET COMPARISON CASH FLOW
 *
 * This PDF contains BOTH:
 * - annual actual
 * - annual budget
 */
if (isWillowPointBudgetComparison(extraction.pages)) {
  const propertyName =
    findWillowPointPropertyName(
      extraction.pages
    );

  if (!propertyName) {
    throw new Error(
      "Could not determine the property name from this Budget Comparison Cash Flow PDF."
    );
  }

  const year =
    findWillowPointBudgetYear(
      extraction.pages
    );

  const {
    actualRows,
    budgetRows,
  } =
    parseWillowPointBudgetComparisonRows(
      extraction.pages
    );

  if (
    actualRows.length === 0 ||
    budgetRows.length === 0
  ) {
    throw new Error(
      "The Budget Comparison Cash Flow PDF was recognized, but its actual and budget rows could not be extracted."
    );
  }

  return {
    propertyName,
    reportType: "annual",
    labels: [year],
    rows: actualRows,
    pageCount: extraction.pageCount,
    warnings: [],
    additionalReports: [
      {
        reportType: "budget",
        labels: [`Budget ${year}`],
        rows: budgetRows,
      },
    ],
  };
}

  /*
 * WILLOW POINT / 12 MONTH ACTUAL INCOME STATEMENT
 */
if (isWillowPointActualIE(extraction.pages)) {
  const propertyName =
    findWillowPointPropertyName(
      extraction.pages
    );

  if (!propertyName) {
    throw new Error(
      "Could not determine the property name from this 12 Month Actual Income Statement PDF."
    );
  }

    const year =
    findWillowPointActualYear(
      extraction.pages
    );

  const rows =
    parseWillowPointActualRows(
      extraction.pages
    );

  if (rows.length === 0) {
    throw new Error(
      "The 12 Month Actual Income Statement PDF was recognized, but no annual rows could be extracted."
    );
  }

  return {
    propertyName,
    reportType: "annual",
    labels: [year],
    rows,
    pageCount: extraction.pageCount,
    warnings: [],
  };
}

/*
 * GASLIGHT SQUARE / CROWNLIGHT
 */
if (isGaslightAnnualIE(extraction.pages)) {
  const year =
    findGaslightYear(
      extraction.pages
    );

  const rows =
    parseGaslightAnnualRows(
      extraction.pages
    );

  if (rows.length === 0) {
    throw new Error(
      "The Gaslight I&E PDF was recognized, but no annual rows could be extracted."
    );
  }

  return {
    propertyName:
      "Gaslight Square Apartments",
    reportType: "annual",
    labels: [year],
    rows,
    pageCount:
      extraction.pageCount,
    warnings: [],
  };
}

/*
 * ============================================================
 * FAMILY 1 — LOUISBURG / CASH FLOW - 12 MONTH
 * ============================================================
 */

if (isLouisburgCashFlow(extraction.pages)) {
  const propertyName =
    findLouisburgPropertyName(
      extraction.pages
    );

  if (!propertyName) {
    throw new Error(
      "Could not determine the property name from this Cash Flow PDF."
    );
  }

  if (isLouisburgAnnualized(extraction.pages)) {
    const rows =
      parseLouisburgAnnualizedRows(
        extraction.pages
      );

    if (rows.length === 0) {
      throw new Error(
        "No I&E rows were found in the T8 Annualized PDF."
      );
    }

    return {
      propertyName,
      reportType: "annualized",
      labels: ["T8 Annualized"],
      rows,
      pageCount: extraction.pageCount,
      warnings: [],
    };
  }

  const rows =
    parseLouisburgT12Rows(
      extraction.pages
    );

  if (rows.length === 0) {
    throw new Error(
      "No I&E rows were found in the Cash Flow T12 PDF."
    );
  }

  return {
    propertyName,
    reportType: "t12",
    labels: [
      findLouisburgT12Label(
        extraction.pages
      ),
    ],
    rows,
    pageCount: extraction.pageCount,
    warnings: [],
  };
}

/*
 * ============================================================
 * FAMILY 2 — AVIGNON / YARDI
 * ============================================================
 */

const propertyName =
  findPropertyName(extraction.pages);

/*
 * YARDI BUDGET
 */
if (isYardiBudget(extraction.pages)) {
  if (!propertyName) {
    throw new Error(
      "Could not determine the property name from this Budget PDF."
    );
  }

  const label =
    findYardiBudgetLabel(
      extraction.pages
    );

  const rows =
    parseYardiBudgetRows(
      extraction.pages
    );

  if (rows.length === 0) {
    throw new Error(
      "The Yardi Budget PDF was recognized, but no budget rows could be extracted."
    );
  }

  return {
    propertyName,
    reportType: "budget",
    labels: [label],
    rows,
    pageCount: extraction.pageCount,
    warnings: [],
  };
}

const singleYearStatement =
  findSingleYearStatementYear(
    extraction.pages
  );

if (singleYearStatement) {
  const rows =
    parseT12Rows(
      extraction.pages
    );

  if (rows.length === 0) {
    throw new Error(
      "No I&E rows were found in the one-year Statement PDF."
    );
  }

  return {
    propertyName,
    reportType: "annual",
    labels: [singleYearStatement],
    rows,
    pageCount: extraction.pageCount,
    warnings: [],
  };
}

const reportType =
  detectAvignonReportType(
    extraction.pages
  );

if (reportType === "annual") {
  const years =
    findAnnualYears(
      extraction.pages
    );

  if (years.length !== 3) {
    throw new Error(
      `Could not determine the three annual years from this Annual Statement. Found: ${
        years.join(", ") || "none"
      }.`
    );
  }

  const rows = parseAnnualRows(
    extraction.pages,
    years.length
  );

  if (rows.length === 0) {
    throw new Error(
      "No I&E rows were found in the Annual Statement PDF."
    );
  }

  return {
    propertyName,
    reportType: "annual",
    labels: years,
    rows,
    pageCount: extraction.pageCount,
    warnings: [],
  };
}

if (reportType === "t12") {
  const label =
    findT12Label(
      extraction.pages
    );

  const rows =
    parseT12Rows(
      extraction.pages
    );

  if (rows.length === 0) {
    throw new Error(
      "No I&E rows were found in the T12 PDF."
    );
  }

  return {
    propertyName,
    reportType: "t12",
    labels: [label],
    rows,
    pageCount: extraction.pageCount,
    warnings: [],
  };
}

throw new Error(
  "This PDF I&E format is not supported yet."
);
}
