import { z } from "zod";

/**
 * The safety vocabulary.
 *
 * Pure and client-safe: the reason list is rendered in a dialog and validated in
 * a server action, and one copy of it is the only way those two agree.
 *
 * ── Why these six ────────────────────────────────────────────────────────────
 *
 * A report reason list is a design decision about what somebody is willing to
 * press. Too many options and the person closes the dialog; too few and they
 * pick the closest wrong one and the report is useless.
 *
 * These are the categories that would change what a human does about it —
 * `threats` is an emergency and `spam` is a shrug — plus `other`, which is
 * required to carry an explanation because a report that says only "other" is a
 * report nobody can act on.
 */

export const REPORT_REASONS = [
  "harassment",
  "threats",
  "spam",
  "impersonation",
  "inappropriate_content",
  "other",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const REASON_LABELS: {
  key: ReportReason;
  label: string;
  help: string;
}[] = [
  {
    key: "harassment",
    label: "Harassment",
    help: "Repeated unwanted contact, insults, or pile-ons.",
  },
  {
    key: "threats",
    label: "Threats or self-harm",
    help: "Somebody is in danger. If it is urgent, contact the emergency services first.",
  },
  { key: "spam", label: "Spam", help: "Unwanted links, scams, or advertising." },
  {
    key: "impersonation",
    label: "Pretending to be somebody",
    help: "Using another person's name, photo or identity.",
  },
  {
    key: "inappropriate_content",
    label: "Content that does not belong here",
    help: "Explicit, hateful, or otherwise not for this room.",
  },
  {
    key: "other",
    label: "Something else",
    help: "Tell us what happened — this one needs a description.",
  },
];

export const DETAIL_MAX = 2000;
export const BLOCK_REASON_MAX = 500;

const reason = z.enum(REPORT_REASONS);

/**
 * A report as submitted.
 *
 * `detail` is required for `other` and optional everywhere else, which is a
 * cross-field rule rather than a per-field one — hence the refine, with the
 * error pinned to the field somebody has to go and fill in.
 */
export const reportSchema = z
  .object({
    reason,
    detail: z.string().trim().max(DETAIL_MAX, `Keep it under ${DETAIL_MAX} characters.`).optional(),
    /** Also block them, from the same dialog. Almost everybody wants this. */
    alsoBlock: z.boolean().default(true),
  })
  .refine((value) => value.reason !== "other" || Boolean(value.detail), {
    message: "Tell us what happened.",
    path: ["detail"],
  });

export const blockReasonSchema = z
  .string()
  .trim()
  .max(BLOCK_REASON_MAX, `Keep it under ${BLOCK_REASON_MAX} characters.`)
  .optional();

/**
 * What a block actually does, in the order it does it.
 *
 * Rendered in the confirmation dialog, and worth being a list rather than a
 * paragraph: blocking severs things people do not expect it to sever, and
 * finding out afterwards that it ended your couple is not a good way to find
 * out. Mirrors `block_user` in migration 0026 exactly.
 */
export const BLOCK_CONSEQUENCES = [
  "They cannot message, call, or invite you to anything.",
  "You will not see each other's profiles, messages or presence.",
  "If you are friends, you will not be any more.",
  "Any pending friend request between you is cancelled.",
  "If you are a couple in KITH, that ends.",
] as const;

/**
 * The sentence under the list.
 *
 * Separate because it is the part people misread: a block is not a pause. The
 * database does not remember what it severed and `unblock_user` deliberately
 * does not try to put it back.
 */
export const UNBLOCK_CAVEAT =
  "Unblocking lets them reach you again. It does not undo any of the above — you would have to become friends again.";
