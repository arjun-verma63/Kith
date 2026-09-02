/** Stands in for `@/lib/supabase/server`. */
export { createSupabaseServerClient } from "./registry.mjs";

export async function getCurrentUser() {
  const { plan } = await import("./registry.mjs");
  return plan.currentUser ?? null;
}
