import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runRentRollAIVerification } from "@/lib/automation/ai-verification/runRentRollVerification";
import type { AIVerificationSourceFile } from "@/lib/automation/ai-verification/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_SOURCE_FILE_SIZE = 20 * 1024 * 1024;
const MAX_WORKBOOK_SIZE = 50 * 1024 * 1024;

function sourceMimeType(file: File): string {
  if (file.type) {
    return file.type;
  }

  return file.name.toLowerCase().endsWith(".pdf")
    ? "application/pdf"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: "You must be signed in to run Rent Roll AI verification." },
      { status: 401 }
    );
  }

  try {
    const formData = await request.formData();
    const sourceFile = formData.get("sourceFile");
    const keystoneWorkbook = formData.get("keystoneWorkbook");
    const chargeCodeInput = formData.get("chargeCodes");

    if (!(sourceFile instanceof File)) {
      return NextResponse.json({ error: "The original Rent Roll source file is required." }, { status: 400 });
    }

    if (!(keystoneWorkbook instanceof File)) {
      return NextResponse.json({ error: "The generated Keystone workbook is required." }, { status: 400 });
    }

    const lowerSourceName = sourceFile.name.toLowerCase();
    if (!lowerSourceName.endsWith(".pdf") && !lowerSourceName.endsWith(".xlsx")) {
      return NextResponse.json({ error: "AI verification supports Rent Roll .pdf and .xlsx source files." }, { status: 400 });
    }

    if (sourceFile.size === 0 || sourceFile.size > MAX_SOURCE_FILE_SIZE) {
      return NextResponse.json({ error: "The Rent Roll source file must be between 1 byte and 20 MB." }, { status: 400 });
    }

    if (
      keystoneWorkbook.size === 0 ||
      keystoneWorkbook.size > MAX_WORKBOOK_SIZE ||
      !keystoneWorkbook.name.toLowerCase().endsWith(".xlsx")
    ) {
      return NextResponse.json({ error: "The generated Keystone workbook is invalid or too large." }, { status: 400 });
    }

    const chargeCodes = typeof chargeCodeInput === "string"
      ? chargeCodeInput.split(",").map((value) => value.trim()).filter(Boolean)
      : [];

    if (chargeCodes.length === 0) {
      return NextResponse.json({ error: "At least one rent charge code is required for AI verification." }, { status: 400 });
    }

    const [sourceBytes, workbookBytes] = await Promise.all([
      sourceFile.arrayBuffer(),
      keystoneWorkbook.arrayBuffer(),
    ]);

    const source: AIVerificationSourceFile = {
      name: sourceFile.name,
      mimeType: sourceMimeType(sourceFile),
      bytes: new Uint8Array(sourceBytes),
    };

    const result = await runRentRollAIVerification({
      sourceFile: source,
      keystoneWorkbookBuffer: Buffer.from(workbookBytes),
      chargeCodes,
    });

    return NextResponse.json(result, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Rent Roll AI verification endpoint failed:", error);

    return NextResponse.json(
      {
        status: "failed",
        provider: null,
        failureReason: "provider_error",
        message:
          error instanceof Error
            ? error.message
            : "AI verification could not be completed.",
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
