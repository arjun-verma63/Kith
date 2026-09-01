import "server-only";

import {
  readNotificationPrefs,
  type MotionPreference,
  type PermissionScope,
  type Preferences,
  type ThemePreference,
} from "@/features/settings/preferences";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The one read of `user_settings`.
 *
 * Scoped by the `user_settings_select_own` policy rather than by a `where`
 * clause here — the row is the caller's or it does not come back.
 *
 * A missing row is not an error. `user_settings` is created by the signup
 * trigger, but a page that falls over because a row is absent is a page that
 * falls over during a migration, so the defaults below match the column
 * defaults exactly.
 */

const scope = (value: string | null | undefined): PermissionScope =>
  value === "everyone" || value === "nobody" ? value : "friends";

export async function getPreferences(): Promise<Preferences> {
  const supabase = await createSupabaseServerClient();

  const { data } = await supabase
    .from("user_settings")
    .select(
      "discoverable, who_can_message, who_can_call, who_can_propose, show_birthday, typing_indicators, notification_prefs, theme, motion",
    )
    .maybeSingle();

  return {
    discoverable: data?.discoverable ?? true,
    whoCanMessage: scope(data?.who_can_message),
    whoCanCall: scope(data?.who_can_call),
    whoCanPropose: scope(data?.who_can_propose),
    showBirthday: scope(data?.show_birthday),
    typingIndicators: data?.typing_indicators ?? true,
    notifications: readNotificationPrefs(data?.notification_prefs),
    theme: (data?.theme ?? "dusk") as ThemePreference,
    motion: (data?.motion ?? "full") as MotionPreference,
  };
}

/**
 * Just the two the shell needs to paint with.
 *
 * Split out because the app layout runs on every signed-in page and has no use
 * for the other seven columns — and because a layout that reads the whole
 * settings row is a layout somebody will later be tempted to pass around.
 */
export async function getAppearance(): Promise<{
  theme: ThemePreference;
  motion: MotionPreference;
}> {
  const supabase = await createSupabaseServerClient();

  const { data } = await supabase.from("user_settings").select("theme, motion").maybeSingle();

  return {
    theme: (data?.theme ?? "dusk") as ThemePreference,
    motion: (data?.motion ?? "full") as MotionPreference,
  };
}
