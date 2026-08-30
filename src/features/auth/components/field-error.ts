import type { AuthFormState } from "@/features/auth/schema";

/**
 * Pulls one field's first error out of the form state.
 *
 * Only the first: stacking three messages under a single input is noise, and the
 * first failure is almost always the one worth fixing. The rest reappear on the
 * next submit if they still apply.
 */
export function fieldError(state: AuthFormState, name: string): string | undefined {
  if (state.status !== "error") return undefined;
  return state.fieldErrors?.[name]?.[0];
}
