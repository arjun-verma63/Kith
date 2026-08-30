import type { AuthError, PostgrestError } from "@supabase/supabase-js";

import { err, type AppError, type AppErrorCode, type Err } from "@/lib/result";

/**
 * The bridge between Supabase failures and `Result`.
 *
 * Two jobs, and the second one is the important one.
 *
 * **Classify.** A Postgres error code carries real meaning — a unique violation
 * is a conflict the user can fix, an RLS denial is a permission problem, a
 * foreign-key violation is our bug. Collapsing them all into "something went
 * wrong" throws that away.
 *
 * **Do not leak.** Raw database errors are wonderfully descriptive: constraint
 * names, column names, sometimes the offending value. All of it is internal
 * schema detail and none of it belongs in front of a user. So the message a
 * caller gets back is written by us, and the original is logged server-side.
 *
 * A note on RLS: a policy that denies a *read* does not raise an error, it
 * returns zero rows — which is the correct behaviour (it does not confirm the
 * row exists) and is why "not found" and "not allowed" are frequently the same
 * response. Denied *writes* do raise, as code 42501.
 */

const CODE_MAP: Record<string, { code: AppErrorCode; message: string }> = {
  // Unique violation.
  "23505": { code: "conflict", message: "That already exists." },
  // Foreign key violation — referencing something that is not there.
  "23503": { code: "validation", message: "That refers to something that no longer exists." },
  // Not-null violation.
  "23502": { code: "validation", message: "Something required was missing." },
  // Check constraint violation.
  "23514": { code: "validation", message: "That value is not allowed." },
  // Insufficient privilege — an RLS policy refused a write.
  "42501": { code: "forbidden", message: "You do not have access to that." },
  // No rows returned from a single-row query.
  PGRST116: { code: "not_found", message: "Not found." },
  // JWT expired.
  PGRST301: { code: "unauthenticated", message: "Your session expired. Sign in again." },
};

export function fromPostgrestError(error: PostgrestError, context: string): Err<AppError> {
  const mapped = CODE_MAP[error.code];

  // The full error, including schema detail, goes to the server log and nowhere
  // near the response.
  console.error(`[kith:db] ${context}`, {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
  });

  if (mapped) {
    return err<AppError>({ code: mapped.code, message: mapped.message });
  }

  return err<AppError>({
    code: "unknown",
    message: "Something went wrong on our end. Try again in a moment.",
  });
}

export function fromAuthError(error: AuthError, context: string): Err<AppError> {
  console.error(`[kith:auth] ${context}`, { status: error.status, message: error.message });

  // Auth messages are deliberately vague across the board. "No account with that
  // email" is a free account-enumeration oracle, and on an invitation-only app it
  // also leaks who is a member.
  switch (error.status) {
    case 400:
    case 401:
      return err<AppError>({
        code: "unauthenticated",
        message: "Those details did not work. Check them and try again.",
      });
    case 403:
      return err<AppError>({ code: "forbidden", message: "You do not have access to that." });
    case 422:
      return err<AppError>({ code: "validation", message: "Those details are not valid." });
    case 429:
      return err<AppError>({
        code: "rate_limited",
        message: "Too many attempts. Wait a minute and try again.",
      });
    default:
      return err<AppError>({
        code: "unknown",
        message: "Something went wrong signing you in. Try again in a moment.",
      });
  }
}
