
import Link from "next/link";
import TableVerificationForm from "./TableVerificationForm";

export const metadata = {
  title: "Table Verification — Keystone OS",
};

export default function TableVerificationPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/dashboard/automation"
          className="text-sm font-medium text-slate-500 hover:text-slate-900"
        >
          ← Back to Automation
        </Link>

        <h1 className="mt-4 text-lg font-semibold text-slate-900">
          Table Verification
        </h1>

        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Compare Word appraisal report tables against their
          corresponding Excel source tables.
        </p>
      </div>

      <TableVerificationForm />
    </div>
  );
}
