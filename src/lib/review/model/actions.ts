"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  claimModelReview,
  executeModelReview,
} from "@/lib/review/model/runModelReview";
import type { ActionResult } from "@/lib/reports/actions";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Starts (or retries) the optional model-based review for ONE report
 * the caller owns. Used for reports reviewed before Phase 11 and for
 * retrying a failed/unavailable run (PRD Section 22: every failure
 * gets an explicit retry path).
 *
 * - Ownership is enforced by RLS: the claim reads/updates `reports`
 *   under the caller's own session, so another user's report id simply
 *   finds no row.
 * - The claim happens synchronously (so the UI immediately sees
 *   "processing" and a double click cannot start two paid runs); the
 *   slow provider call then runs after the response via `after()`,
 *   the same mechanism the upload pipeline uses.
 */
export async function runModelReviewAction(
  reportId: string
): Promise<ActionResult> {
  if (!UUID_PATTERN.test(reportId)) {
    return { success: false, error: "Report not found." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: "You must be logged in." };
  }

  const claimed = await claimModelReview(reportId, "manual");
  if (!claimed) {
    return {
      success: false,
      error:
        "Model-based checks can't be started for this report right now. Refresh the page and check its status.",
    };
  }

  after(() => executeModelReview(reportId));

  revalidatePath(`/dashboard/reports/${reportId}`);
  return { success: true };
}
