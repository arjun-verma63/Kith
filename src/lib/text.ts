/**
 * Message text handling.
 *
 * Two jobs, and they are not the same job.
 *
 * `normaliseMessage` runs on the SERVER, before anything is stored. It decides
 * what is allowed into the database.
 *
 * `segmentText` runs on the CLIENT, at render time. It turns a string into React
 * nodes. Note what it does NOT do: it never produces HTML. React escapes every
 * string it renders, so the only way to introduce an XSS here would be
 * `dangerouslySetInnerHTML`, which appears nowhere near user content. Stripping
 * tags from text that is about to be escaped anyway is theatre; the real defence
 * is never building HTML in the first place.
 */

/**
 * Character ranges stripped from every stored message.
 *
 * Written as code points and assembled at module load rather than typed into a
 * regex literal. Every one of these characters is invisible, so a literal class
 * is a line of source nobody can read, review, or safely edit — and one that a
 * copy-paste through any tool that normalises text will silently corrupt.
 */
const STRIPPED_RANGES: ReadonlyArray<readonly [number, number, string]> = [
  // C0 controls, keeping tab (09) and newline (0A).
  [0x00, 0x08, "C0 controls"],
  [0x0b, 0x1f, "C0 controls"],
  // DEL and the C1 block.
  [0x7f, 0x9f, "DEL and C1 controls"],
  // Zero-width space, non-joiner, joiner, and the LTR/RTL marks. These let one
  // person write a name that renders identically to somebody else's.
  [0x200b, 0x200f, "zero-width and directional marks"],
  // Bidirectional embedding and override — the "Trojan Source" trick, where text
  // displays in an order different from the one it is stored in, so a message
  // can read one way here and another when quoted elsewhere.
  [0x202a, 0x202e, "bidi embedding and override"],
  // Bidirectional isolates, same problem.
  [0x2066, 0x2069, "bidi isolates"],
  // Zero-width no-break space, the byte-order mark in disguise.
  [0xfeff, 0xfeff, "BOM"],
];

const STRIP_PATTERN = new RegExp(
  `[${STRIPPED_RANGES.map(
    ([from, to]) =>
      `\\u${from.toString(16).padStart(4, "0")}-\\u${to.toString(16).padStart(4, "0")}`,
  ).join("")}]`,
  "gu",
);

export const MESSAGE_MAX_LENGTH = 4000;

export interface NormaliseResult {
  ok: boolean;
  value: string;
  reason?: "empty" | "too_long";
}

/** Server-side normalisation. Run before a message is stored, never after. */
export function normaliseMessage(raw: unknown): NormaliseResult {
  if (typeof raw !== "string") return { ok: false, value: "", reason: "empty" };

  const cleaned = raw
    .replace(STRIP_PATTERN, "")
    .replace(/\r\n?/g, "\n")
    // Collapse runs of blank lines. Twenty newlines is a way to take over the
    // viewport, and nobody types it on purpose.
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  if (cleaned.length === 0) return { ok: false, value: "", reason: "empty" };
  if (cleaned.length > MESSAGE_MAX_LENGTH) {
    return { ok: false, value: cleaned, reason: "too_long" };
  }

  return { ok: true, value: cleaned };
}

export type TextSegment =
  { type: "text"; value: string } | { type: "link"; value: string; href: string };

/**
 * Splits a message into plain text and links, for rendering as React nodes.
 *
 * The scheme allowlist is the whole security story: only `http` and `https`
 * produce a link. `javascript:` and `data:` fall through and stay text, which is
 * what makes this safe even though the result ends up in an `href`.
 *
 * Deliberately conservative about what counts as a URL — it must carry a scheme.
 * Auto-linking bare `example.com` means auto-linking `e.g` and `node.js`, and a
 * chat that turns half of what you type into links is worse than one that turns
 * none of it.
 */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()[\]{}"']+/gi;

export function segmentText(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    const raw = match[0];
    if (start === undefined) continue;

    // Trailing punctuation belongs to the sentence, not the URL.
    const trimmed = raw.replace(/[.,;:!?]+$/, "");

    let href: string;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      href = url.toString();
    } catch {
      continue;
    }

    if (start > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, start) });
    }

    segments.push({ type: "link", value: trimmed, href });
    lastIndex = start + trimmed.length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }

  return segments;
}

/** Short, human time for a message row. */
export function formatMessageTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** The divider between days in a thread. */
export function formatDayDivider(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const days = Math.floor(
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) /
      86_400_000,
  );

  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString("en-GB", { weekday: "long" });
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
}
