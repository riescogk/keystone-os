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
            Source File Requirements
          </h2>

          <p className="mt-2 text-sm leading-6 text-slate-600">
            The uploaded rent roll must follow the source layout expected by
            the automation.
          </p>

          <ul className="mt-4 space-y-3 text-sm leading-5 text-slate-700">
            <li>
              <strong>File:</strong> Excel .xlsx workbook.
            </li>

            <li>
              <strong>Resident section:</strong> Must contain a
              &quot;Current/Notice/Vacant Residents&quot; marker before the
              unit data.
            </li>

            <li>
              <strong>Column A:</strong> Unit.
            </li>

            <li>
              <strong>Column B:</strong> Unit Type.
            </li>

            <li>
              <strong>Column C:</strong> Sq Ft.
            </li>

            <li>
              <strong>Column E:</strong> Resident Name.
            </li>

            <li>
              <strong>Column F:</strong> Market Rent.
            </li>

            <li>
              <strong>Column G:</strong> Charge Code.
            </li>

            <li>
              <strong>Column H:</strong> Charge Amount.
            </li>

            <li>
              <strong>Charge code:</strong> At least one supplied rent charge
              code must match the property&apos;s rent charge rows.
            </li>
          </ul>

          <div className="mt-5 border-t border-slate-200 pt-5">
            <h3 className="text-sm font-semibold text-slate-900">
              Recommended
            </h3>

            <p className="mt-2 text-sm leading-6 text-slate-600">
              Unit Type and Sq Ft should be populated for reliable unit
              category grouping. Resident names containing VACANT or MODEL are
              used to classify vacancy and model units in the summary.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}