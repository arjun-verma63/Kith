import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ProfileView } from "@/features/profile/components/profile-view";
import { getProfileByUsername } from "@/features/profile/queries";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/u/[username]">): Promise<Metadata> {
  const { username } = await params;
  const profile = await getProfileByUsername(username);
  return { title: profile ? profile.display_name : "Not found" };
}

export default async function ProfilePage({ params }: PageProps<"/u/[username]">) {
  const { username } = await params;
  const profile = await getProfileByUsername(username);

  // Null covers both "no such person" and "blocked", deliberately. A distinct
  // response for the second would confirm the account exists.
  if (!profile) notFound();

  return <ProfileView profile={profile} />;
}
