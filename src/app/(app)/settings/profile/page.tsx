import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ButtonLink } from "@/components/ui/button";
import { ProfileForm } from "@/features/profile/components/profile-form";
import { getOwnProfile } from "@/features/profile/queries";

export const metadata: Metadata = { title: "Your profile" };
export const dynamic = "force-dynamic";

export default async function ProfileSettingsPage() {
  const profile = await getOwnProfile();
  if (!profile) redirect("/login");

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <h2 className="heading text-md text-fg-loud">Profile</h2>
          <p className="max-w-prose text-sm leading-body text-fg-dim">
            What everybody in the room sees. Your birthday is the one field with its own visibility
            setting, over in Privacy.
          </p>
        </div>

        <ButtonLink href={`/u/${profile.username}`} variant="ghost" size="sm">
          View as others see it
        </ButtonLink>
      </div>

      <ProfileForm profile={profile} />
    </>
  );
}
