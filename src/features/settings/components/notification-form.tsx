"use client";

import { useActionState } from "react";

import { FormBanner } from "@/components/ui/form";
import { saveNotificationsAction } from "@/features/settings/actions";
import {
  RowDivider,
  SaveBar,
  SettingsCard,
  ToggleRow,
} from "@/features/settings/components/controls";
import { NOTIFICATION_LABELS, type NotificationPreferences } from "@/features/settings/preferences";
import { idleFormState } from "@/lib/forms";

/**
 * Notifications.
 *
 * Switching one off actually stops the row being written. Migration 0027 puts a
 * BEFORE INSERT trigger on `notifications` that drops what the recipient has
 * turned off — one gate rather than teaching each of the seven trigger functions
 * to consult a preference, which would be seven places to get right and one to
 * forget in six months.
 *
 * Dropped rather than raised, so the action that caused it still succeeds:
 * muting game invitations does not stop anybody starting a game.
 *
 * There is no toggle for the `system` kind, and there will not be. That is how
 * the app says something that is not about another person — an account action, a
 * service notice — and a preference that can silence it is a preference that
 * hides the one message somebody needs to see.
 */
export function NotificationForm({ settings }: { settings: NotificationPreferences }) {
  const [state, formAction] = useActionState(saveNotificationsAction, idleFormState);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormBanner state={state} />

      <SettingsCard
        title="What reaches you"
        description="These are the notifications inside KITH — the bell in the header. Nothing here sends email."
      >
        {NOTIFICATION_LABELS.map((kind, index) => (
          <div key={kind.key}>
            {index > 0 ? <RowDivider /> : null}
            <ToggleRow
              name={kind.key}
              label={kind.label}
              help={kind.help}
              defaultChecked={settings[kind.key]}
            />
          </div>
        ))}
      </SettingsCard>

      <p className="max-w-prose px-1 text-2xs leading-body text-fg-faint">
        Anything about your own account — a sign-in from somewhere new, a change to your security
        settings — always reaches you. There is no switch for that one on purpose.
      </p>

      <SaveBar />
    </form>
  );
}
