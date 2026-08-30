import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthShell } from "@/features/auth/components/auth-form";
import { VerifyEmailActions } from "@/features/auth/components/verify-email-actions";
import { getCurrentUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Confirm your email" };
/**
 * Never prerendered. The entire output depends on who is asking, and a cached
 * copy of "confirm your email" served to the wrong person is both wrong and a
 * small information leak. Marking it explicitly also keeps the build honest:
 * without this, Next tries to render it at build time and needs Supabase
 * credentials to produce a page that can only ever be correct per-request.
 */
export const dynamic = "force-dynamic";

export default async function VerifyEmailPage() {
  const user = await getCurrentUser();

  if (!user) redirect("/login");
  if (user.email_confirmed_at) redirect("/");

  return (
    <AuthShell
      title="Confirm your email"
      lead="One link stands between you and the room."
      footer={<span className="label">Step 2 of 2</span>}
    >
      <VerifyEmailActions email={user.email ?? "your address"} />
    </AuthShell>
  );
}
