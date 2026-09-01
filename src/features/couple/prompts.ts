/**
 * The daily question.
 *
 * Content, not data — which is why it lives here rather than in a table. Nothing
 * reads or writes these at runtime, they are the same for everybody, and a table
 * would mean an admin surface for something that changes when the writing does.
 *
 * The pick is deterministic from the couple and the date, so both partners
 * compute the same question without coordinating. The database has a unique
 * constraint on (couple, day) as well, so even a disagreement would be harmless
 * — whoever asks first decides.
 */

/** A stable 32-bit hash. Same input, same question, on every device. */
function hash(input: string): number {
  let value = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/**
 * Today's question for a couple.
 *
 * `date` is passed in rather than read from a clock so this stays pure and the
 * suite can ask for any day it likes.
 */
export function promptFor(coupleId: string, date: Date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  return PROMPTS[hash(`${coupleId}:${day}`) % PROMPTS.length]!;
}

/**
 * Questions worth answering separately.
 *
 * The test of a good one is whether the two answers might differ and whether
 * finding that out is interesting rather than awkward. "Do you love me" fails
 * both. Nothing here is a compatibility quiz, a score, or a trap.
 */
export const PROMPTS: string[] = [
  "What's something small the other person did recently that you haven't mentioned?",
  "What would a perfect ordinary Tuesday look like?",
  "What's a thing you'd like to get better at together?",
  "Where would you go if you had four days and no plans?",
  "What's something you've changed your mind about lately?",
  "What do you think the other person worries about most?",
  "What's a habit of yours you think is harmless and they might not?",
  "What's the best thing about how you argue?",
  "What would you want to be doing in five years, on a weekday afternoon?",
  "What's something you'd like to be asked more often?",
  "What's a memory from the past year you'd keep if you could only keep one?",
  "What's the last thing that made you laugh out loud?",
  "What would you want the other person to do if you were quiet for a whole day?",
  "What's something you find easy that they find hard?",
  "What's a thing you own that you'd be sad to lose?",
  "What do you do when you need looking after, and do they know it?",
  "What's an opinion of theirs you've come round to?",
  "What's a small thing that would make next week better?",
  "What's the nicest thing anybody has said about the two of you?",
  "What's something you'd like to stop doing?",
  "What's a place that means something to you that they've never been?",
  "What did you think of them the first week you knew them?",
  "What's something you'd like to plan properly rather than leave to chance?",
  "What's a food you'd happily eat every day for a year?",
  "What's the thing you're proudest of them for?",
  "What's a question you've been meaning to ask?",
  "What's your favourite way to spend a Sunday evening?",
  "What's something you're looking forward to that you haven't said out loud?",
  "What do you need more of at the moment?",
  "What's a song that reminds you of them?",
];
