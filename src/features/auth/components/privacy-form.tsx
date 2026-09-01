"use client";

import { useActionState } from "react";

import { FormBanner, FormFields, SubmitButton } from "@/components/ui/form";
import { Panel } from "@/components/ui/panel";
import {
  PERMISSION_SCOPES,
  PRIVACY_CONTROLS,
  type PermissionScope,
  type PrivacySettings,
} from "@/features/auth/account";
import { savePrivacyAction } from "@/features/auth/account-actions";
import { idleFormState } from "@/lib/forms";
import { cn } from "@/lib/utils/cn";

/**
 * Privacy controls.
 *
 * ── Every switch here does something in SQL ──────────────────────────────────
 *
 * Each one is read by a database function that decides what other people may do
 * — `search_profiles`, `can_open_conversation_with`, `can_call_conversation`,
 * `can_propose_to`. None of them is a UI preference, and none of them can be
 * walked around by a client that skips this page: the enforcement is in the
 * policy, not in the button.
 *
 * `who_can_call` was a column nothing read until migration 0025 wired it in. A
 * control that controls nothing is worse than no control, because it is a
 * promise on a settings page that the database does not keep — which is exactly
 * why `PRIVACY_CONTROLS` carries the name of the function enforcing each row.
 *
 * `read_receipts` and `typing_indicators` exist in the same table and are
 * deliberately absent. Nothing reads them yet, and they are messaging courtesies
 * rather than access controls — they belong next to the code that would honour
 * them, not here.
 */

const SCOPE_LABELS: Record<PermissionScope, string> = {
  everyone: "Everyone",
  friends: "Friends",
  nobody: "Nobody",
};

export function PrivacyForm({ settings }: { settings: PrivacySettings }) {
  const [state, formAction] = useActionState(savePrivacyAction, idleFormState);

  return (
    <Panel tone="flat" padding="none" className="rounded-soft">
      <header className="border-b border-line px-4 py-3">
        <span className="label text-fg-faint">Privacy</span>
      </header>

      <div className="p-4">
        <FormBanner state={state} />

        <form action={formAction}>
          <FormFields>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                name="discoverable"
                defaultChecked={settings.discoverable}
                className="control-focus mt-0.5 size-4 shrink-0 rounded-edge accent-[var(--ember)]"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-fg-loud">{PRIVACY_CONTROLS[0].label}</span>
                <span className="text-2xs leading-body text-fg-faint">
                  {PRIVACY_CONTROLS[0].help}
                </span>
              </span>
            </label>

            <ScopeField
              name="whoCanMessage"
              label={PRIVACY_CONTROLS[1].label}
              help={PRIVACY_CONTROLS[1].help}
              value={settings.whoCanMessage}
            />

            <ScopeField
              name="whoCanCall"
              label={PRIVACY_CONTROLS[2].label}
              help={PRIVACY_CONTROLS[2].help}
              value={settings.whoCanCall}
            />

            <ScopeField
              name="whoCanPropose"
              label={PRIVACY_CONTROLS[3].label}
              help={PRIVACY_CONTROLS[3].help}
              value={settings.whoCanPropose}
            />

            <SubmitButton idleLabel="Save privacy settings" />
          </FormFields>
        </form>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Three radios rather than a select.
 *
 * The whole set is three options and all of them matter; hiding two of them
 * behind a click makes "nobody" feel like an advanced setting when it is the one
 * somebody reaches for in a hurry.
 */
function ScopeField({
  name,
  label,
  help,
  value,
}: {
  name: string;
  label: string;
  help: string;
  value: PermissionScope;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="flex flex-col gap-0.5">
        <span className="text-sm text-fg-loud">{label}</span>
        <span className="text-2xs leading-body text-fg-faint">{help}</span>
      </legend>

      <div className="mt-1 flex flex-wrap gap-1.5">
        {PERMISSION_SCOPES.map((option) => (
          <label
            key={option}
            className={cn(
              "control-focus-within cursor-pointer rounded-edge border px-3 py-1.5 text-sm",
              "transition-colors duration-[var(--t-quick)]",
              "has-[:checked]:border-ember has-[:checked]:bg-[var(--wash-accent)]",
              "has-[:checked]:text-fg-loud",
              "border-line bg-raised text-fg-dim hover:border-line-lit",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option}
              defaultChecked={value === option}
              className="sr-only"
            />
            {SCOPE_LABELS[option]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
