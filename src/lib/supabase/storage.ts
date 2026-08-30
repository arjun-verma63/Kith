/**
 * Storage buckets.
 *
 * All three are **private**. There are no public buckets in KITH and there
 * should never be one: a public bucket means a URL that works for anyone who
 * ever sees it, forever, with no relationship to who is allowed to read the row
 * that referenced it. Files are served through short-lived signed URLs instead.
 *
 * Access is governed by policies on `storage.objects`, written against the path
 * convention below. Putting the owner or the conversation id in the *first* path
 * segment is what makes those policies expressible — `(storage.foldername(name))[1]`
 * is the handle a policy has, so the path layout is a security decision rather
 * than a filing preference.
 *
 * Buckets and their policies are created by migration, alongside the tables they
 * belong to. Nothing here creates anything; this is the registry the rest of the
 * app names buckets through, so a typo is a compile error rather than a
 * mysterious 404.
 */

export const BUCKETS = {
  /**
   * Profile pictures. Path: `{userId}/{fileName}`.
   * Owner may write their own prefix; any signed-in user may read (Phase 4).
   * Resized on upload, so nothing large is ever stored.
   */
  avatars: "avatars",

  /**
   * Message attachments. Path: `{conversationId}/{messageId}/{fileName}`.
   * Readable only by conversation members — the same `is_conversation_member()`
   * helper the messages table uses, so the file and the row it hangs off cannot
   * disagree about who is allowed to see them.
   */
  attachments: "attachments",

  /**
   * Couple-scoped media. Path: `{coupleId}/{fileName}`.
   * Readable only by the two members of an active couple.
   */
  couple: "couple",
} as const;

export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

/**
 * Signed URL lifetime, in seconds.
 *
 * Long enough that an image does not expire while someone is reading a
 * conversation; short enough that a URL pasted elsewhere stops working quickly.
 * Signed URLs are bearer tokens — anyone holding one can read the file until it
 * expires, regardless of the policies above.
 */
export const SIGNED_URL_TTL_SECONDS = 60 * 10;

/** Upload ceilings, enforced client-side for feedback and in policy for real. */
export const UPLOAD_LIMITS = {
  avatar: { bytes: 2 * 1024 * 1024, mimeTypes: ["image/jpeg", "image/png", "image/webp"] },
  attachment: {
    bytes: 10 * 1024 * 1024,
    mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"],
  },
} as const;

/** Path builders. The first segment is what the storage policies key on. */
export const storagePath = {
  avatar: (userId: string, fileName: string) => `${userId}/${fileName}`,
  attachment: (conversationId: string, messageId: string, fileName: string) =>
    `${conversationId}/${messageId}/${fileName}`,
  couple: (coupleId: string, fileName: string) => `${coupleId}/${fileName}`,
} as const;
