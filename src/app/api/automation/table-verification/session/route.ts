/**
 * Issues short-lived, per-user access tickets after Keystone/Supabase authentication.
 * The browser uploads large files directly to the Python service, bypassing
 * Vercel request body limits. The shared HMAC secret never goes to the browser.
 *
 * IMPORTANT: If your existing Keystone API imports its Supabase helper from a
 * different path, match that import here to the existing table-verification
 * route.ts. Do NOT replace getUser() with getSession() for authorization.
 */
import { createHmac, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const responseHeaders = { "Cache-Control": "no-store" };

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return NextResponse.json({ error: "Please sign in to Keystone." }, { status: 401, headers: responseHeaders });
  }

  const backend = (process.env.KSTV_BACKEND_URL ?? "").trim().replace(/\/+$/, "");
  const secret = process.env.KSTV_SHARED_SECRET ?? "";
  if (!backend && process.env.NODE_ENV === "development") {
    // Existing development-only Next.js proxy continues to work unchanged.
    return NextResponse.json({ mode: "local" }, { headers: responseHeaders });
  }
  let url: URL;
  try { url = new URL(backend); }
  catch { return NextResponse.json({ error: "Table Verification hosting is not configured." }, { status: 503, headers: responseHeaders }); }
  if ((url.protocol !== "https:" && !(process.env.NODE_ENV === "development" && url.hostname === "127.0.0.1")) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash || secret.length < 32) {
    return NextResponse.json({ error: "Table Verification hosting is not configured securely." }, { status: 503, headers: responseHeaders });
  }

  const exp = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
  const claims = {
    v: 1,
    iss: "keystone",
    aud: "table-verification",
    sub: user.id,
    exp,
    nonce: randomBytes(16).toString("hex"),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return NextResponse.json({
    mode: "hosted",
    backend,
    ticket: `${payload}.${signature}`,
    expiresAt: exp * 1000,
  }, { headers: responseHeaders });
}

