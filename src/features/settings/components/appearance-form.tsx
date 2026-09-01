"use client";

import { useActionState, useEffect } from "react";

import { FormBanner } from "@/components/ui/form";
import { saveAppearanceAction } from "@/features/settings/actions";
import { ChoiceRow, SaveBar, SettingsCard } from "@/features/settings/components/controls";
import {
  MOTION_OPTIONS,
  THEME_OPTIONS,
  type AppearancePreferences,
} from "@/features/settings/preferences";
import { idleFormState } from "@/lib/forms";

/**
 * Appearance.
 *
 * Both of these were real columns that nothing read. The theme lived in
 * localStorage — so it followed the browser rather than the person — and motion
 * was a comment in `tokens.css` saying "Settings → Appearance, Phase 2".
 *
 * Persisting the theme is the actual change: it now follows you to a phone.
 * localStorage stays as the pre-paint bootstrap, because a stylesheet cannot
 * wait for a database round trip, and the app shell reconciles the two.
 *
 * ── The honest bit about motion ──────────────────────────────────────────────
 *
 * "Full" does not override a system-level reduced-motion preference, and the
 * option text says so. An app setting that can switch an accessibility
 * preference back on is one that should not exist.
 */
export function AppearanceForm({ settings }: { settings: AppearancePreferences }) {
  const [state, formAction] = useActionState(saveAppearanceAction, idleFormState);

  /*
   * Repaint after a successful save.
   *
   * `revalidatePath` re-renders the shell, but the shell writes the theme with a
   * script tag that only runs on a full navigation — a client-side re-render
   * will not re-execute it. So the page that changed the setting applies it
   * itself, and every other page picks it up from the server on its next load.
   */
  useEffect(() => {
    if (state.status !== "success") return;

    const form = document.querySelector<HTMLFormElement>("form[data-appearance]");
    if (!form) return;

    const data = new FormData(form);
    const theme = String(data.get("theme") ?? "dusk");
    const motion = String(data.get("motion") ?? "full");
    const root = document.documentElement;

    root.dataset["theme"] =
      theme === "system"
        ? window.matchMedia("(prefers-color-scheme: light)").matches
          ? "daylight"
          : "dusk"
        : theme;
    root.dataset["motion"] = motion;

    try {
      window.localStorage.setItem("kith-theme", theme);
    } catch {
      // Private browsing. The server still has it; only the pre-paint hint is lost.
    }
  }, [state]);

  return (
    <form action={formAction} data-appearance className="flex flex-col gap-5">
      <FormBanner state={state} />

      <SettingsCard
        title="Theme"
        description="Saved to your account, so it follows you to another device rather than living in one browser."
      >
        <ChoiceRow
          name="theme"
          label="Light or dark"
          help="Dusk is the room at night, which is what KITH was drawn for."
          value={settings.theme}
          options={THEME_OPTIONS}
        />
      </SettingsCard>

      <SettingsCard
        title="Motion"
        description="How much things move. Everything stays usable at every setting."
      >
        <ChoiceRow
          name="motion"
          label="Animation"
          help="Reduced keeps things still but lets ambient signals — the presence ember — carry on."
          value={settings.motion}
          options={MOTION_OPTIONS}
        />

        <p className="mt-2 max-w-prose text-2xs leading-body text-fg-faint">
          If your device already asks for reduced motion, KITH honours that whatever is chosen here.
          Turning it down in KITH works either way.
        </p>
      </SettingsCard>

      <SaveBar />
    </form>
  );
}
