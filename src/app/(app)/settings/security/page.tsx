import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getPrivacySettings, listSessions } from "@/features/auth/account-queries";
import { DeleteAccount } from "@/features/auth/components/delete-account";
import { MfaSettings } from "@/features/auth/components/mfa-settings";
import { PasswordChangeForm } from "@/features/auth/components/password-change-form";
import { PrivacyForm } from "@/features/auth/components/privacy-form";
import { SecurityLog } from "@/features/auth/components/security-log";
import { SessionList } from "@/features/auth/components/session-list";
import { getMfaStatus, listSecurityEvents } from "@/features/auth/mfa-queries";
import { getOwnProfile } from "@/features/profile/queries";

export const metadata: Metadata = { title: "Security" };
export const dynamic = "force-dynamic";

/**
 * Settings → Security.
 *
 * Ordered by how often somebody arrives wanting it, not by how dramatic it is:
 * the password and the second factor first, then the question "is anybody else
 * signed in", then who may reach you, then the record of what has happened, and
 * only then the way out.
 *
 * Everything is read in parallel — six independent reads with nothing to say to
 * each other should not cost six sequential round trips on a page people open
 * when they are already worried.
 */
export default async function SecuritySettingsPage() {
  const [profile, status, sessions, privacy, events] = await Promise.all([
    getOwnProfile(),
    getMfaStatus(),
    listSessions(),
    getPrivacySettings(),
    listSecurityEvents(),
  ]);

  if (!profile || !status) redirect("/login");

  return (
    <>
      <h1 className="display mb-2 text-d-xs text-fg-loud">Security</h1>
      <p className="mb-8 max-w-prose text-sm leading-body text-fg-dim">
        KITH is a small room. What is on this page decides who gets into it.
      </p>

      <div className="flex flex-col gap-6">
        <PasswordChangeForm />
        <MfaSettings status={status} />
        <SessionList sessions={sessions.sessions} supported={sessions.supported} />
        <PrivacyForm settings={privacy} />
        <SecurityLog events={events} />

        <div className="mt-6 border-t border-line pt-6">
          <DeleteAccount username={profile.username} />
        </div>
      </div>
    </>
  );
}
