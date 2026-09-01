import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CoupleMarker } from "@/features/couple/components/couple-marker";
import { ProposeButton } from "@/features/couple/components/propose-button";
import { canProposeTo, coupleMarkerFor } from "@/features/couple/queries";
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

  /*
   * The couple pieces, both usually absent.
   *
   * `coupleMarkerFor` returns nothing unless the couple chose to be visible and
   * the viewer is a friend; `canProposeTo` returns false unless a friendship
   * already exists and neither person is attached. So for almost every profile
   * this page looks exactly as it did before couple mode existed — which is the
   * point of it being optional.
   */
  const [marker, mayPropose] = await Promise.all([
    coupleMarkerFor(profile.id),
    profile.isOwn ? Promise.resolve(false) : canProposeTo(profile.id),
  ]);

  return (
    <ProfileView
      profile={profile}
      {...(marker
        ? {
            coupleMarker: (
              <CoupleMarker
                partnerUsername={marker.partnerUsername}
                partnerDisplayName={marker.partnerDisplayName}
                isOwn={profile.isOwn}
              />
            ),
          }
        : {})}
      {...(mayPropose
        ? {
            proposeAction: <ProposeButton userId={profile.id} displayName={profile.display_name} />,
          }
        : {})}
    />
  );
}
