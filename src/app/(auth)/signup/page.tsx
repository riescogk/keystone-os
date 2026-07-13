import Link from "next/link";
import { SignupForm } from "@/app/(auth)/signup/SignupForm";

export const metadata = {
  title: "Sign up — Keystone OS",
};

export default function SignupPage() {
  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-slate-900">
        Create your account
      </h1>
      <SignupForm />
      <p className="mt-6 text-center text-sm text-slate-600">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-slate-900 underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
