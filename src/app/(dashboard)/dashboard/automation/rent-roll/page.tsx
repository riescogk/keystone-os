import Link from "next/link";
import RentRollForm from "./RentRollForm";

export const metadata = {
  title: "Rent Roll Automation — Keystone OS",
};

export default function RentRollAutomationPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/dashboard/automation"
          className="text-sm font-medium text-slate-500 hover:text-slate-900"
        >
          ← I&amp;E / Rent Roll Automation
        </Link>
        <h1 className="mt-4 text-lg font-semibold text-slate-900">
          Rent Roll Automation
        </h1>

        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Upload a property rent roll to generate a standardized clean rent
          roll with unit categories and a summary worksheet.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="text-base font-semibold text-slate-900">
            Process Rent Roll
          </h2>

          <p className="mt-1 text-sm text-slate-600">
            The workbook is processed on demand and is not added to your
            Keystone report history.
          </p>

          <RentRollForm />
        </section>
        <aside className="rounded-lg border border-slate-200 bg-slate-50 p-6">
          <h2 className="text-sm font-semibold text-slate-900">
            What you can upload
          </h2>

          <div className="mt-4 space-y-4 text-sm leading-6 text-slate-600">
            <div>
              <p className="font-medium text-slate-900">Accepted files</p>
              <p>PDF or Excel (.xlsx), up to 20 MB.</p>
            </div>

            <div>
              <p className="font-medium text-slate-900">Rent data</p>
              <p>
                Include unit-level rent roll information such as unit, rent
                amount, and occupancy or resident information.
              </p>
            </div>

            <div>
              <p className="font-medium text-slate-900">Excel files</p>
              <p>
                Keystone supports the standard Rent Roll layouts currently
                configured in the system. Charge-code based files should
                include the applicable rent charge codes.
              </p>
            </div>

            <div>
              <p className="font-medium text-slate-900">PDF files</p>
              <p>
                Text-based rent roll PDFs are supported. Scanned or image-only
                PDFs may need to be converted to Excel before processing.
              </p>
            </div>
          </div>

          <div className="mt-5 border-t border-slate-200 pt-5">
            <h3 className="text-sm font-semibold text-slate-900">
              For best results
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Include Unit Type and Sq Ft when available. Resident names
              containing VACANT or MODEL may be used to classify vacancy and
              model units in the summary.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
