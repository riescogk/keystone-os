import Link from "next/link";
import type { ComparisonResult } from "@/lib/review/comparison/buildComparison";

interface ComparisonSummaryProps {
  reportId: string;
  previousReportId: string;
  previousFileName: string;
  previousReviewedAt: string | null;
  comparison: ComparisonResult;
  view: "all" | "changes";
  hiddenUnchangedCount: number;
}

/**
 * PRD Section 8.7 (Review History Comparison), integrated into the
 * findings report as the PRD allows. Shows the three counts the PRD
 * names, the "All findings" / "Changes only" toggle, and any honesty
 * notes (e.g. model-based findings not compared) next to the numbers
 * so they can't be missed. The toggle is a plain link (?view=changes),
 * so the view is shareable and needs no client JavaScript.
 */
export function ComparisonSummary({
  reportId,
  previousReportId,
  previousFileName,
  previousReviewedAt,
  comparison,
  view,
  hiddenUnchangedCount,
}: ComparisonSummaryProps) {
  const { counts, notes } = comparison;
  const tab = (active: boolean) =>
    active
      ? "rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white"
      : "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50";

  return (
    <section
      aria-labelledby="comparison-heading"
      className="flex flex-col gap-3 rounded-lg border border-blue-200 bg-blue-50/50 px-6 py-4"
    >
      <div>
        <h2
          id="comparison-heading"
          className="text-sm font-semibold text-slate-900"
        >
          Comparison with the previous draft
        </h2>
        <p className="mt-1 text-xs text-slate-600">
          Compared with{" "}
          <Link
            href={`/dashboard/reports/${previousReportId}`}
            className="underline"
          >
            {previousFileName}
          </Link>
          {previousReviewedAt
            ? `, reviewed ${new Date(previousReviewedAt).toLocaleDateString(
                undefined,
                { year: "numeric", month: "short", day: "numeric" }
              )}`
            : ""}
          . The earlier report and its findings are unchanged.
        </p>
      </div>

      <dl className="grid grid-cols-3 gap-3 text-center">
        <div className="rounded-md bg-white px-3 py-2">
          <dt className="text-xs text-slate-500">Resolved</dt>
          <dd className="text-lg font-semibold text-green-700">
            {counts.resolved}
          </dd>
        </div>
        <div className="rounded-md bg-white px-3 py-2">
          <dt className="text-xs text-slate-500">Still present</dt>
          <dd className="text-lg font-semibold text-slate-800">
            {counts.stillOpen}
          </dd>
        </div>
        <div className="rounded-md bg-white px-3 py-2">
          <dt className="text-xs text-slate-500">New</dt>
          <dd className="text-lg font-semibold text-blue-700">{counts.new}</dd>
        </div>
      </dl>

      {notes.map((note) => (
        <p
          key={note}
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
        >
          {note}
        </p>
      ))}

      <nav aria-label="Comparison view" className="flex items-center gap-2">
        <Link
          href={`/dashboard/reports/${reportId}`}
          className={tab(view === "all")}
          aria-current={view === "all" ? "page" : undefined}
        >
          All findings
        </Link>
        <Link
          href={`/dashboard/reports/${reportId}?view=changes`}
          className={tab(view === "changes")}
          aria-current={view === "changes" ? "page" : undefined}
        >
          Changes only
        </Link>
        {view === "changes" && hiddenUnchangedCount > 0 && (
          <span className="text-xs text-slate-500">
            {hiddenUnchangedCount} unchanged finding
            {hiddenUnchangedCount === 1 ? "" : "s"} hidden
          </span>
        )}
      </nav>
    </section>
  );
}
