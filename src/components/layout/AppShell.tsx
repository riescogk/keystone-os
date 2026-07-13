import { ReactNode } from "react";
import { Navbar } from "@/components/layout/Navbar";

interface AppShellProps {
  userEmail: string | null;
  children: ReactNode;
}

/**
 * Shared shell for every authenticated screen: Navbar + centered
 * content column. Reused by the dashboard and account settings pages
 * so layout stays consistent as more screens are added in later phases.
 */
export function AppShell({ userEmail, children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-slate-50">
      <Navbar userEmail={userEmail} />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
