import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthShell } from "@/features/auth/components/auth-form";
import { ResetPasswordForm } from "@/features/auth/components/reset-password-form";
import { getCurrentUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Choose a new password" };
/**
 * Never prerendered. The entire output depends on who is asking, and a cached
 * copy of "confirm your email" served to the wrong person is both wrong and a
 * small information leak. Marking it explicitly also keeps the build honest:
 * without this, Next tries to render it at build time and needs Supabase
 * credentials to produce a page that can only ever be correct per-request.
 */
export const dynamic = "force-dynamic";

export default async function ResetPasswordPage() {
  // Following the recovery link creates a session. Without one there is nothing
  // to reset, and the page must not render a form that cannot work. Checked here
  // as well as in middleware because a page that depends on a session should say
  // so itself rather than trust the layer above it.
  const user = await getCurrentUser();
  if (!user) redirect("/forgot-password?expired=1");

  return (
    <AuthShell
      title="Choose a new password"
      lead="This replaces the old one everywhere you are signed in."
    >
      <ResetPasswordForm />
    </AuthShell>
  );
}
