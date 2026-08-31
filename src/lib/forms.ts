import type { z } from "zod";

/**
 * What a form gets back from a server action.
 *
 * In `lib/` because auth, profile and friends all return it, and a shared type
 * that lives inside one of them makes the other two depend on that feature for
 * no reason.
 *
 * `fieldErrors` is keyed by input name so each message renders against the field
 * it belongs to and can be wired to it with `aria-describedby`, rather than
 * being dumped in a banner for the user to match up themselves.
 */
export type FormState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> }
  | { status: "success"; message: string };

export const idleFormState: FormState = { status: "idle" };

/** Turns a Zod failure into field-keyed messages. */
export function toFieldErrors(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key !== "string") continue;
    (fieldErrors[key] ??= []).push(issue.message);
  }

  return fieldErrors;
}

/**
 * One field's first error.
 *
 * Only the first: stacking three messages under a single input is noise, and the
 * first failure is almost always the one worth fixing. The rest reappear on the
 * next submit if they still apply.
 */
export function fieldError(state: FormState, name: string): string | undefined {
  if (state.status !== "error") return undefined;
  return state.fieldErrors?.[name]?.[0];
}
