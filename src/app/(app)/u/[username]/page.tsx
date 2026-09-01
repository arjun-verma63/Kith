import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CoupleMarker } from "@/features/couple/components/couple-marker";
import { ProposeButton } from "@/features/couple/components/propose-button";
import { canProposeTo, coupleMarkerFor } from "@/features/couple/queries";
import { ProfileView } from "@/features/profile/components/profile-view";
import { getProfileByUsername } from "@/features/profile/queries";
import { SafetyMenu } from "@/features/safety/components/safety-menu";
import { hasBlocked } from "@/features/safety/queries";

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
  const [marker, mayPropose, blocked] = await Promise.all([
    coupleMarkerFor(profile.id),
    profile.isOwn ? Promise.resolve(false) : canProposeTo(profile.id),
    /*
     * Read on the server so the button says the right word on first paint.
     *
     * Only reachable at all when the profile came back, and `profiles_select`
     * hides a blocked person in both directions — so in practice this is false
     * every time it is asked. It is here for the one case where it is not: you
     * blocked them and then navigated straight to the URL you already had.
     */
    profile.isOwn ? Promise.resolve(false) : hasBlocked(profile.id),
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
      {...(profile.isOwn
        ? {}
        : {
            safetyAction: (
              <SafetyMenu
                userId={profile.id}
                displayName={profile.display_name}
                blocked={blocked}
              />
            ),
          })}
    />
  );
}
