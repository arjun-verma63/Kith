import type { Metadata } from "next";

import { AppearanceForm } from "@/features/settings/components/appearance-form";
import { getPreferences } from "@/features/settings/queries";

export const metadata: Metadata = { title: "Appearance" };
export const dynamic = "force-dynamic";

export default async function AppearanceSettingsPage() {
  const preferences = await getPreferences();

  return (
    <>
      <div className="mb-6 flex flex-col gap-1.5">
        <h2 className="heading text-md text-fg-loud">Appearance</h2>
        <p className="max-w-prose text-sm leading-body text-fg-dim">
          Saved to your account rather than to this browser, so it follows you.
        </p>
      </div>

      <AppearanceForm settings={{ theme: preferences.theme, motion: preferences.motion }} />
    </>
  );
}
