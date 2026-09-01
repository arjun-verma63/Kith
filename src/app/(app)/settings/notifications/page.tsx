import type { Metadata } from "next";

import { NotificationForm } from "@/features/settings/components/notification-form";
import { getPreferences } from "@/features/settings/queries";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

export default async function NotificationSettingsPage() {
  const preferences = await getPreferences();

  return (
    <>
      <div className="mb-6 flex flex-col gap-1.5">
        <h2 className="heading text-md text-fg-loud">Notifications</h2>
        <p className="max-w-prose text-sm leading-body text-fg-dim">
          Switching one off stops the notification being written at all, rather than hiding it after
          the fact.
        </p>
      </div>

      <NotificationForm settings={preferences.notifications} />
    </>
  );
}
