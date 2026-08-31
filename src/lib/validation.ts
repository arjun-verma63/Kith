import { z } from "zod";

/**
 * Validation rules shared by more than one feature.
 *
 * A username is validated at signup and again when somebody edits their profile.
 * Two copies of that rule is one copy too many: they drift, and the database
 * constraint ends up refereeing a disagreement between two forms.
 */

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
