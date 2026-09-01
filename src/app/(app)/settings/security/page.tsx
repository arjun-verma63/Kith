import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { listSessions } from "@/features/auth/account-queries";
import { MfaSettings } from "@/features/auth/components/mfa-settings";
import { PasswordChangeForm } from "@/features/auth/components/password-change-form";
import { SecurityLog } from "@/features/auth/components/security-log";
import { SessionList } from "@/features/auth/components/session-list";
import { getMfaStatus, listSecurityEvents } from "@/features/auth/mfa-queries";

export const metadata: Metadata = { title: "Security" };
export const dynamic = "force-dynamic";

/**
 * Settings → Security. How you get in, and who else has.
 *
 * Ordered by how often somebody arrives wanting it rather than by how dramatic
 * it is: the password and the second factor first, then "is anybody else signed
 * in", then the record of what has happened.
 *
 * Privacy moved to its own section and deletion moved to Account — both were
 * here because there was nowhere else to put them. What is left is one subject.
 *
 * Read in parallel: four independent queries with nothing to say to each other
 * should not cost four sequential round trips on a page people open when they
 * are already worried.
 */
export default async function SecuritySettingsPage() {
  const [status, sessions, events] = await Promise.all([
    getMfaStatus(),
    listSessions(),
    listSecurityEvents(),
  ]);

  if (!status) redirect("/login");

  return (
    <>
      <div className="mb-6 flex flex-col gap-1.5">
        <h2 className="heading text-md text-fg-loud">Security</h2>
        <p className="max-w-prose text-sm leading-body text-fg-dim">
          KITH is a small room. What is on this page decides who gets into it.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        <PasswordChangeForm />
        <MfaSettings status={status} />
        <SessionList sessions={sessions.sessions} supported={sessions.supported} />
        <SecurityLog events={events} />
      </div>
    </>
  );
}
