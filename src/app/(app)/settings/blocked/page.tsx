import type { Metadata } from "next";

import { BlockedList } from "@/features/safety/components/blocked-list";
import { ReportHistory } from "@/features/safety/components/report-history";
import { listBlocked, listMyReports } from "@/features/safety/queries";

export const metadata: Metadata = { title: "Blocked" };
export const dynamic = "force-dynamic";

/**
 * Settings → Safety.
 *
 * Exists mainly so that blocking is reversible. Blocking hides somebody
 * everywhere else in KITH — profile, search, friends, messages — so without this
 * page an accidental block would be close to permanent: you cannot find the
 * person in order to unblock them.
 */
export default async function BlockedSettingsPage() {
  const [blocked, reports] = await Promise.all([listBlocked(), listMyReports()]);

  return (
    <>
      <div className="mb-6 flex flex-col gap-1.5">
        <h2 className="heading text-md text-fg-loud">Blocked users</h2>
        <p className="max-w-prose text-sm leading-body text-fg-dim">
          Blocking and reporting both start on somebody&rsquo;s profile. This is where you undo the
          first and check on the second.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        <BlockedList blocked={blocked} />
        <ReportHistory reports={reports} />
      </div>
    </>
  );
}
