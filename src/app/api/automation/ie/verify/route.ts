import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runIEAIVerification } from "@/lib/automation/ai-verification/runIEVerification";
import type { AIVerificationSourceFile } from "@/lib/automation/ai-verification/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_SOURCE_FILE_SIZE = 20 * 1024 * 1024;
const MAX_FILES = 20;
const MAX_AI_SOURCE_TOTAL_SIZE = 49 * 1024 * 1024;
const MAX_WORKBOOK_SIZE = 50 * 1024 * 1024;

function sourceMimeType(file: File): string {
  if (file.type) {
    return file.type;
  }

  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (lowerName.endsWith(".xlsm")) {
    return "application/vnd.ms-excel.sheet.macroEnabled.12";
  }
  return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: "You must be signed in to run I&E AI verification." },
      { status: 401 }
    );
  }

  try {
    const formData = await request.formData();
    const uploadedSources = formData.getAll("sourceFiles");
    const keystoneWorkbook = formData.get("keystoneWorkbook");
    const propertyNameInput = formData.get("propertyName");

    if (uploadedSources.length === 0 || uploadedSources.length > MAX_FILES) {
      return NextResponse.json(
        { error: `AI verification requires between 1 and ${MAX_FILES} original I&E source files.` },
        { status: 400 }
      );
    }

    if (!(keystoneWorkbook instanceof File)) {
      return NextResponse.json({ error: "The generated Keystone I&E workbook is required." }, { status: 400 });
    }

    if (
      keystoneWorkbook.size === 0 ||
      keystoneWorkbook.size > MAX_WORKBOOK_SIZE ||
      !keystoneWorkbook.name.toLowerCase().endsWith(".xlsx")
    ) {
      return NextResponse.json({ error: "The generated Keystone I&E workbook is invalid or too large." }, { status: 400 });
    }

    const totalSourceSize = uploadedSources.reduce(
      (total, uploadedSource) =>
        total + (uploadedSource instanceof File ? uploadedSource.size : 0),
      0
    );

    if (totalSourceSize > MAX_AI_SOURCE_TOTAL_SIZE) {
      return NextResponse.json(
        {
          error:
            "AI verification supports up to 49 MB of combined I&E source files. The Keystone workbook was still processed normally.",
        },
        { status: 400 }
      );
    }

    const sourceFiles: AIVerificationSourceFile[] = [];

    for (const uploadedSource of uploadedSources) {
      if (!(uploadedSource instanceof File)) {
        return NextResponse.json({ error: "One of the original I&E source items is not a valid file." }, { status: 400 });
      }

      const lowerName = uploadedSource.name.toLowerCase();
      if (
        !lowerName.endsWith(".pdf") &&
        !lowerName.endsWith(".xlsx") &&
        !lowerName.endsWith(".xlsm")
      ) {
        return NextResponse.json({ error: `${uploadedSource.name} is not supported for AI verification.` }, { status: 400 });
      }

      if (uploadedSource.size === 0 || uploadedSource.size > MAX_SOURCE_FILE_SIZE) {
        return NextResponse.json({ error: `${uploadedSource.name} must be between 1 byte and 20 MB.` }, { status: 400 });
      }

      const bytes = await uploadedSource.arrayBuffer();
      sourceFiles.push({
        name: uploadedSource.name,
        mimeType: sourceMimeType(uploadedSource),
        bytes: new Uint8Array(bytes),
      });
    }

    const workbookBytes = await keystoneWorkbook.arrayBuffer();
    const propertyName = typeof propertyNameInput === "string" && propertyNameInput.trim()
      ? propertyNameInput.trim()
      : null;

    const result = await runIEAIVerification({
      sourceFiles,
      keystoneWorkbookBuffer: Buffer.from(workbookBytes),
      keystonePropertyName: propertyName,
    });

    return NextResponse.json(result, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("I&E AI verification endpoint failed:", error);

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
