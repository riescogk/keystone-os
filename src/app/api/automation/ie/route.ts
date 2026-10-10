import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  processIE,
  type IEInputFile,
} from "@/lib/automation/ie/processIE";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_FILES = 20;

export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        {
          error: "You must be signed in to process I&E files.",
        },
        { status: 401 }
      );
    }

    const formData = await request.formData();
    const uploadedFiles = formData.getAll("files");

    if (uploadedFiles.length === 0) {
      return NextResponse.json(
        {
          error: "Select at least one I&E workbook to process.",
        },
        { status: 400 }
      );
    }

    if (uploadedFiles.length > MAX_FILES) {
      return NextResponse.json(
        {
          error: `A maximum of ${MAX_FILES} I&E workbooks can be processed at once.`,
        },
        { status: 400 }
      );
    }

    const files: IEInputFile[] = [];

    for (const uploadedFile of uploadedFiles) {
      if (!(uploadedFile instanceof File)) {
        return NextResponse.json(
          {
            error: "One of the uploaded items is not a valid file.",
          },
          { status: 400 }
        );
      }

      const lowerName = uploadedFile.name.toLowerCase();

      if (
        !lowerName.endsWith(".xlsx") &&
        !lowerName.endsWith(".xlsm")
      ) {
        return NextResponse.json(
          {
            error: `${uploadedFile.name} is not a supported Excel workbook. Use .xlsx or .xlsm files.`,
          },
          { status: 400 }
        );
      }

      if (uploadedFile.size === 0) {
        return NextResponse.json(
          {
            error: `${uploadedFile.name} is empty.`,
          },
          { status: 400 }
        );
      }

      if (uploadedFile.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          {
            error: `${uploadedFile.name} exceeds the 20 MB file-size limit.`,
          },
          { status: 400 }
        );
      }

      const arrayBuffer = await uploadedFile.arrayBuffer();

      files.push({
        name: uploadedFile.name,
        buffer: Buffer.from(arrayBuffer),
      });
    }

    const result = await processIE(files);

    const safeFilename = result.outputFilename.replace(/"/g, "");
    const encodedWarnings = encodeURIComponent(
      JSON.stringify(result.warnings)
    );

    return new Response(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${safeFilename}"`,
        "X-IE-Property": encodeURIComponent(result.propertyName),
        "X-IE-Row-Count": String(result.rowCount),
        "X-IE-Warnings": encodedWarnings,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("I&E processing failed:", error);

    const message =
      error instanceof Error
        ? error.message
        : "The I&E files could not be processed.";

    return NextResponse.json(
      {
        error: message,
      },
      { status: 400 }
    );
  }
}