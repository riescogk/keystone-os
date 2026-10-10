import Link from "next/link";
import IEForm from "./IEForm";

export const metadata = {
  title: "I&E Automation — Keystone OS",
};

export default function IEAutomationPage() {
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
          Income &amp; Expense Automation
        </h1>

        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Combine property financial statements into a standardized
          Veracity I&amp;E workbook.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="text-base font-semibold text-slate-900">
            Process I&amp;E
          </h2>

          <p className="mt-1 text-sm leading-6 text-slate-600">
            Upload the available financial statements for one property.
            Keystone will combine the applicable periods into one I&amp;E
            workbook.
          </p>

          <IEForm />
        </section>

        <aside className="rounded-lg border border-slate-200 bg-slate-50 p-6">
          <h2 className="text-sm font-semibold text-slate-900">
            Source File Requirements
          </h2>

          <p className="mt-2 text-sm leading-6 text-slate-600">
            Select one or more supported financial statements for the
            same property.
          </p>

          <ul className="mt-4 space-y-3 text-sm leading-5 text-slate-700">
            <li>
              <strong>Files:</strong> Excel .xlsx or .xlsm workbooks.
            </li>

            <li>
              <strong>Property:</strong> Uploaded statements must belong
              to the same property.
            </li>

            <li>
              <strong>Annual Statements:</strong> Multiple annual years
              may be combined.
            </li>

            <li>
              <strong>T12:</strong> A trailing 12-month statement may be
              included when available.
            </li>

            <li>
              <strong>Budget:</strong> A property budget may be included
              when available.
            </li>

            <li>
              <strong>Not all types are required:</strong> Keystone can
              process supported combinations such as annual-only or
              T12-only inputs.
            </li>
          </ul>

          <div className="mt-5 border-t border-slate-200 pt-5">
            <h3 className="text-sm font-semibold text-slate-900">
              Internal Number Mapping
            </h3>

            <p className="mt-2 text-sm leading-6 text-slate-600">
              Keystone automatically applies the Veracity internal-number
              mapping. You do not need to upload the mapping workbook.
            </p>
          </div>

          <div className="mt-5 border-t border-slate-200 pt-5">
            <h3 className="text-sm font-semibold text-slate-900">
              Output
            </h3>

            <p className="mt-2 text-sm leading-6 text-slate-600">
              The resulting workbook contains the standardized Combined
              I&amp;E. Uploaded files and generated automation outputs are
              processed on demand and are not added to your Keystone report
              history.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}