import type { Metadata } from "next";

import { PrivacyForm } from "@/features/settings/components/privacy-form";
import { getPreferences } from "@/features/settings/queries";

export const metadata: Metadata = { title: "Privacy" };
export const dynamic = "force-dynamic";

export default async function PrivacySettingsPage() {
  const preferences = await getPreferences();

  return (
    <>
      <SectionHeading />
      <PrivacyForm settings={preferences} />
    </>
  );
}

function SectionHeading() {
  return (
    <div className="mb-6 flex flex-col gap-1.5">
      <h2 className="heading text-md text-fg-loud">Privacy</h2>
      <p className="max-w-prose text-sm leading-body text-fg-dim">
        Who can find you, reach you, and see what. Every one of these is checked by the database,
        not by the screen that offers it.
      </p>
    </div>
  );
}
