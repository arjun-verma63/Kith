import { z } from "zod";

/**
 * Validation for every authentication input.
 *
 * The same schemas run on the client (for immediate feedback) and on the server
 * (where it actually counts). Client-side validation is a courtesy; a server
 * action must assume the form was never rendered.
 *
 * Password policy follows current NIST guidance: length carries the strength,
 * composition rules do not. Forcing a symbol and a digit reliably produces
 * `Password1!` and a sticky note. So: a 12-character floor, a 72-byte ceiling
 * because that is where bcrypt silently truncates, and no character classes.
 */

export const emailSchema = z
  .string()
  .trim()
  .min(1, "Enter your email address.")
  .max(254, "That email address is too long.")
  .pipe(z.email("That does not look like an email address."))
  .transform((value) => value.toLowerCase());

export const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters. Length matters more than symbols.")
  .refine((value) => new TextEncoder().encode(value).length <= 72, {
    message: "That password is too long. Keep it under 72 bytes.",
  })
  .refine((value) => value.trim().length > 0, {
    message: "A password cannot be only spaces.",
  });

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "At least 3 characters.")
  .max(20, "At most 20 characters.")
  .regex(/^[A-Za-z0-9_]+$/, "Letters, numbers and underscores only.")
  .refine((value) => !/^\d+$/.test(value), {
    message: "A username cannot be only numbers.",
  });

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Tell us what to call you.")
  .max(40, "That is a bit long — 40 characters at most.");

/** Invite codes are compared by hash; the shape check is only to catch typos. */
export const inviteCodeSchema = z
  .string()
  .trim()
  .min(6, "That code looks too short.")
  .max(64, "That code looks too long.");

/* -------------------------------------------------------------------------- */

export const signInSchema = z.object({
  email: emailSchema,
  // Not `passwordSchema`: an existing account may predate a policy change, and
  // rejecting a correct password because it is 11 characters would lock somebody
  // out of their own room. Length rules belong on the way in, not on the way back.
  password: z.string().min(1, "Enter your password."),
  redirectTo: z.string().optional(),
});

export const signUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  username: usernameSchema,
  displayName: displayNameSchema,
  // Optional in the schema because the very first account in an empty room does
  // not need one. The server decides whether that applies — never the client.
  inviteCode: z.union([inviteCodeSchema, z.literal("")]).optional(),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Those two passwords do not match.",
    path: ["confirmPassword"],
  });

export type SignInInput = z.infer<typeof signInSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/* -------------------------------------------------------------------------- */

/**
 * What a form gets back from a server action.
 *
 * `fieldErrors` is keyed by input name so each message can be rendered against
 * the field it belongs to and wired to it with `aria-describedby`, rather than
 * dumped in a banner at the top and left for the user to match up.
 */
export type AuthFormState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> }
  | { status: "success"; message: string };

export const idleFormState: AuthFormState = { status: "idle" };

/** Turns a Zod failure into field-keyed messages for the form. */
export function toFieldErrors(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key !== "string") continue;
    (fieldErrors[key] ??= []).push(issue.message);
  }

  return fieldErrors;
}
