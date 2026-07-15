"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/reports/actions";

/**
 * PRD Section 17 (Findings Lifecycle) / FR-4 (Finding Triage).
 *
 * Both actions rely on RLS (`findings.user_id = auth.uid()`), the
 * same pattern as every other mutation in this codebase — no
 * ownership check is duplicated in application code beyond checking
 * that the update actually affected a row, which is what tells us
 * whether RLS silently blocked it (wrong owner) vs. the id simply not
 * existing. Either way the user gets the same "not found" message,
 * so a non-owner can't distinguish "not yours" from "doesn't exist".
 */

export async function acknowledgeFinding(
  findingId: string
): Promise<ActionResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: "You must be logged in." };
  }

  const { data, error } = await supabase
    .from("findings")
    .update({
      status: "acknowledged",
      acknowledged_at: new Date().toISOString(),
    })
    .eq("id", findingId)
    .select("report_id")
    .single();

  if (error || !data) {
    return { success: false, error: "Finding not found." };
  }

  revalidatePath(`/dashboard/reports/${data.report_id}`);
  return { success: true };
}

export async function dismissFinding(
  findingId: string,
  reason: string
): Promise<ActionResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: "You must be logged in." };
  }

  const trimmedReason = reason.trim();
  if (trimmedReason.length < 3) {
    return {
      success: false,
      error: "Please provide a reason for dismissing this finding.",
    };
  }

  const { data, error } = await supabase
    .from("findings")
    .update({
      status: "dismissed",
      dismissed_reason: trimmedReason,
      dismissed_at: new Date().toISOString(),
    })
    .eq("id", findingId)
    .select("report_id")
    .single();

  if (error || !data) {
    return { success: false, error: "Finding not found." };
  }

  revalidatePath(`/dashboard/reports/${data.report_id}`);
  return { success: true };
}
