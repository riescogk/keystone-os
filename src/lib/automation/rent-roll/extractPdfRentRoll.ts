import { extractPdfText } from "@/lib/extraction/pdfTextExtractor";

export interface PdfRentRollUnit {
  unit: string;
  unitType: string;
  sqft: number | string | null;
  residentName: string;
  marketRent: number | null;
  chargeCode: string;
  rentAmount: number;
}

export interface PdfRentRollExtractionResult {
  propertyName: string;
  asOfDate: string;
  units: PdfRentRollUnit[];
  warnings: string[];
  pageCount: number;
}

interface ParsedUnit {
  unit: string;
  unitType: string;
  sqft: number | string | null;
  residentCode: string;
  residentName: string;
  marketRent: number | null;
  chargeCode: string;
  rentAmount: number;
}

function parseMoney(value: string): number | null {
  let cleaned = value
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/\*/g, "")
    .trim();

  if (!cleaned) {
    return null;
  }

  if (
    cleaned.startsWith("(") &&
    cleaned.endsWith(")")
  ) {
    cleaned = `-${cleaned.slice(1, -1)}`;
  }

  const parsed = Number(cleaned);

  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeChargeCodes(
  values: string[]
): Set<string> {
  return new Set(
    values
      .flatMap((value) => value.split(","))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function cleanLines(page: string): string[] {
  return page
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/* ============================================================
 * YARDI HELPERS
 * ============================================================
 */

function isIgnoredLine(line: string): boolean {
  const lower = line.toLowerCase();

  if (/^page\s+\d+\s+of\s+\d+$/i.test(line)) {
    return true;
  }

  if (lower === "rent roll with lease charges") {
    return true;
  }

  if (/^as of\s*=/i.test(line)) {
    return true;
  }

  if (/^month year\s*=/i.test(line)) {
    return true;
  }

  if (
    lower.includes("unit type") &&
    lower.includes("resident") &&
    lower.includes("market")
  ) {
    return true;
  }

  if (
    lower === "sq ft" ||
    lower.includes("rent code") ||
    lower.includes("deposit expiration")
  ) {
    return true;
  }

  return false;
}

function detectMetadata(pages: string[]): {
  propertyName: string;
  asOfDate: string;
} {
  const firstPages = pages.slice(0, 3).join("\n");

  const asOfMatch = firstPages.match(
    /As Of\s*=\s*(\d{1,2}\/\d{1,2}\/\d{4})/i
  );

  const propertyMatch = firstPages.match(
    /Rent Roll with Lease Charges\s*\n\s*([^\n]+?)\s*\n\s*As Of\s*=/i
  );

  let propertyName = "";

  if (propertyMatch) {
    propertyName = propertyMatch[1]
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim();
  }

  return {
    propertyName,
    asOfDate: asOfMatch?.[1] ?? "",
  };
}

function detectOneSiteMetadata(pages: string[]): {
  propertyName: string;
  asOfDate: string;
} {
  const firstPages = pages.slice(0, 2).join("\n");

  const asOfMatch = firstPages.match(
    /As of\s+(\d{1,2}\/\d{1,2}\/\d{4})/i
  );

  const headerLine = firstPages
    .split(/\r?\n/)
    .find(
      (line) =>
        /OneSite Rents/i.test(line) &&
        /Page\s+\d+\s+of\s+\d+/i.test(line)
    );

  let propertyName = "";

  if (headerLine) {
    propertyName = headerLine
      .replace(/OneSite Rents\s+v[\d.]+/i, "")
      .replace(/Page\s+\d+\s+of\s+\d+/i, "")
      .trim();

    const pieces = propertyName.split(/\s+-\s+/);

    if (pieces.length > 1) {
      propertyName =
        pieces[pieces.length - 1].trim();
    }
  }

  return {
    propertyName,
    asOfDate: asOfMatch?.[1] ?? "",
  };
}

function parseUnitStart(line: string): {
  unit: string;
  unitType: string;
  sqft: number | string | null;
  residentCode: string;
  remainder: string;
} | null {
  const match = line.match(
    /^([A-Za-z0-9-]+)\s+(\S+)\s+([\d,]+(?:\.\d+)?)\s+(\S+)\s+(.+)$/
  );

  if (!match) {
    return null;
  }

  const [
    ,
    unit,
    unitType,
    sqftText,
    residentCode,
    remainder,
  ] = match;

  if (
    unit.toLowerCase() === "unit" ||
    unit.toLowerCase() === "total"
  ) {
    return null;
  }

  return {
    unit,
    unitType,
    sqft: parseMoney(sqftText) ?? sqftText,
    residentCode,
    remainder,
  };
}

function parseResidentAndMarketRent(
  residentCode: string,
  remainder: string
): {
  residentName: string;
  marketRent: number | null;
  trailingText: string;
} | null {
  const moneyMatch = remainder.match(
    /^(.*?)\s+(-?[\d,]+(?:\.\d+)?)\s*(.*)$/
  );

  if (!moneyMatch) {
    return null;
  }

  let residentName = moneyMatch[1].trim();

  if (
    residentCode.toUpperCase() === "VACANT" ||
    residentCode.toUpperCase() === "MODEL" ||
    residentCode.toUpperCase() === "DOWN"
  ) {
    residentName =
      residentName || residentCode.toUpperCase();
  }

  return {
    residentName,
    marketRent: parseMoney(moneyMatch[2]),
    trailingText: moneyMatch[3].trim(),
  };
}

function findChargeInText(
  text: string,
  chargeCodes: Set<string>
): {
  chargeCode: string;
  amount: number;
} | null {
  const tokens = text.split(/\s+/);

  for (
    let index = 0;
    index < tokens.length;
    index += 1
  ) {
    const normalized = tokens[index]
      .replace(/[:;,]/g, "")
      .trim()
      .toLowerCase();

    if (!chargeCodes.has(normalized)) {
      continue;
    }

    const amountToken = tokens[index + 1];

    if (!amountToken) {
      continue;
    }

    const amount = parseMoney(amountToken);

    if (amount !== null) {
      return {
        chargeCode: normalized,
        amount,
      };
    }
  }

  return null;
}

/* ============================================================
 * REPORT FAMILY 1
 * YARDI — RENT ROLL WITH LEASE CHARGES
 * ============================================================
 */

function extractLeaseChargeUnits(
  pages: string[],
  chargeCodes: Set<string>
): {
  units: ParsedUnit[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const units: ParsedUnit[] = [];
  const seenUnits = new Set<string>();

  let insideCurrentResidents = false;
  let finishedCurrentResidents = false;
  let currentUnit: ParsedUnit | null = null;

  const finishCurrentUnit = () => {
    if (!currentUnit) {
      return;
    }

    if (seenUnits.has(currentUnit.unit)) {
      currentUnit = null;
      return;
    }

    const residentUpper =
      currentUnit.residentName.toUpperCase();

    const occupied =
      currentUnit.residentName.length > 0 &&
      !residentUpper.includes("VACANT") &&
      !residentUpper.includes("MODEL") &&
      !residentUpper.includes("DOWN");

    if (occupied && !currentUnit.chargeCode) {
      warnings.push(
        `Unit ${currentUnit.unit} appears occupied but no matching rent charge code was found. Rent Amount was set to $0.`
      );
    }

    seenUnits.add(currentUnit.unit);
    units.push(currentUnit);
    currentUnit = null;
  };

  for (const page of pages) {
    if (finishedCurrentResidents) {
      break;
    }

    const pageLines = cleanLines(page);

    const normalizedPageText = pageLines
      .join(" ")
      .replace(/\s+/g, " ")
      .toLowerCase();

    if (!insideCurrentResidents) {
      if (
        normalizedPageText.includes(
          "current/notice/vacant residents"
        ) ||
        normalizedPageText.includes(
          "current / notice / vacant residents"
        )
      ) {
        insideCurrentResidents = true;
      } else {
        continue;
      }
    }

    for (
      let lineIndex = 0;
      lineIndex < pageLines.length;
      lineIndex += 1
    ) {
      const line = pageLines[lineIndex].trim();

      if (!line) {
        continue;
      }

      const lower = line.toLowerCase();

      if (
        lower.includes(
          "current/notice/vacant residents"
        ) ||
        lower.includes(
          "current / notice / vacant residents"
        )
      ) {
        insideCurrentResidents = true;
        continue;
      }

const reachedFutureResidents =
  lower.includes(
    "future residents/applicants"
  ) ||
  lower.includes(
    "future residents / applicants"
  ) ||
  (
    lower.includes("future residents") &&
    lower.includes("applicants")
  );

const reachedSummary =
  lower === "summary groups";

      if (
        reachedFutureResidents ||
        reachedSummary
      ) {
        finishCurrentUnit();
        finishedCurrentResidents = true;
        break;
      }

      if (!insideCurrentResidents) {
        continue;
      }

      if (isIgnoredLine(line)) {
        continue;
      }

      const unitStart = parseUnitStart(line);

      if (unitStart) {
        const residentInfo =
          parseResidentAndMarketRent(
            unitStart.residentCode,
            unitStart.remainder
          );

        if (!residentInfo) {
          continue;
        }

        finishCurrentUnit();

        if (seenUnits.has(unitStart.unit)) {
          continue;
        }

        currentUnit = {
          unit: unitStart.unit,
          unitType: unitStart.unitType,
          sqft: unitStart.sqft,
          residentCode:
            unitStart.residentCode,
          residentName:
            residentInfo.residentName,
          marketRent:
            residentInfo.marketRent,
          chargeCode: "",
          rentAmount: 0,
        };

        const sameLineCharge =
          findChargeInText(
            residentInfo.trailingText,
            chargeCodes
          );

        if (sameLineCharge) {
          currentUnit.chargeCode =
            sameLineCharge.chargeCode;

          currentUnit.rentAmount =
            sameLineCharge.amount;
        }

        continue;
      }

      if (
        currentUnit &&
        !currentUnit.chargeCode
      ) {
        const continuationCharge =
          findChargeInText(
            line,
            chargeCodes
          );

        if (continuationCharge) {
          currentUnit.chargeCode =
            continuationCharge.chargeCode;

          currentUnit.rentAmount =
            continuationCharge.amount;
        }
      }
    }
  }

  if (!finishedCurrentResidents) {
    finishCurrentUnit();
  }

  return {
    units,
    warnings,
  };
}

/* ============================================================
 * REPORT FAMILY 2
 * REALPAGE / ONESITE — RENT ROLL DETAIL
 * ============================================================
 */

function extractOneSiteUnits(
  pages: string[],
  chargeCodes: Set<string>
): {
  units: ParsedUnit[];
  warnings: string[];
} {
  const units: ParsedUnit[] = [];
  const warnings: string[] = [];
  const seenUnits = new Set<string>();

  // IMPORTANT: longest statuses first. `Occupied\b` also matches the
  // beginning of `Occupied-NTV`, which is what caused Oak Tree rows to be
  // treated incorrectly in the old parser.
  const currentStatusPattern =
    /^(Occupied-NTV-Leased|Occupied-NTV|Occupied|Vacant-Leased|Vacant|Admin\/Down|Down|Model)\b/i;

  // Former / Applicant rows belong to the history/application records for
  // the current physical unit. They are NOT part of the current unit's rent.
  const nonCurrentResidentPattern = /\b(?:Former|Applicant)\b/i;

  // OneSite/unpdf commonly glues the SQFT directly to the unit number:
  //   6401-301  -> sqft 640, unit 1-301
  //   5821-101  -> sqft 582, unit 1-101
  // It may also glue the resident name before that token:
  //   Wood, Jackie5821-101
  // Do not require a word boundary before the SQFT digits for that reason.
  const sqftAndUnitPattern =
    /(\d{3,5})([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)\b/;

  const invalidUnitTokens = new Set([
    "occupied-ntv-leased",
    "occupied-ntv",
    "occupied",
    "vacant-leased",
    "vacant",
    "admin-down",
    "down",
    "model",
  ]);

  const lines = pages
    .filter((page) => {
      const lowerPage = page.toLowerCase();

      return !lowerPage.includes(
        "occupancy and rents summary for current date"
      );
    })
    .flatMap((page) => cleanLines(page));

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const statusMatch = line.match(currentStatusPattern);

    if (!statusMatch) {
      continue;
    }

    const statusText = statusMatch[1];
    const status = statusText.toLowerCase();

    // Unit information can be on the status line or a few lines later when
    // the resident name wraps.
    const blockLines = [
      line,
      lines[index + 1] ?? "",
      lines[index + 2] ?? "",
      lines[index + 3] ?? "",
    ];
    const block = blockLines.join(" ");

    let unit = "";
    let unitType = "";
    let sqft: number | string | null = null;

    // PRIMARY PATH: parse the combined SQFT + physical-unit token.
    // This fixes Oak Tree and also preserves the San Juan layout.
    const sqftUnitMatch = block.match(sqftAndUnitPattern);

    if (sqftUnitMatch) {
      sqft = parseMoney(sqftUnitMatch[1]) ?? sqftUnitMatch[1];
      unit = sqftUnitMatch[2];
    } else {
      // Fallback for a OneSite variation where SQFT and unit are not glued.
      // Explicitly reject status strings so a status can never become a unit
      // identifier again.
      const candidates = [
        ...block.matchAll(/\b([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)\b/g),
      ].map((match) => match[1]);

      unit =
        candidates.find(
          (candidate) =>
            !invalidUnitTokens.has(candidate.toLowerCase())
        ) ?? "";

      if (!unit) {
        warnings.push(
          `Could not recover a physical unit number from OneSite row beginning: ${line.slice(0, 120)}`
        );
        continue;
      }

      const unitPosition = block.indexOf(unit);
      const beforeUnit = block.slice(
        Math.max(0, unitPosition - 10),
        unitPosition
      );
      const sqftMatch = beforeUnit.match(/(\d{3,5})$/);

      if (sqftMatch) {
        sqft = parseMoney(sqftMatch[1]) ?? sqftMatch[1];
      }
    }

    if (!unit || invalidUnitTokens.has(unit.toLowerCase())) {
      warnings.push(
        `Rejected invalid OneSite unit identifier "${unit || "(blank)"}".`
      );
      continue;
    }

    if (seenUnits.has(unit)) {
      warnings.push(
        `Duplicate OneSite physical unit ${unit} was encountered and ignored.`
      );
      continue;
    }

    // Recover floorplan/unit type after the physical unit number.
    // Handles both:
    //   1-301 Affordable1BD1BA
    //   1-101 N/A1BR
    const unitPosition = block.indexOf(unit);
    const afterUnit =
      unitPosition >= 0
        ? block.slice(unitPosition + unit.length)
        : "";

    const floorplanMatch = afterUnit.match(
      /(?:Affordable|N\/A)\s*([A-Za-z0-9]+(?:[A-Za-z0-9/-]*[A-Za-z0-9])?)/i
    );

    if (floorplanMatch) {
      unitType = floorplanMatch[1];
    }

    let residentName = "";
    let marketRent: number | null = null;
    let rentAmount = 0;

    if (
      status === "vacant" ||
      status === "vacant-leased"
    ) {
      residentName = "VACANT";
    } else if (
      status === "admin/down" ||
      status === "down"
    ) {
      residentName = "DOWN";
    } else if (status === "model") {
      residentName = "MODEL";
    } else {
      // Occupied and Occupied-NTV rows.
      // Capture the resident text between the final date and SQFT+unit token.
      const escapedUnit = unit.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      const residentPattern = new RegExp(
        `(?:\\d{1,2}\\/\\d{1,2}\\/\\d{4})([^0-9]*?)(?:\\d{3,5})${escapedUnit}\\b`
      );

      const residentMatch = block.match(residentPattern);

      if (residentMatch) {
        residentName = residentMatch[1]
          .replace(/\s+/g, " ")
          .trim();
      }

      // Wrapped-name fallback.
      if (!residentName) {
        const unitTokenPattern = new RegExp(
          `\\d{3,5}${escapedUnit}\\b`
        );
        const unitTokenIndex = block.search(unitTokenPattern);

        if (unitTokenIndex > 0) {
          const beforeToken = block.slice(0, unitTokenIndex);
          const lastDateMatch = [
            ...beforeToken.matchAll(
              /\d{1,2}\/\d{1,2}\/\d{4}/g
            ),
          ].pop();

          if (
            lastDateMatch &&
            lastDateMatch.index !== undefined
          ) {
            residentName = beforeToken
              .slice(
                lastDateMatch.index +
                  lastDateMatch[0].length
              )
              .replace(/\s+/g, " ")
              .trim();
          }
        }
      }
    }

    // MARKET RENT
    const residentMarketMatch = block.match(
      /RESIDENT(-?[\d,]+\.\d{2})/i
    );

    if (residentMarketMatch) {
      marketRent = parseMoney(residentMarketMatch[1]);
    } else {
      const vacantMarketMatch = line.match(
        /(-?[\d,]+\.\d{2})VACANT/i
      );

      if (vacantMarketMatch) {
        marketRent = parseMoney(vacantMarketMatch[1]);
      }
    }

    // RENT AMOUNT
    // Stop at the next physical unit OR at Former/Applicant. The old parser
    // continued through Former/Applicant rows and added their historical
    // RENT/SUBRENT amounts to the current unit.
    const matchedChargeCodes: string[] = [];
    let recordEndIndex = index + 1;

    while (recordEndIndex < lines.length) {
      const candidateLine = lines[recordEndIndex];
      const candidateLower = candidateLine.toLowerCase();

      if (
        currentStatusPattern.test(candidateLine) ||
        nonCurrentResidentPattern.test(candidateLine) ||
        candidateLower.startsWith("totals:") ||
        candidateLower.includes(
          "occupancy and rents summary for current date"
        ) ||
        candidateLower.includes(
          "summary billing by sub journal"
        ) ||
        candidateLower.includes(
          "summary billing by transaction code"
        )
      ) {
        break;
      }

      recordEndIndex += 1;
    }

    const recordLines = lines.slice(index, recordEndIndex);

    for (const rentLine of recordLines) {
      for (const candidateCode of chargeCodes) {
        const escapedCode = candidateCode.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );

        const codePattern = new RegExp(
          `\\b${escapedCode}\\b`,
          "i"
        );

        const codeMatch = codePattern.exec(rentLine);

        if (
          !codeMatch ||
          codeMatch.index === undefined
        ) {
          continue;
        }

        // Only inspect numeric values on the same extracted line as the
        // accepted charge code. In this OneSite extraction the second number
        // after the code is the Lease Rent amount for standard rows.
        const afterCode = rentLine.slice(
          codeMatch.index + codeMatch[0].length
        );

        const amounts = afterCode.match(
          /-?[\d,]+\.\d{2}/g
        );

        if (!amounts || amounts.length < 2) {
          continue;
        }

        const amount = parseMoney(amounts[1]) ?? 0;
        rentAmount += amount;

        if (!matchedChargeCodes.includes(candidateCode)) {
          matchedChargeCodes.push(candidateCode);
        }
      }
    }

    const chargeCode = matchedChargeCodes.join(", ");

    // Utility allowance rows can surface Total Billing rather than Lease Rent.
    const hasUtilityAdjustment = recordLines.some(
      (recordLine) =>
        /\b(?:UTAC|UTILREIMB)\b/i.test(recordLine)
    );

    if (
      hasUtilityAdjustment &&
      marketRent !== null &&
      rentAmount > marketRent
    ) {
      rentAmount = marketRent;
    }

    if (
      status.startsWith("occupied") &&
      !chargeCode
    ) {
      warnings.push(
        `Unit ${unit} appears occupied but no matching rent transaction code was found. Rent Amount was set to $0.`
      );
    }

    units.push({
      unit,
      unitType,
      sqft,
      residentCode: statusText,
      residentName,
      marketRent,
      chargeCode,
      rentAmount,
    });

    seenUnits.add(unit);
  }

  return {
    units,
    warnings,
  };
}

function detectOneSiteExpectedUnitCount(
  pages: string[]
): number | null {
  for (const page of pages) {
    const normalized = page
      .replace(/\s+/g, " ")
      .trim();

    // OneSite detail summary example:
    // totals / averages: 120 582 1,029.00 ...
    const match = normalized.match(
      /totals\s*\/\s*averages:\s*(\d{1,5})\b/i
    );

    if (match) {
      const parsed = Number(match[1]);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }

  return null;
}

/*
ADD THIS IMMEDIATELY AFTER extractOneSiteUnits(...) IN THE ONESITE DISPATCHER:

const expectedUnitCount =
  detectOneSiteExpectedUnitCount(extraction.pages);

if (
  expectedUnitCount !== null &&
  units.length !== expectedUnitCount
) {
  throw new Error(
    `OneSite Rent Roll validation failed: the source summary reports ${expectedUnitCount} physical units, but the parser found ${units.length}. No Clean Rent Roll was generated.`
  );
}

This makes a future 117-vs-120 problem fail loudly instead of silently creating
an incomplete workbook.
*/



/* ============================================================
 * PUBLIC PDF DISPATCHER
 * ============================================================
 */

function extractSimpleRentRollUnits(
  pages: string[]
): {
  units: ParsedUnit[];
  warnings: string[];
} {
  const units: ParsedUnit[] = [];
  const warnings: string[] = [];
  const seenUnits = new Set<string>();

  for (const page of pages) {
    const lines = cleanLines(page);

    for (const line of lines) {
      /*
       * This report family looks like:
       *
       * 1100 Autumn Circle #1
       * 3/3.50
       * Maggie K. Nguyen
       * Current
       * 1,900.00
       * 1,900.00
       * 1,200.00
       * 11/21/2025
       * 11/20/2026
       * 11/21/2025
       *
       * But unpdf may collapse those columns into one line.
       *
       * We anchor on:
       *   Unit
       *   BD/BA
       *   Tenant
       *   Status
       *   Market Rent
       *   Rent
       *   Deposit
       *   Dates
       */

      const match = line.match(
        /^(.+?#\d+(?:\s+\(Unit [^)]+\))?)\s+(?:(.*?)\s+)?(\d+\/\d+(?:\.\d+)?)\s+(.+?)\s+(Current|Vacant|Notice|Future)\s+([\d,]+\.\d{2})?\s*([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+\d{1,2}\/\d{1,2}\/\d{4}/i
      );

      if (!match) {
        continue;
      }

      const unit = match[1].trim();
      const unitType = match[3].trim();
      const residentName = match[4].trim();
      const status = match[5].trim();

      const marketRent =
        match[6]
          ? parseMoney(match[6])
          : null;

      const rentAmount =
        parseMoney(match[7]) ?? 0;

      if (seenUnits.has(unit)) {
        continue;
      }

      seenUnits.add(unit);

      units.push({
        unit,
        unitType,
        sqft: null,
        residentCode: status,
        residentName:
          /^vacant$/i.test(status)
            ? "VACANT"
            : residentName,
        marketRent,
        chargeCode: "rent",
        rentAmount,
      });
    }
  }

  return {
    units,
    warnings,
  };
}

export async function extractPdfRentRoll(
  input: Buffer,
  chargeCodeValues: string[]
): Promise<PdfRentRollExtractionResult> {
  const chargeCodes =
    normalizeChargeCodes(
      chargeCodeValues
    );

  if (chargeCodes.size === 0) {
    throw new Error(
      "Enter at least one rent charge code before processing."
    );
  }

  const extraction =
    await extractPdfText(
      new Uint8Array(input)
    );

  if (!extraction.hasSelectableText) {
    throw new Error(
      "This PDF does not contain selectable text. Scanned/image-only Rent Rolls are not supported yet."
    );
  }

  const documentText =
    extraction.pages
      .join("\n")
      .toLowerCase();

  /*
   * FAMILY 1 — YARDI
   */
  if (
    documentText.includes(
      "rent roll with lease charges"
    )
  ) {
    const metadata =
      detectMetadata(
        extraction.pages
      );

    const {
      units,
      warnings,
    } =
      extractLeaseChargeUnits(
        extraction.pages,
        chargeCodes
      );

    if (units.length === 0) {
      throw new Error(
        'No valid units were found in the PDF "Current/Notice/Vacant Residents" section.'
      );
    }

    return {
      propertyName:
        metadata.propertyName,
      asOfDate:
        metadata.asOfDate,
      pageCount:
        extraction.pageCount,
      warnings,
      units: units.map(
        (unit) => ({
          unit: unit.unit,
          unitType:
            unit.unitType,
          sqft: unit.sqft,
          residentName:
            unit.residentName,
          marketRent:
            unit.marketRent,
          chargeCode:
            unit.chargeCode,
          rentAmount:
            unit.rentAmount,
        })
      ),
    };
  }

  /*
   * FAMILY 2 — ONESITE / REALPAGE
   */
  if (
    documentText.includes("onesite rents") &&
    documentText.includes("rent roll detail")
  ) {
    const metadata =
      detectOneSiteMetadata(
        extraction.pages
      );

    /*
     * TEMPORARY DEBUG OUTPUT.
     *
     * Leave this here for the next San Juan test.
     * If parsing still returns zero units, the terminal output will
     * show us exactly how unpdf is representing the table.
     */

    const {
      units,
      warnings,
    } =
      extractOneSiteUnits(
        extraction.pages,
        chargeCodes
      );

function detectOneSiteExpectedUnitCount(
  pages: string[]
): number | null {
  for (const page of pages) {
    const normalized = page
      .replace(/\s+/g, " ")
      .trim();

    // OneSite detail summary example:
    // totals / averages: 120 582 1,029.00 ...
    const match = normalized.match(
      /totals\s*\/\s*averages:\s*(\d{1,5})\b/i
    );

    if (match) {
      const parsed = Number(match[1]);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }

  return null;
}

/*
ADD THIS IMMEDIATELY AFTER extractOneSiteUnits(...) IN THE ONESITE DISPATCHER:

const expectedUnitCount =
  detectOneSiteExpectedUnitCount(extraction.pages);

if (
  expectedUnitCount !== null &&
  units.length !== expectedUnitCount
) {
  throw new Error(
    `OneSite Rent Roll validation failed: the source summary reports ${expectedUnitCount} physical units, but the parser found ${units.length}. No Clean Rent Roll was generated.`
  );
}

This makes a future 117-vs-120 problem fail loudly instead of silently creating
an incomplete workbook.
*/



    console.log(
      `===== ONESITE PARSED UNIT COUNT: ${units.length} =====`
    );

    if (units.length === 0) {
      throw new Error(
        'No valid units were found in the OneSite "Rent Roll Detail" PDF.'
      );
    }

    return {
      propertyName:
        metadata.propertyName,
      asOfDate:
        metadata.asOfDate,
      pageCount:
        extraction.pageCount,
      warnings,
      units: units.map(
        (unit) => ({
          unit: unit.unit,
          unitType:
            unit.unitType,
          sqft: unit.sqft,
          residentName:
            unit.residentName,
          marketRent:
            unit.marketRent,
          chargeCode:
            unit.chargeCode,
          rentAmount:
            unit.rentAmount,
        })
      ),
    };
  }

  /*
   * Every possible path now either returns or throws.
   */

/*
 * Simple Rent Roll format
 *
 * Example:
 * Rent Roll
 * Exported On: 09/30/2026
 * Properties: Louisburg Landing...
 * Units: Active
 * As of: 09/30/2026
 *
 * Columns:
 * Unit / Tags / BD/BA / Tenant / Status /
 * Market Rent / Rent / Deposit / Lease dates
 */
if (
  documentText.includes("rent roll") &&
  documentText.includes("exported on:") &&
  documentText.includes("market rent") &&
  documentText.includes("deposit") &&
  documentText.includes("lease from")
) {
  const { units, warnings } =
    extractSimpleRentRollUnits(
      extraction.pages
    );

  console.log(
    `===== SIMPLE RENT ROLL PARSED UNIT COUNT: ${units.length} =====`
  );

  if (units.length === 0) {
    throw new Error(
      'No valid units were found in the simple "Rent Roll" PDF.'
    );
  }

  const firstPages =
    extraction.pages
      .slice(0, 2)
      .join("\n");

  const propertyMatch =
    firstPages.match(
      /Properties:\s*(.+)/i
    );

  const asOfMatch =
    firstPages.match(
      /As of:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i
    );

  return {
    propertyName:
      propertyMatch?.[1]?.trim() ?? "",
    asOfDate:
      asOfMatch?.[1] ?? "",
    pageCount:
      extraction.pageCount,
    units,
    warnings,
  };
}

  throw new Error(
    "This PDF Rent Roll format is not supported yet."
  );
}