import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { signOutAction } from "@/features/auth/actions";
import { DeleteAccount } from "@/features/auth/components/delete-account";
import { EmailChangeForm } from "@/features/auth/components/email-change-form";
import { getOwnProfile } from "@/features/profile/queries";
import { getCurrentUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

/**
 * Settings → Account. The identity behind the profile.
 *
 * Profile is what other people see; this is what the system knows — the address
 * you sign in with, when you arrived, and the two ways out. Deletion lived on
 * Security until this phase, which was never right: it is not a security
 * control, it is the end of the account.
 */
export default async function AccountSettingsPage() {
  const [user, profile] = await Promise.all([getCurrentUser(), getOwnProfile()]);

  if (!user || !profile) redirect("/login");

  return (
    <>
      <div className="mb-6 flex flex-col gap-1.5">
        <h2 className="heading text-md text-fg-loud">Account</h2>
        <p className="max-w-prose text-sm leading-body text-fg-dim">
          The identity behind the profile. Changing your name or photo is over in Profile.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        <EmailChangeForm current={user.email ?? "No address on file"} />

        <Panel tone="flat" padding="none" className="rounded-soft">
          <header className="border-b border-line px-4 py-3 sm:px-5">
            <span className="label text-fg-faint">This account</span>
          </header>

          <dl className="flex flex-col">
            <Row
              label="Username"
              value={`@${profile.username}`}
              help="Changed in Profile. Old messages follow you."
            />
            <Row
              label="In the room since"
              value={new Date(profile.created_at).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            />
          </dl>

          <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 sm:px-5">
            <span className="text-2xs text-fg-faint">
              Signs out this device only. Others stay signed in.
            </span>
            <form action={signOutAction}>
              <Button type="submit" variant="quiet" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </Panel>

        <div className="mt-4 border-t border-line pt-5">
          <DeleteAccount username={profile.username} />
        </div>
      </div>
    </>
  );
}

function Row({ label, value, help }: { label: string; value: string; help?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-3 last:border-b-0 sm:px-5">
      <dt className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-fg">{label}</span>
        {help ? <span className="text-2xs text-fg-faint">{help}</span> : null}
      </dt>
      <dd className="text-sm text-fg-loud">{value}</dd>
    </div>
  );
}
