import type { Metadata } from "next";

import { AuthShell } from "@/features/auth/components/auth-form";
import { ForgotPasswordForm } from "@/features/auth/components/forgot-password-form";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="Reset your password"
      lead="Tell us the address on your account and we will send you a link."
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
