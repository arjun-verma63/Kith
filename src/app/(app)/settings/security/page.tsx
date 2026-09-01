import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { MfaSettings } from "@/features/auth/components/mfa-settings";
import { SecurityLog } from "@/features/auth/components/security-log";
import { getMfaStatus, listSecurityEvents } from "@/features/auth/mfa-queries";

export const metadata: Metadata = { title: "Security" };
export const dynamic = "force-dynamic";

export default async function SecuritySettingsPage() {
  const [status, events] = await Promise.all([getMfaStatus(), listSecurityEvents()]);

  if (!status) redirect("/login");

  return (
    <>
      <h1 className="display mb-2 text-d-xs text-fg-loud">Security</h1>
      <p className="mb-8 max-w-prose text-sm leading-body text-fg-dim">
        KITH is a small room. Two-factor authentication means that knowing your password is not
        enough to walk into it.
      </p>

      <div className="flex flex-col gap-6">
        <MfaSettings status={status} />
        <SecurityLog events={events} />
      </div>
    </>
  );
}
