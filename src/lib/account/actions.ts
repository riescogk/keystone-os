"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { DELETE_ACCOUNT_CONFIRMATION } from "@/lib/account/constants";
import { removeAllUserFiles } from "@/lib/account/removeUserFiles";
import type { ActionResult } from "@/lib/reports/actions";

const NOT_DELETED_MESSAGE =
  "Your account was NOT deleted. Some uploaded files may already have been removed, but your account and remaining data are intact. Please try again.";

/**
 * Permanently deletes the CALLER'S OWN account and all associated
 * data (PRD Section 8.9, FR-7).
 *
 * Security properties:
 * - The target is always the verified session user. This action takes
 *   no user id; the only inputs are the confirmation phrase.
 * - No service-role key is used. File removal runs under the caller's
 *   own RLS-scoped session; the account itself is deleted by the
 *   `delete_own_account()` database function (migration 0010), which
 *   can only ever delete `auth.uid()`.
 * - The confirmation phrase is re-checked here, server-side.
 *
 * Order and failure behavior:
 * 1. Remove all stored files (idempotent — safe to retry).
 * 2. Delete the account via RPC; the database refuses if any file
 *    still exists, and cascades remove profile, reports and findings.
 * 3. End the session.
 * A failure at step 1 or 2 returns an explicit error and the account
 * still exists, so the user can simply retry. Deletion is never
 * reported as successful unless the RPC succeeded.
 */
export async function deleteAccount(
  confirmation: string
): Promise<ActionResult> {
  if (confirmation !== DELETE_ACCOUNT_CONFIRMATION) {
    return {
      success: false,
      error: `Type ${DELETE_ACCOUNT_CONFIRMATION} exactly to confirm.`,
    };
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: "You must be logged in." };
  }

  const filesRemoved = await removeAllUserFiles(supabase, user.id);
  if (!filesRemoved) {
    return { success: false, error: NOT_DELETED_MESSAGE };
  }

  const { error: deleteError } = await supabase.rpc("delete_own_account");
  if (deleteError) {
    console.error("[account-deletion] delete_own_account failed:", deleteError);
    return { success: false, error: NOT_DELETED_MESSAGE };
  }

  // The account no longer exists. Clear the now-meaningless session
  // cookies. The server rejects the old token regardless, so a failure
  // here (e.g. the logout endpoint no longer recognizes the user) must
  // not turn a completed deletion into a reported failure.
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch (error) {
    console.error("[account-deletion] Post-deletion sign-out failed:", error);
  }

  revalidatePath("/", "layout");
  return { success: true };
}
