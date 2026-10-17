import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  buildPdfRentRollWorkbook,
  processRentRoll,
} from "@/lib/automation/rent-roll/processRentRoll";
import { extractPdfRentRoll } from "@/lib/automation/rent-roll/extractPdfRentRoll";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 20 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    // API routes do not inherit the dashboard layout's authentication check,
    // so authenticate the request here as well.
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: "You must be signed in to process a rent roll." },
        { status: 401 }
      );
    }

    const formData = await request.formData();

    const file = formData.get("file");
    const chargeCodeInput = formData.get("chargeCodes");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Select a Rent Roll workbook to process." },
        { status: 400 }
      );
    }

    const lowerFilename = file.name.toLowerCase();

const isExcel = lowerFilename.endsWith(".xlsx");
const isPdf = lowerFilename.endsWith(".pdf");

if (!isExcel && !isPdf) {
  return NextResponse.json(
    { error: "The Rent Roll must be a PDF or Excel .xlsx file." },
    { status: 400 }
  );
}

    if (file.size === 0) {
      return NextResponse.json(
        { error: "The uploaded file is empty." },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "The Rent Roll file must be 20 MB or smaller." },
        { status: 400 }
      );
    }

    if (
      typeof chargeCodeInput !== "string" ||
      chargeCodeInput.trim().length === 0
    ) {
      return NextResponse.json(
        { error: "Enter at least one rent charge code." },
        { status: 400 }
      );
    }

    const chargeCodes = chargeCodeInput
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (chargeCodes.length === 0) {
      return NextResponse.json(
        { error: "Enter at least one rent charge code." },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
const inputBuffer = Buffer.from(arrayBuffer);

/*
 * PDF support is intentionally separate from the existing Excel path.
 * For now, this endpoint exposes the extracted PDF data as JSON so we
 * can verify extraction before connecting it to the Excel output builder.
 */
if (isPdf) {
  const extraction = await extractPdfRentRoll(
    inputBuffer,
    chargeCodes
  );

  const result = await buildPdfRentRollWorkbook({
    originalFilename: file.name,
    propertyName: extraction.propertyName,
    asOfDate: extraction.asOfDate,
    pageCount: extraction.pageCount,
    units: extraction.units,
    warnings: extraction.warnings,
  });

  const encodedWarnings = encodeURIComponent(
    JSON.stringify(result.warnings)
  );

  const safeFilename = result.outputFilename.replace(/"/g, "");

  return new Response(new Uint8Array(result.buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
      "X-Rent-Roll-Unit-Count": String(result.unitCount),
      "X-Rent-Roll-Warnings": encodedWarnings,
      "Cache-Control": "no-store",
    },
  });
}

/*
 * Existing Excel workflow remains unchanged.
 */
const result = await processRentRoll(inputBuffer, file.name, {
  chargeCodes,
});

    const encodedWarnings = encodeURIComponent(
      JSON.stringify(result.warnings)
    );

    const safeFilename = result.outputFilename.replace(/"/g, "");

    return new Response(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${safeFilename}"`,
        "X-Rent-Roll-Unit-Count": String(result.unitCount),
        "X-Rent-Roll-Warnings": encodedWarnings,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Rent Roll processing failed:", error);

    const message =
      error instanceof Error
        ? error.message
        : "The Rent Roll could not be processed.";

    return NextResponse.json(
      { error: message },
      { status: 400 }
    );
  }
}