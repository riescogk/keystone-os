import type { SupabaseClient } from "@supabase/supabase-js";
import { REPORTS_BUCKET } from "@/lib/reports/validation";

/** Storage API page size for listing the user's folder. */
export const LIST_PAGE_SIZE = 100;

/** Upper bound on remove/list rounds: 100 files x 100 rounds = 10,000 reports. */
export const MAX_REMOVE_ROUNDS = 100;

/**
 * Removes every Storage object under the caller's own folder
 * (`{user_id}/`), through the Storage API under the caller's own
 * session — so the existing "Users can delete their own report
 * objects" RLS policy is what authorizes it, not elevated privileges.
 *
 * Driven by listing the folder (not by the reports table) so that
 * objects with no matching row — e.g. left behind by an earlier
 * partial failure — are removed too. Safe to call repeatedly.
 *
 * Returns true only when the folder was confirmed empty. Returns
 * false on any error, on a removal that confirmed fewer objects than
 * requested (which would otherwise loop forever), or when the round
 * limit is exhausted.
 */
export async function removeAllUserFiles(
  supabase: SupabaseClient,
  userId: string
): Promise<boolean> {
  const bucket = supabase.storage.from(REPORTS_BUCKET);

  for (let round = 0; round < MAX_REMOVE_ROUNDS; round++) {
    const { data: files, error: listError } = await bucket.list(userId, {
      limit: LIST_PAGE_SIZE,
    });

    if (listError) {
      console.error("[account-deletion] Listing files failed:", listError);
      return false;
    }

    if (!files || files.length === 0) {
      return true;
    }

    const paths = files.map((file) => `${userId}/${file.name}`);
    const { data: removed, error: removeError } = await bucket.remove(paths);

    if (removeError) {
      console.error("[account-deletion] Removing files failed:", removeError);
      return false;
    }

    // remove() reports only the objects it actually deleted. If it
    // deleted fewer than requested (e.g. a policy silently skipped
    // some), looping again would never make progress — fail instead
    // of spinning or pretending.
    if (!removed || removed.length < paths.length) {
      console.error(
        `[account-deletion] Requested removal of ${paths.length} files, confirmed ${removed?.length ?? 0}.`
      );
      return false;
    }
  }

  console.error("[account-deletion] Exceeded maximum removal rounds.");
  return false;
}
