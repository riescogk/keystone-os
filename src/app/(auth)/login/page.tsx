import Link from "next/link";
import { Suspense } from "react";
import { LoginForm } from "@/app/(auth)/login/LoginForm";

export const metadata = {
  title: "Log in — Keystone OS",
};

export default function LoginPage() {
  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-slate-900">Log in</h1>
      <Suspense>
        <LoginForm />
      </Suspense>
      <p className="mt-6 text-center text-sm text-slate-600">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-medium text-slate-900 underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}
