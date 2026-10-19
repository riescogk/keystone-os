/**
 * Whether a new upload may be recorded as a revised draft of an
 * existing report (PRD FR-5). Pure, so the exact same rule runs in the
 * upload page (to explain a problem before the user picks a file) and
 * in the upload Server Action (which is the one that enforces it).
 *
 * Ownership is not re-checked here: callers look the report up under
 * the user's own RLS-scoped session, so a report that is not theirs
 * arrives as `null` and is indistinguishable from one that does not
 * exist. (A database trigger enforces the same owner rule as a final
 * backstop — migration 0012.)
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RevisionTarget {
  review_status: string;
  extraction_status: string;
}

export type RevisionCheck =
  { ok: true; previousReportId: string | null } | { ok: false; error: string };

export function checkRevisionTarget(input: {
  /** Raw value of the "revises" request field; empty means a normal new upload. */
  revisesReportId: string | null | undefined;
  /** The report found under the caller's own session, or null. */
  target: RevisionTarget | null;
  /** True when some report already has this one as its previous draft. */
  alreadyRevised: boolean;
}): RevisionCheck {
  const raw = input.revisesReportId?.trim();
  if (!raw) {
    return { ok: true, previousReportId: null };
  }

  if (!UUID_PATTERN.test(raw) || !input.target) {
    return {
      ok: false,
      error: "The report you are revising could not be found.",
    };
  }

  if (
    input.target.extraction_status !== "completed" ||
    input.target.review_status !== "complete"
  ) {
    return {
      ok: false,
      error:
        "A revised draft can only be uploaded after the earlier report's review has finished.",
    };
  }

  if (input.alreadyRevised) {
    return {
      ok: false,
      error:
        "A revised draft of this report has already been uploaded. Upload your newest revision from the latest draft instead.",
    };
  }

  return { ok: true, previousReportId: raw };
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
