"use server";

import { revalidatePath } from "next/cache";

import {
  isOwnAvatarPath,
  parseBirthdayFields,
  profileSchema,
  toDateString,
} from "@/features/profile/schema";
import { toFieldErrors, type FormState } from "@/lib/forms";
import { fromPostgrestError } from "@/lib/supabase/errors";
import { BUCKETS } from "@/lib/supabase/storage";
import { createSupabaseServerClient, getCurrentUser } from "@/lib/supabase/server";

/**
 * Profile mutations.
 *
 * All of these use the cookie-bound client, never the admin client. That is the
 * point: a person editing their own profile is exactly what
 * `profiles_update_own` describes, so the database is already enforcing it and
 * reaching for the service role would only remove the safety net.
 *
 * Note what is NOT sent in any update below: `last_seen_at`, `created_at`, `id`,
 * `username_changed_at`. Those are pinned by a trigger, so a hand-crafted
 * request cannot move them either — the omission here is tidiness, the trigger
 * is the guarantee.
 */

type State = FormState;

function invalid(fieldErrors: Record<string, string[]>): State {
  return { status: "error", message: "Check the highlighted fields.", fieldErrors };
}

export async function updateProfileAction(_prev: State, formData: FormData): Promise<State> {
  const user = await getCurrentUser();
  if (!user) return { status: "error", message: "Sign in again to save changes." };

  const birthday = parseBirthdayFields(
    formData.get("birthdayDay"),
    formData.get("birthdayMonth"),
    formData.get("birthdayYear"),
  );

  if (!birthday.ok) {
    return invalid({ birthday: ["Give a full date, or leave all three blank."] });
  }

  const parsed = profileSchema.safeParse({
    username: formData.get("username"),
    displayName: formData.get("displayName"),
    bio: formData.get("bio") ?? "",
    pronouns: formData.get("pronouns") ?? "",
    accent: formData.get("accent"),
    status: formData.get("status"),
    statusText: formData.get("statusText") ?? "",
    birthday: birthday.value,
  });

  if (!parsed.success) return invalid(toFieldErrors(parsed.error));

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from("profiles")
    .update({
      username: input.username,
      display_name: input.displayName,
      bio: input.bio === "" ? null : input.bio,
      pronouns: input.pronouns === "" ? null : input.pronouns,
      accent: input.accent,
      status: input.status,
      status_text: input.statusText === "" ? null : input.statusText,
      birthday: input.birthday ? toDateString(input.birthday) : null,
    })
    .eq("id", user.id);

  if (error) {
    // The unique index and the cooldown trigger both surface here, and both
    // deserve a message about the field rather than a generic failure.
    if (error.code === "23505") {
      return invalid({ username: ["That username is taken."] });
    }
    if (error.message.includes("username_cooldown")) {
      return invalid({
        username: ["A username can only be changed once every 30 days."],
      });
    }

    return { ...fromPostgrestError(error, "updateProfile").error, status: "error" } as State;
  }

  revalidatePath("/settings/profile");
  revalidatePath(`/u/${input.username}`);

  return { status: "success", message: "Saved." };
}

/**
 * Points the profile at a newly uploaded avatar.
 *
 * The file itself was uploaded straight from the browser to Storage, where the
 * bucket policy already restricted it to the uploader's own folder. This records
 * the path and cleans up the previous object.
 *
 * The path is re-checked against the session here anyway. Storage would refuse a
 * write outside the caller's folder, but this action does not write to Storage —
 * it writes to `profiles`, and without the check a crafted request could point
 * somebody's avatar at any object in the bucket.
 */
export async function setAvatarAction(_prev: State, formData: FormData): Promise<State> {
  const user = await getCurrentUser();
  if (!user) return { status: "error", message: "Sign in again to change your picture." };

  const path = formData.get("path");
  if (typeof path !== "string" || !isOwnAvatarPath(path, user.id)) {
    return { status: "error", message: "That upload did not look right. Try again." };
  }

  const supabase = await createSupabaseServerClient();

  const { data: existing } = await supabase
    .from("profiles")
    .select("avatar_path")
    .eq("id", user.id)
    .maybeSingle();

  const { error } = await supabase.from("profiles").update({ avatar_path: path }).eq("id", user.id);

  if (error) {
    return { ...fromPostgrestError(error, "setAvatar").error, status: "error" } as State;
  }

  // Remove the old object only after the new one is recorded. The other order
  // leaves a profile pointing at a file that no longer exists if the update
  // fails, which renders as a permanently broken image.
  if (existing?.avatar_path && existing.avatar_path !== path) {
    await supabase.storage.from(BUCKETS.avatars).remove([existing.avatar_path]);
  }

  revalidatePath("/settings/profile");
  return { status: "success", message: "Picture updated." };
}

export async function removeAvatarAction(_prev: State, _formData: FormData): Promise<State> {
  const user = await getCurrentUser();
  if (!user) return { status: "error", message: "Sign in again to change your picture." };

  const supabase = await createSupabaseServerClient();

  const { data: existing } = await supabase
    .from("profiles")
    .select("avatar_path")
    .eq("id", user.id)
    .maybeSingle();

  const { error } = await supabase.from("profiles").update({ avatar_path: null }).eq("id", user.id);

  if (error) {
    return { ...fromPostgrestError(error, "removeAvatar").error, status: "error" } as State;
  }

  if (existing?.avatar_path) {
    await supabase.storage.from(BUCKETS.avatars).remove([existing.avatar_path]);
  }

  revalidatePath("/settings/profile");
  return { status: "success", message: "Picture removed." };
}

/**
 * Presence heartbeat.
 *
 * Called by the client on an interval and when a tab regains focus. The
 * throttle lives in the database function, not here: a client is free to call
 * this every second and it will still write at most once a minute.
 */
export async function touchLastSeenAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.rpc("touch_last_seen");
}
