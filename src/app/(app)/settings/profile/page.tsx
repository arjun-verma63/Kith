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
    <div className="mx-auto w-full max-w-2xl px-6 py-14 sm:px-10">
      <div className="mb-10 flex items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <span className="label text-fg-faint">Settings</span>
          <h1 className="display text-d-xs text-fg-loud">Your profile</h1>
        </div>

        <ButtonLink href={`/u/${profile.username}`} variant="ghost" size="sm">
          View as others see it
        </ButtonLink>
      </div>

      <ProfileForm profile={profile} />
    </div>
  );
}
