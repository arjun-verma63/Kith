import { z } from "zod";

import type { Json } from "@/types/database";

/**
 * Game configuration — the options a game is opened with.
 *
 * `game_sessions.config` has existed since migration 0007 and has been an empty
 * object ever since. Guess My Answer is the first game that wants something in
 * it: the pair choose which category of questions they are in the mood for
 * before the game starts, and that choice has to survive the round trip.
 *
 * ── Why this is in lib/ rather than in the games slice ───────────────────────
 *
 * Two slices need the same vocabulary. The picker lives on the **couple** page,
 * because that is where a couple game is opened; the engine that reads the
 * choice lives in **games**. A feature may not import another feature, and the
 * right answer to that is not to duplicate a list of four strings in two places
 * where they can drift apart — it is to put the vocabulary somewhere neither
 * owns.
 *
 * ── Config is opaque to the database, on purpose ─────────────────────────────
 *
 * Postgres stores it as jsonb and never looks inside. A database that
 * understood a game's options would be a database that needed a migration every
 * time a game gained one.
 *
 * Which means the whitelisting has to happen here, at the action boundary,
 * before an arbitrary object from a browser is written to a row that is then
 * broadcast to both players on every state change. Three layers, each doing the
 * part it can:
 *
 *   1. THIS FILE drops keys nobody asked for and values out of range.
 *   2. `create_couple_game` refuses a config over 2 KB — a size limit is the one
 *      thing SQL can enforce without knowing what any of it means.
 *   3. THE ENGINE treats config as a suggestion: an unknown category is
 *      filtered out and an absent one means "all of them". A game that trusts
 *      its config to be well-formed is a game one migration away from crashing
 *      on a session created by an older client.
 */

/* ------------------------------------------------------ guess my answer */

export const GUESS_MY_ANSWER_CATEGORY_KEYS = ["tender", "petty", "wild", "past"] as const;

export type GuessMyAnswerCategory = (typeof GUESS_MY_ANSWER_CATEGORY_KEYS)[number];

/**
 * What the picker offers, and what the board labels a round with.
 *
 * The categories are not decoration — `petty` and `tender` produce genuinely
 * different evenings, and choosing between them is part of deciding what kind of
 * evening this is.
 */
export const GUESS_MY_ANSWER_CATEGORIES: {
  key: GuessMyAnswerCategory;
  name: string;
  blurb: string;
}[] = [
  { key: "tender", name: "Tender", blurb: "The soft ones." },
  { key: "petty", name: "Petty", blurb: "Small, honest, slightly damning." },
  { key: "wild", name: "Wild", blurb: "Nonsense and hypotheticals." },
  { key: "past", name: "Past", blurb: "Where you have both been." },
];

const guessMyAnswerConfig = z.object({
  categories: z.array(z.enum(GUESS_MY_ANSWER_CATEGORY_KEYS)).min(1).max(4).optional(),
  rounds: z.number().int().min(2).max(20).optional(),
});

/* ------------------------------------------------------------------ all */

const CONFIG_SCHEMAS: Record<string, z.ZodType<Record<string, unknown>>> = {
  "guess-my-answer": guessMyAnswerConfig,
};

/**
 * Everything a game may be opened with, and nothing else.
 *
 * A game with no schema takes no configuration, and an unparseable config
 * becomes an empty one rather than an error: every option here has a sensible
 * default, so a malformed request should open a playable game rather than
 * refuse. There is nothing a caller can put in this object that changes who is
 * allowed to do what — that is all decided in SQL — so failing soft costs
 * nothing.
 */
export function parseGameConfig(gameKey: string, raw: unknown): Record<string, Json> {
  const schema = CONFIG_SCHEMAS[gameKey];
  if (!schema) return {};

  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) return {};

  // An option the caller left out should be absent, not present-and-undefined:
  // `{ rounds: undefined }` survives into the jsonb as a key the engine then has
  // to tell apart from a real choice.
  return Object.fromEntries(
    Object.entries(parsed.data).filter((entry): entry is [string, Json] => entry[1] !== undefined),
  );
}
