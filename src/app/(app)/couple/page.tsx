import { redirect } from "next/navigation";

import { CoupleView } from "@/features/couple/components/couple-view";
import { getMyCouple, getWhoCanPropose, listInvitations } from "@/features/couple/queries";
import { openTodaysPromptAction } from "@/features/couple/actions";
import { getCurrentUser } from "@/lib/supabase/server";

/**
 * The couple page.
 *
 * The only surface this feature has. Nothing about it appears anywhere else in
 * KITH unless both people have chosen to show it — no badge on a message, no
 * entry in a list, nothing on the landing page.
 *
 * Opening today's question happens on the way in rather than on a schedule: a
 * cron job for two people is a job that runs for nobody most days, and the
 * unique constraint on (couple, day) makes arriving twice harmless.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Couple" };

export default async function CouplePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [couple, invitations, whoCanPropose] = await Promise.all([
    getMyCouple(),
    listInvitations(),
    getWhoCanPropose(),
  ]);

  const prompts = couple ? await openTodaysPromptAction(couple.id) : [];

  return (
    <CoupleView
      couple={couple}
      invitations={invitations}
      prompts={prompts}
      whoCanPropose={whoCanPropose}
    />
  );
}
