"use server";

import { revalidatePath } from "next/cache";

import {
  appearanceSchema,
  notificationSchema,
  NOTIFICATION_KINDS,
  privacySchema,
} from "@/features/settings/preferences";
import { toFieldErrors, type FormState } from "@/lib/forms";
import { createSupabaseServerClient, getCurrentUser } from "@/lib/supabase/server";
import type { TablesUpdate } from "@/types/supabase";

/**
 * Writing `user_settings`.
 *
 * Three actions rather than one, split the way the page is split: somebody
 * saving their theme should not have their privacy scopes rewritten by whatever
 * happened to be in the DOM. Each one updates only its own columns.
 *
 * All three go through the caller's own client, so `user_settings_update_own` is
 * what limits them to their row — never a `.eq("user_id", ...)` we could forget.
 * The `.eq` below is a filter for the update, not the authorisation.
 */

function invalid(fieldErrors: Record<string, string[]>): FormState {
  return { status: "error", message: "Check the highlighted fields.", fieldErrors };
}

async function saveColumns(values: TablesUpdate<"user_settings">): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) return { status: "error", message: "Sign in again." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("user_settings").update(values).eq("user_id", user.id);

  if (error) {
    console.error("[kith:settings] save failed", { code: error.code });
    return { status: "error", message: "That could not be saved." };
  }

  return { status: "success", message: "Saved." };
}

/* ------------------------------------------------------------------ privacy */

/**
 * Every one of these is read by a SQL function that decides what other people
 * may do, except `typing_indicators` — see PRIVACY_CONTROLS. Saving them is a
 * change to policy input, not to a display preference.
 */
export async function savePrivacyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = privacySchema.safeParse({
    discoverable: formData.get("discoverable") === "on",
    whoCanMessage: formData.get("whoCanMessage"),
    whoCanCall: formData.get("whoCanCall"),
    whoCanPropose: formData.get("whoCanPropose"),
    showBirthday: formData.get("showBirthday"),
    typingIndicators: formData.get("typingIndicators") === "on",
  });

  if (!parsed.success) return invalid(toFieldErrors(parsed.error));

  const result = await saveColumns({
    discoverable: parsed.data.discoverable,
    who_can_message: parsed.data.whoCanMessage,
    who_can_call: parsed.data.whoCanCall,
    who_can_propose: parsed.data.whoCanPropose,
    show_birthday: parsed.data.showBirthday,
    typing_indicators: parsed.data.typingIndicators,
  });

  revalidatePath("/settings/privacy");
  // The birthday scope changes what a profile renders, and the couple page has
  // its own copy of who_can_propose.
  revalidatePath("/u", "layout");
  revalidatePath("/couple");

  return result;
}

/* ------------------------------------------------------------ notifications */

/**
 * Written as an explicit `false` for anything switched off and nothing at all
 * for anything left on.
 *
 * Storing `true` would work too, but the absent-means-on convention is what lets
 * the column stay `{}` for everybody who never opens this page — and
 * `notification_enabled` in migration 0027 reads it the same way. Two places
 * agreeing about a default is worth the small asymmetry.
 */
export async function saveNotificationsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = notificationSchema.safeParse(
    Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, formData.get(kind) === "on"])),
  );

  if (!parsed.success) return invalid(toFieldErrors(parsed.error));

  const prefs = Object.fromEntries(
    NOTIFICATION_KINDS.filter((kind) => !parsed.data[kind]).map((kind) => [kind, false]),
  );

  const result = await saveColumns({ notification_prefs: prefs });
  revalidatePath("/settings/notifications");
  return result;
}

/* -------------------------------------------------------------- appearance */

/**
 * The header's Dusk/Daylight switch, persisted.
 *
 * The button flips the attribute and writes localStorage itself, so the change
 * is instant and does not wait for this. This is the part that makes the flip
 * survive to another device — fire-and-forget from the client, and a failure
 * costs the person nothing they will notice this session.
 *
 * Takes the resolved value rather than a toggle instruction: the client already
 * knows which way it went, and "invert whatever is stored" would fight a second
 * tab that flipped it first.
 */
export async function setThemeAction(theme: string): Promise<void> {
  const parsed = appearanceSchema.shape.theme.safeParse(theme);
  if (!parsed.success) return;

  await saveColumns({ theme: parsed.data });
  revalidatePath("/settings/appearance");
}

export async function saveAppearanceAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = appearanceSchema.safeParse({
    theme: formData.get("theme"),
    motion: formData.get("motion"),
  });

  if (!parsed.success) return invalid(toFieldErrors(parsed.error));

  const result = await saveColumns({ theme: parsed.data.theme, motion: parsed.data.motion });

  // The shell reads these to paint the page, so every signed-in route is now
  // rendering with the old ones.
  revalidatePath("/", "layout");

  return result;
}
