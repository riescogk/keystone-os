"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

interface FieldErrors {
  fullName?: string;
  email?: string;
  password?: string;
}

export function SignupForm() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [firmName, setFirmName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmationSent, setConfirmationSent] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  function validate(): boolean {
    const errors: FieldErrors = {};
    if (fullName.trim().length === 0) {
      errors.fullName = "Enter your name.";
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      errors.email = "Enter a valid email address.";
    }
    if (password.length < 8) {
      errors.password = "Password must be at least 8 characters.";
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);

    if (!validate()) return;

    setIsLoading(true);
    const supabase = createClient();

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName.trim(),
          firm_name: firmName.trim() || null,
        },
      },
    });

    setIsLoading(false);

    if (error) {
      // Supabase returns a specific "already registered" style message
      // for duplicate emails; surfacing it here is acceptable for signup
      // (unlike login) because the user just typed the email themselves.
      setFormError(error.message);
      return;
    }

    if (data.session) {
      // Email confirmation is disabled on this Supabase project — the
      // user is already signed in.
      router.replace("/dashboard");
      router.refresh();
      return;
    }

    // Email confirmation is enabled — no session yet.
    setConfirmationSent(true);
  }

  if (confirmationSent) {
    return (
      <p className="text-sm text-slate-700">
        Check <strong>{email}</strong> for a confirmation link to finish
        creating your account.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <Input
        label="Full name"
        name="fullName"
        autoComplete="name"
        required
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        error={fieldErrors.fullName}
      />
      <Input
        label="Firm name (optional)"
        name="firmName"
        autoComplete="organization"
        value={firmName}
        onChange={(e) => setFirmName(e.target.value)}
      />
      <Input
        label="Email"
        type="email"
        name="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={fieldErrors.email}
      />
      <Input
        label="Password"
        type="password"
        name="password"
        autoComplete="new-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={fieldErrors.password}
      />

      {formError && (
        <p role="alert" className="text-sm text-red-600">
          {formError}
        </p>
      )}

      <Button type="submit" isLoading={isLoading} className="w-full">
        Create account
      </Button>
    </form>
  );
}
