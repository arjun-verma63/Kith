import type { Metadata } from "next";

import { AuthShell } from "@/features/auth/components/auth-form";
import { LoginForm } from "@/features/auth/components/login-form";
import { safeRedirect } from "@/features/auth/redirects";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = safeRedirect(typeof params.next === "string" ? params.next : null);

  const lead =
    params.signedout === "1"
      ? "Signed out. The room is still here when you want it."
      : params.reset === "1"
        ? "Password changed. Sign in with the new one."
        : "Welcome back.";

  return (
    <AuthShell title="Sign in" lead={lead}>
      <LoginForm next={next ?? undefined} />
    </AuthShell>
  );
}
