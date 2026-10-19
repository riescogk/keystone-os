import type { createClient } from "@/lib/supabase/server";
import type { StoredFindingLike } from "@/lib/review/comparison/findingMatching";
import type { FindingConfidence, FindingStatus } from "@/lib/review/types";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Loads the previous review's findings of one confidence group, for
 * carrying triage state forward onto a re-review.
 *
 * Runs under the caller's own RLS-scoped session, so it can only ever
 * see the user's own findings. Returns [] when the report is not a
 * revision (previousReportId is null).
 *
 * THROWS on a database error, on purpose. If the previous findings
 * could not be read and the caller carried on anyway, every new
 * finding would be stored as "new" and every old one would later read
 * as "resolved" — a false claim that the user's problems were fixed.
 * A thrown error instead surfaces as a normal failed review (PRD 16:
 * no partial or misleading findings from a failed run) that the
 * existing failure handling already reports.
 */
export async function loadPriorFindings(
  supabase: SupabaseServerClient,
  previousReportId: string | null,
  confidence: FindingConfidence
): Promise<StoredFindingLike[]> {
  if (!previousReportId) {
    return [];
  }

  const { data, error } = await supabase
    .from("findings")
    .select(
      "id, category, confidence, status, description, evidence, dismissed_reason, acknowledged_at, dismissed_at"
    )
    .eq("report_id", previousReportId)
    .eq("confidence", confidence)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(
      `Could not load the previous review's findings: ${error.message}`
    );
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    category: row.category,
    confidence: row.confidence as FindingConfidence,
    status: row.status as FindingStatus,
    description: row.description,
    evidence: row.evidence,
    dismissedReason: row.dismissed_reason,
    acknowledgedAt: row.acknowledged_at,
    dismissedAt: row.dismissed_at,
  }));
}
