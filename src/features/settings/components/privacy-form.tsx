"use client";

import { useActionState } from "react";

import { FormBanner } from "@/components/ui/form";
import { savePrivacyAction } from "@/features/settings/actions";
import {
  ChoiceRow,
  RowDivider,
  SaveBar,
  SettingsCard,
  ToggleRow,
} from "@/features/settings/components/controls";
import {
  PERMISSION_SCOPES,
  PRIVACY_CONTROLS,
  SCOPE_LABELS,
  type PrivacyPreferences,
} from "@/features/settings/preferences";
import { idleFormState } from "@/lib/forms";

/**
 * Privacy.
 *
 * Every control here is read by a database function that decides what other
 * people may do — the names are in `PRIVACY_CONTROLS`, and the suite looks each
 * one up in `pg_proc`. None of them can be walked around by a client that skips
 * this page: the enforcement is in the policy, not in the button.
 *
 * The typing indicator is the exception, and the copy says so rather than
 * implying a guarantee the server is not making.
 *
 * Two cards, one form, one save. Splitting the form would mean two actions
 * writing overlapping columns, and a save button per card would mean two buttons
 * that both do the same thing.
 */

const SCOPE_OPTIONS = PERMISSION_SCOPES.map((key) => ({ key, label: SCOPE_LABELS[key] }));

const control = (key: (typeof PRIVACY_CONTROLS)[number]["key"]) => {
  const found = PRIVACY_CONTROLS.find((entry) => entry.key === key);
  if (!found) throw new Error(`No privacy control for ${key}`);
  return found;
};

export function PrivacyForm({ settings }: { settings: PrivacyPreferences }) {
  const [state, formAction] = useActionState(savePrivacyAction, idleFormState);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormBanner state={state} />

      <SettingsCard
        title="Being found"
        description="Everybody here was invited by somebody. This decides who can reach you afterwards."
      >
        <ToggleRow
          name="discoverable"
          label={control("discoverable").label}
          help={control("discoverable").help}
          defaultChecked={settings.discoverable}
        />

        <RowDivider />

        <ChoiceRow
          name="whoCanMessage"
          label={control("whoCanMessage").label}
          help={control("whoCanMessage").help}
          value={settings.whoCanMessage}
          options={SCOPE_OPTIONS}
        />

        <ChoiceRow
          name="whoCanCall"
          label={control("whoCanCall").label}
          help={control("whoCanCall").help}
          value={settings.whoCanCall}
          options={SCOPE_OPTIONS}
        />

        <ChoiceRow
          name="whoCanPropose"
          label={control("whoCanPropose").label}
          help={control("whoCanPropose").help}
          value={settings.whoCanPropose}
          options={SCOPE_OPTIONS}
        />
      </SettingsCard>

      <SettingsCard
        title="What people see"
        description="Your name, photo and bio are visible to everybody in the room. These two are not."
      >
        <ChoiceRow
          name="showBirthday"
          label={control("showBirthday").label}
          help={control("showBirthday").help}
          value={settings.showBirthday}
          options={SCOPE_OPTIONS}
        />

        <RowDivider />

        <ToggleRow
          name="typingIndicators"
          label="Let people see when you are typing"
          help="Stops your browser sending it. It cannot stop anybody else's browser sending theirs — that is their setting, not yours."
          defaultChecked={settings.typingIndicators}
        />
      </SettingsCard>

      <SaveBar />
    </form>
  );
}
