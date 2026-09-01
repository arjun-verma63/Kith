import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthShell } from "@/features/auth/components/auth-form";
import { MfaChallengeForm } from "@/features/auth/components/mfa-challenge-form";
import { getMfaStatus } from "@/features/auth/mfa-queries";
import { safeRedirect } from "@/features/auth/redirects";

export const metadata: Metadata = { title: "Two-factor authentication" };
export const dynamic = "force-dynamic";

/**
 * The sign-in challenge.
 *
 * Reachable only with a session that owes a factor — middleware sends people
 * here and away again, and this page checks the same thing itself rather than
 * trusting that it ran. Both of those are routing, not security: the reason an
 * unchallenged session cannot do anything is the restrictive policy in migration
 * 0024, which applies whether a browser is involved at all.
 */
export default async function VerifyTwoFactorPage({ searchParams }: PageProps<"/verify-2fa">) {
  const status = await getMfaStatus();

  if (!status) redirect("/login");
  if (!status.challengeRequired) redirect("/");

  const params = await searchParams;
  const raw = params.next;
  const next = safeRedirect(typeof raw === "string" ? raw : null);

  return (
    <AuthShell
      title="One more thing"
      lead="Open your authenticator app and enter the code it is showing."
      footer={<span className="label">Step 2 of 2</span>}
    >
      <MfaChallengeForm next={next ?? undefined} />
    </AuthShell>
  );
}
