import Link from "next/link";
import { SignOutButton } from "@/components/layout/SignOutButton";

interface NavbarProps {
  userEmail: string | null;
}

/**
 * Persistent primary navigation for the authenticated area of the app.
 * Per PRD Section 9: Dashboard, Account Settings, Log out are always
 * reachable from here. "New Review" is intentionally NOT wired to a
 * real route yet — Phase 2 builds no upload/review functionality.
 */
export function Navbar({ userEmail }: NavbarProps) {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link
          href="/dashboard"
          className="text-sm font-semibold text-slate-900"
        >
          Keystone OS
        </Link>

        <nav className="flex items-center gap-6" aria-label="Primary">
          <Link
            href="/dashboard"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Dashboard
          </Link>
          <Link
            href="/dashboard/settings"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Account Settings
          </Link>
        </nav>

        <div className="flex items-center gap-4">
          {userEmail && (
            <span className="hidden text-sm text-slate-500 sm:inline">
              {userEmail}
            </span>
          )}
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
