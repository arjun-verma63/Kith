import type { Metadata } from "next";

import { AuthShell } from "@/features/auth/components/auth-form";
import { SignupForm } from "@/features/auth/components/signup-form";

export const metadata: Metadata = { title: "Create your account" };

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const params = await searchParams;
  const invite = typeof params.invite === "string" ? params.invite : undefined;

  return (
    <AuthShell
      title="Create your account"
      lead="KITH is invitation only. If someone sent you a code, this is where it goes."
    >
      <SignupForm inviteCode={invite} />
    </AuthShell>
  );
}
