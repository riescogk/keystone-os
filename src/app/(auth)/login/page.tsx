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
    </div>
  );
}