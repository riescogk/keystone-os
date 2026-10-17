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

  /*
   * OneSite / unpdf reads the report horizontally in reverse-ish
   * column order.
   *
   * Actual extracted occupied row:
   *
   * Occupied RENT 215.00...RESIDENT1,199.00...
   * Cook, James6401-301 Affordable1BD1BA ...
   *
   * Actual extracted vacant row:
   *
   * Vacant 0.000.001,199.00VACANT6401-222 Affordable1BD1BA ...
   *
   * Therefore we detect the unit INSIDE the extracted line rather
   * than expecting the line to begin with the unit number.
   */

  const unitInsideLinePattern =
    /640(\d+-\d+)\s+(Affordable|N\/A)(1BD1BA)\b/i;

  /*
   * More generic fallback in case another OneSite property has
   * different SQFT / designation / floorplan values.
   *
   * We use the known status at the beginning of the line to avoid
   * accidentally treating Former / Applicant rows as physical units.
   */
  const genericUnitPattern =
    /([A-Za-z0-9-]+)\s+([A-Za-z0-9/ -]+?)([A-Za-z0-9-]+)\s+(?:-?\(?[\d,.]+\)?)/;

  for (const page of pages) {
    const lowerPage = page.toLowerCase();

    /*
     * Page 8 is summary data, not physical unit detail.
     */
    if (
      lowerPage.includes(
        "occupancy and rents summary for current date"
      )
    ) {
      continue;
    }

    const lines = cleanLines(page);

    for (
      let index = 0;
      index < lines.length;
      index += 1
    ) {
      const line = lines[index];

      /*
       * Only current physical-unit records begin with one of these.
       *
       * This automatically excludes:
       * Former
       * *Former
       * Applicant
       */
      const statusMatch = line.match(
        /^(Occupied|Vacant-Leased|Vacant|Admin\/Down|Down|Model)\b/i
      );

      if (!statusMatch) {
        continue;
      }

      const statusText = statusMatch[1];
      const status = statusText.toLowerCase();

      /*
       * The unit information can be on this line OR, when a resident
       * name wraps, one or two lines later.
       *
       * Example:
       *
       * Occupied RENT ... Archuleta,
       * Joseph
       * 6401-303 Affordable1BD1BA ...
       */
      const blockLines = [
        line,
        lines[index + 1] ?? "",
        lines[index + 2] ?? "",
        lines[index + 3] ?? "",
      ];

      const block = blockLines.join(" ");

      /*
       * First handle the exact structure shown by San Juan:
       *
       * 6401-301 Affordable1BD1BA
       *
       * where:
       * 640      = SQFT
       * 1-301    = Unit
       * Affordable = Unit Designation
       * 1BD1BA   = Floorplan
       */
      let unit = "";
      let unitType = "";
      let sqft: number | string | null = null;

      const sanJuanMatch =
        block.match(unitInsideLinePattern);

      if (sanJuanMatch) {
        unit = sanJuanMatch[1];
        unitType = sanJuanMatch[3];
        sqft = 640;
      } else {
        /*
         * Generic OneSite fallback:
         *
         * Look for a unit identifier such as 1-301 somewhere inside
         * the current physical-unit block.
         */
        const unitMatch =
          block.match(/\b(\d+-\d+)\b/);

        if (!unitMatch) {
          continue;
        }

        unit = unitMatch[1];

        /*
         * Try to recover SQFT from the digits immediately before the
         * unit number.
         *
         * Example:
         * 6401-301
         *
         * => sqft 640
         * => unit 1-301
         */
        const unitPosition =
          block.indexOf(unit);

        const beforeUnit =
          block.slice(
            Math.max(0, unitPosition - 8),
            unitPosition
          );

        const sqftMatch =
          beforeUnit.match(/(\d{3,5})$/);

        if (sqftMatch) {
          sqft =
            parseMoney(sqftMatch[1]) ??
            sqftMatch[1];
        }

        /*
         * Recover the floorplan after the designation.
         *
         * This is a fallback only. San Juan uses the exact parser
         * above.
         */
        const afterUnit =
          block.slice(
            unitPosition + unit.length
          );

        const floorplanMatch =
          afterUnit.match(
            /\s+(?:Affordable|N\/A)\s*([A-Za-z0-9-]+)/i
          );

        if (floorplanMatch) {
          unitType =
            floorplanMatch[1];
        }
      }

      if (!unit) {
        continue;
      }

      if (seenUnits.has(unit)) {
        continue;
      }

      let residentName = "";
      let marketRent: number | null = null;
      let chargeCode = "";
      let rentAmount = 0;

      /*
       * ========================================================
       * RESIDENT / STATUS
       * ========================================================
       */
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
      } else if (
        status === "model"
      ) {
        residentName = "MODEL";
      } else {
        /*
         * In the extracted OneSite text, the resident name appears
         * immediately before:
         *
         * 6401-301
         *
         * Example:
         * ...03/20/2018Cook, James6401-301...
         *
         * Capture text between the final date and the SQFT+Unit token.
         */
        const residentPattern =
          /(?:\d{1,2}\/\d{1,2}\/\d{4})([^0-9]*?)(?:\d{3,5})(?:\d+-\d+)/;

        const residentMatch =
          block.match(residentPattern);

        if (residentMatch) {
          residentName =
            residentMatch[1]
              .replace(/\s+/g, " ")
              .trim();
        }

        /*
         * Wrapped names sometimes look like:
         *
         * ...Archuleta,
         * Joseph
         * 6401-303...
         *
         * If the first attempt failed, take the text immediately
         * preceding the sqft/unit token.
         */
        if (!residentName) {
          const unitTokenIndex =
            block.search(
              new RegExp(
                `\\d{3,5}${unit.replace(
                  /[-/\\^$*+?.()|[\]{}]/g,
                  "\\$&"
                )}`
              )
            );

          if (unitTokenIndex > 0) {
            const beforeToken =
              block.slice(0, unitTokenIndex);

            const lastDateMatch = [
              ...beforeToken.matchAll(
                /\d{1,2}\/\d{1,2}\/\d{4}/g
              ),
            ].pop();

            if (
              lastDateMatch &&
              lastDateMatch.index !== undefined
            ) {
              residentName =
                beforeToken
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

      /*
       * ========================================================
       * MARKET RENT
       * ========================================================
       *
       * San Juan extraction:
       *
       * RESIDENT1,199.00
       *
       * or for vacant:
       *
       * 1,199.00VACANT
       */
      const residentMarketMatch =
        block.match(
          /RESIDENT(-?[\d,]+\.\d{2})/i
        );

      if (residentMarketMatch) {
        marketRent =
          parseMoney(
            residentMarketMatch[1]
          );
      } else {
        const vacantMarketMatch =
          block.match(
            /(-?[\d,]+\.\d{2})VACANT/i
          );

        if (vacantMarketMatch) {
          marketRent =
            parseMoney(
              vacantMarketMatch[1]
            );
        }
      }

      /*
       * ========================================================
       * RENT AMOUNT
       * ========================================================
       *
       * Actual extraction:
       *
       * Occupied RENT 215.00...
       *
       * We explicitly inspect the transaction code immediately
       * following the status.
       *
       * Exact matching means RENT != SUBRENT.
       */
  const chargePattern =
  /^(?:Occupied|Vacant-Leased|Vacant|Admin\/Down|Down|Model)\s+([A-Za-z0-9_-]+)\s+(-?[\d,]+\.\d{2})(?=[\d,(]|$)/i;

const chargeMatch =
  line.match(chargePattern);

if (chargeMatch) {
  const candidateCode =
    chargeMatch[1]
      .trim()
      .toLowerCase();

  if (chargeCodes.has(candidateCode)) {
    chargeCode = candidateCode;

    /*
     * IMPORTANT:
     *
     * unpdf reverses the numeric columns in this OneSite report.
     *
     * Example source row:
     *
     * RENT 280.00 ... Deposit 215.00
     *
     * becomes:
     *
     * Occupied RENT 215.00280.000.00280.00...
     *
     * Therefore:
     * first value  = deposit/balance-side value
     * second value = actual RENT / Lease Rent
     */

    const afterCode =
      line.slice(
        line
          .toLowerCase()
          .indexOf(candidateCode) +
          candidateCode.length
      );

    const amounts =
      afterCode.match(
        /-?[\d,]+\.\d{2}/g
      );

    if (
      amounts &&
      amounts.length >= 2
    ) {
      rentAmount =
        parseMoney(amounts[1]) ?? 0;
    }
  }
}

      if (
        status === "occupied" &&
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
  }

  return {
    units,
    warnings,
  };
}

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