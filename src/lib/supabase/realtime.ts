/**
 * Realtime channel topics.
 *
 * A channel name is a security boundary, not a string. Subscription to a private
 * channel is authorised by Row Level Security policies on `realtime.messages`,
 * matched against the topic — so a typo here is not a bug that shows up as
 * "events are missing", it is a bug that shows up as either silence or, worse,
 * a channel nobody wrote a policy for.
 *
 * Building every topic through this module means the policies and the client
 * agree by construction, and renaming a channel is one edit rather than a
 * grep-and-pray across the codebase.
 *
 * The taxonomy (see docs/ARCHITECTURE.md §6):
 *
 *   user:{userId}          personal bus — incoming calls, friend requests,
 *                          notifications, and the private half of game state
 *   presence:lobby         who is around, and what they are doing
 *   conv:{conversationId}  message events, typing, read cursors
 *   call:{callId}          SDP, ICE, media state, hangup
 *   game:{sessionId}       public game state and phase
 *
 * Durability rule, applied per payload rather than per channel: anything that
 * must survive a refresh is written to Postgres and broadcast by a trigger.
 * Anything transient — typing dots, ICE candidates, countdown ticks — is
 * broadcast only and never touches disk.
 */

export const channels = {
  /** Private to one person. Everything addressed *to* a user arrives here. */
  user: (userId: string) => `user:${userId}` as const,

  /** Group presence. One channel; there are six of us. */
  presence: () => "presence:lobby" as const,

  conversation: (conversationId: string) => `conv:${conversationId}` as const,

  call: (callId: string) => `call:${callId}` as const,

  game: (sessionId: string) => `game:${sessionId}` as const,
} as const;

export type ChannelTopic = ReturnType<(typeof channels)[keyof typeof channels]>;

/**
 * Every channel KITH opens is private, which means subscription is checked
 * against `realtime.messages` policies rather than being open to anyone holding
 * the anon key. Passing this config explicitly at every subscription site is
 * deliberate: `config: { private: true }` is the difference between an
 * authorised channel and a public one, and it is not a good default to forget.
 */
export const PRIVATE_CHANNEL = { config: { private: true } } as const;

/**
 * Throttle for high-frequency broadcasts.
 *
 * ICE candidates during call setup and per-tick game input are the two things
 * capable of exhausting the free tier's monthly message allowance. Both batch on
 * this interval instead of sending per event — designed in now, because
 * retrofitting a throttle after the fact means rewriting the signalling path.
 */
export const BROADCAST_BATCH_MS = 200;
