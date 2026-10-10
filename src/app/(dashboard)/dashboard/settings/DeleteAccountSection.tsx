"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { deleteAccount } from "@/lib/account/actions";
import { DELETE_ACCOUNT_CONFIRMATION } from "@/lib/account/constants";

/**
 * PRD Section 8.9 — Data Deletion Confirmation. Shows exactly what
 * will be deleted and what is retained, requires an explicit typed
 * confirmation, shows an in-progress state, and on failure shows a
 * clear message that the account was NOT deleted.
 */
export function DeleteAccountSection() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canConfirm = confirmation === DELETE_ACCOUNT_CONFIRMATION;

  function handleCancel() {
    setIsOpen(false);
    setConfirmation("");
    setError(null);
  }

  async function handleDelete() {
    setError(null);
    setIsDeleting(true);

    const result = await deleteAccount(confirmation);

    if (!result.success) {
      setIsDeleting(false);
      setError(result.error);
      return;
    }

    // Deleted. The session is already cleared server-side; leave the
    // authenticated area. isDeleting stays true so the form can't be
    // resubmitted while navigating away.
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="max-w-md rounded-lg border border-red-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-red-700">Danger zone</h2>
      <p className="mt-1 text-sm text-slate-600">
        Permanently delete your Keystone account and all of your data.
      </p>

      {!isOpen ? (
        <div className="mt-4">
          <Button variant="danger" onClick={() => setIsOpen(true)}>
            Delete account
          </Button>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <p className="font-medium">
              This is permanent and cannot be undone.
            </p>
            <p className="mt-3 font-medium">What will be deleted:</p>
            <ul className="mt-1 list-disc pl-5">
              <li>Your account and profile</li>
              <li>Every PDF report you have uploaded</li>
              <li>All extracted text from those reports</li>
              <li>All findings and your acknowledge/dismiss history</li>
            </ul>
            <p className="mt-3 font-medium">What is retained:</p>
            <p className="mt-1">
              Nothing is retained by Keystone — no billing records exist, and
              data is not transferred to any other account. Backups held by our
              infrastructure provider follow that provider&apos;s own retention
              schedule.
            </p>
          </div>

          <Input
            label={`Type ${DELETE_ACCOUNT_CONFIRMATION} to confirm`}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoComplete="off"
            disabled={isDeleting}
          />

          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              variant="danger"
              onClick={handleDelete}
              disabled={!canConfirm}
              isLoading={isDeleting}
            >
              {isDeleting ? "Deleting…" : "Permanently delete my account"}
            </Button>
            <Button
              variant="ghost"
              onClick={handleCancel}
              disabled={isDeleting}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
