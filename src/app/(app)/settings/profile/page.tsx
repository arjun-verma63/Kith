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
      <div className="mb-8 flex items-end justify-between gap-4">
        <h1 className="display text-d-xs text-fg-loud">Your profile</h1>

        <ButtonLink href={`/u/${profile.username}`} variant="ghost" size="sm">
          View as others see it
        </ButtonLink>
      </div>

      <ProfileForm profile={profile} />
    </>
  );
}
