import Link from "next/link";

export const metadata = {
  title: "I&E / Rent Roll Automation — Keystone OS",
};

export default function AutomationPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">
          I&E / Rent Roll Automation
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Process property financial statements and rent rolls into
          standardized Veracity workbooks.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="flex flex-col rounded-lg border border-slate-200 bg-white p-6">
          <div className="flex-1">
            <h2 className="text-base font-semibold text-slate-900">
              Income &amp; Expense
            </h2>

            <p className="mt-2 text-sm leading-6 text-slate-600">
              Combine Annual Statements, T12 reports, year-end statements,
              and budgets into a standardized I&amp;E workbook with Veracity
              internal numbers.
            </p>
          </div>

          <Link
            href="/dashboard/automation/ie"
            className="mt-6 inline-flex w-fit items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800"
          >
            Open I&amp;E Automation
          </Link>
        </section>

        <section className="flex flex-col rounded-lg border border-slate-200 bg-white p-6">
          <div className="flex-1">
            <h2 className="text-base font-semibold text-slate-900">
              Rent Roll
            </h2>

            <p className="mt-2 text-sm leading-6 text-slate-600">
              Extract unit information and rent charges from a property rent
              roll and generate the standardized clean rent roll and summary.
            </p>
          </div>

          <Link
            href="/dashboard/automation/rent-roll"
            className="mt-6 inline-flex w-fit items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800"
          >
            Open Rent Roll Automation
          </Link>
        </section>
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-50 px-5 py-4">
        <p className="text-sm text-slate-600">
          Automation files are processed on demand. Keystone does not maintain
          an automation history in this version.
        </p>
      </div>
    </div>
  );
}