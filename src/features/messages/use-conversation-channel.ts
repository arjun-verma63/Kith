"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { channels, PRIVATE_CHANNEL, BROADCAST_BATCH_MS } from "@/lib/supabase/realtime";
import { TypingRoster, TypingThrottle } from "@/features/messages/typing";

/**
 * The live half of a conversation.
 *
 * One private channel per open thread, carrying three kinds of traffic:
 *
 *   message.new / message.edited / message.deleted
 *     Broadcast by a database trigger, so a message appears for everyone
 *     whatever wrote it — a server action, a scheduled job, a future bot. A
 *     client that broadcasts its own sends only works when the client is the
 *     only writer, which is true right up until it is not.
 *
 *   reaction.changed
 *     Also from a trigger, for the same reason.
 *
 *   typing
 *     Client-to-client and NEVER stored. A typing indicator is worthless one
 *     second after it is sent, and a row per keystroke is the single easiest way
 *     to turn a chat app into a write-amplified one.
 *
 * Authorization happens at SUBSCRIBE time, through the `conv:{id}` policy on
 * `realtime.messages` (migration 0009). Nothing here checks membership, because
 * a non-member cannot open the channel in the first place.
 */

export interface LiveMessage {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  body: string | null;
  reply_to_id: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

export interface LiveReaction {
  message_id: string;
  user_id: string;
  emoji: string;
  added: boolean;
}

export interface ConversationChannelHandlers {
  onMessage: (message: LiveMessage) => void;
  onReaction: (reaction: LiveReaction) => void;
}

/**
 * How often this browser says "still typing".
 *
 * Five batching windows apart. The receiving side forgets anybody it has not
 * heard from for `TYPING_TTL_MS`, and `typing.test.mjs` asserts this stays
 * comfortably inside that — the two numbers are in different files and a
 * refresh slower than the expiry makes every typist flicker.
 */
const TYPING_REFRESH_MS = BROADCAST_BATCH_MS * 5;

export function useConversationChannel(
  conversationId: string,
  userId: string,
  handlers: ConversationChannelHandlers,
) {
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);

  // Handlers change on every render of the parent; keeping them in a ref means
  // the channel is not torn down and re-subscribed each time, which would drop
  // messages during the gap.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  const channelRef = useRef<ReturnType<
    ReturnType<typeof getSupabaseBrowserClient>["channel"]
  > | null>(null);

  const throttle = useRef<TypingThrottle | null>(null);
  throttle.current ??= new TypingThrottle(TYPING_REFRESH_MS);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    const channel = supabase.channel(channels.conversation(conversationId), PRIVATE_CHANNEL);
    channelRef.current = channel;

    /*
     * The roster owns the expiry; this effect owns exactly one timer for it.
     *
     * Previously there was a timer per person, which meant five typists were
     * five pending callbacks to cancel on unmount — and one missed cancellation
     * is a `setState` on a component that has gone. `nextExpiryIn()` collapses
     * that to a single scheduled prune, rescheduled as people come and go.
     */
    const roster = new TypingRoster(userId);
    let expiryTimer: number | undefined;

    const repaint = () => {
      setTypingUserIds(roster.ids());
      window.clearTimeout(expiryTimer);

      const next = roster.nextExpiryIn();
      if (next !== null) {
        expiryTimer = window.setTimeout(() => {
          roster.prune();
          repaint();
        }, next);
      }
    };

    const onTyping = ({ payload }: { payload: { userId?: string } }) => {
      // A repaint only when the visible set actually changes — the second
      // keystroke of somebody already listed changes nothing anybody can see.
      if (roster.note(payload?.userId)) repaint();
    };

    channel
      .on("broadcast", { event: "message.new" }, ({ payload }) =>
        handlersRef.current.onMessage(payload as LiveMessage),
      )
      .on("broadcast", { event: "message.edited" }, ({ payload }) =>
        handlersRef.current.onMessage(payload as LiveMessage),
      )
      .on("broadcast", { event: "message.deleted" }, ({ payload }) =>
        handlersRef.current.onMessage(payload as LiveMessage),
      )
      .on("broadcast", { event: "reaction.changed" }, ({ payload }) =>
        handlersRef.current.onReaction(payload as LiveReaction),
      )
      .on("broadcast", { event: "typing" }, onTyping)
      .subscribe((status) => {
        setConnected(status === "SUBSCRIBED");
      });

    return () => {
      window.clearTimeout(expiryTimer);
      roster.clear();
      setTypingUserIds([]);
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [conversationId, userId]);

  /**
   * Announces that this person is typing.
   *
   * Throttled to one broadcast per `BROADCAST_BATCH_MS`, so holding a key down
   * is one message rather than sixty. The receiver's four-second expiry is what
   * makes a sparse signal enough.
   */
  const sendTyping = useCallback(() => {
    if (!throttle.current?.shouldSend()) return;

    void channelRef.current?.send({
      type: "broadcast",
      event: "typing",
      payload: { userId },
    });
  }, [userId]);

  return { typingUserIds, connected, sendTyping };
}
