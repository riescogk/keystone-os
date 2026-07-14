import { UploadForm } from "@/app/(dashboard)/dashboard/new/UploadForm";

export const metadata = {
  title: "New Review — Keystone OS",
};

/**
 * PRD Section 8.3 — Phase 3 scope: file upload only. No review is
 * started yet (no Processing screen, no findings) — this page's job
 * ends at "the file is safely uploaded and recorded."
 */
export default function NewReviewPage() {
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-lg font-semibold text-slate-900">New Review</h1>
      <p className="mt-1 text-sm text-slate-600">
        Upload a finished PDF report. PDF only, up to 25 MB.
      </p>
      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
        <UploadForm />
      </div>
    </div>
  );
}
