import { redirect } from "next/navigation";

/**
 * `/settings` on its own is not a page.
 *
 * Every section is a real destination, so the index would either be an empty
 * shell or a duplicate menu next to the one already in the rail. Profile is
 * where people arrive expecting to be.
 */
export default function SettingsIndex() {
  redirect("/settings/profile");
}
