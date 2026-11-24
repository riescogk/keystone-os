
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const PYTHON_URL = "http://127.0.0.1:8766";
const MAX_UPLOAD_SIZE = 200 * 1024 * 1024;

const DOWNLOAD_FORMATS = [
  "html",
  "json",
  "csv",
  "tables.csv",
  "cells.csv",
];

async function isAuthenticated() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  return !error && !!user;
}

function developmentOnly() {
  return process.env.NODE_ENV === "development";
}

export async function POST(request: Request) {
  if (!developmentOnly()) {
    return NextResponse.json(
      { error: "Table Verification is not enabled." },
      { status: 404 }
    );
  }

  if (!(await isAuthenticated())) {
    return NextResponse.json(
      { error: "You must be signed in." },
      { status: 401 }
    );
  }

  try {
    const formData = await request.formData();
    const word = formData.get("word");
    const excel = formData.get("excel");

    if (!(word instanceof File) || !(excel instanceof File)) {
      return NextResponse.json(
        { error: "Select both a Word document and an Excel workbook." },
        { status: 400 }
      );
    }

    if (
      !/\.(doc|docx)$/i.test(word.name) ||
      !/\.(xlsx|xlsm)$/i.test(excel.name)
    ) {
      return NextResponse.json(
        { error: "Unsupported file format." },
        { status: 400 }
      );
    }

    if (
      word.size === 0 ||
      excel.size === 0 ||
      word.size + excel.size > MAX_UPLOAD_SIZE
    ) {
      return NextResponse.json(
        { error: "Files are empty or exceed the upload limit." },
        { status: 413 }
      );
    }

    const upload = new FormData();
    upload.append("word", word);
    upload.append("excel", excel);

    const response = await fetch(
      `${PYTHON_URL}/api/table-verification/run`,
      {
        method: "POST",
        body: upload,
        cache: "no-store",
      }
    );

    const result = await response.text();

    return new NextResponse(result, {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Table Verification connection error:", error);

    return NextResponse.json(
      { error: "Cannot connect to the local Table Verification engine." },
      { status: 502 }
    );
  }
}

export async function GET(request: Request) {
  if (!developmentOnly()) {
    return NextResponse.json(
      { error: "Table Verification is not enabled." },
      { status: 404 }
    );
  }

  if (!(await isAuthenticated())) {
    return NextResponse.json(
      { error: "You must be signed in." },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");
  const job = searchParams.get("job") ?? "";

  if (!/^[a-f0-9]{12}$/.test(job)) {
    return NextResponse.json(
      { error: "Invalid verification job." },
      { status: 400 }
    );
  }

  try {
    if (action === "status") {
      const response = await fetch(
        `${PYTHON_URL}/api/table-verification/status?job=${job}`,
        { cache: "no-store" }
      );

      return new NextResponse(await response.text(), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "download") {
      const format = searchParams.get("format") ?? "";

      if (!DOWNLOAD_FORMATS.includes(format)) {
        return NextResponse.json(
          { error: "Invalid report format." },
          { status: 400 }
        );
      }

      const response = await fetch(
        `${PYTHON_URL}/api/table-verification/download/${job}.${format}`,
        { cache: "no-store" }
      );

      if (!response.ok) {
        return NextResponse.json(
          { error: "Report unavailable." },
          { status: response.status }
        );
      }

      return new NextResponse(await response.arrayBuffer(), {
        status: 200,
        headers: {
          "Content-Type":
            response.headers.get("content-type") ??
            "application/octet-stream",
          "Content-Disposition":
            `attachment; filename="table-verification.${format}"`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json(
      { error: "Invalid action." },
      { status: 400 }
    );
  } catch (error) {
    console.error("Table Verification connection error:", error);

    return NextResponse.json(
      { error: "Cannot connect to the local Table Verification engine." },
      { status: 502 }
    );
  }
}
