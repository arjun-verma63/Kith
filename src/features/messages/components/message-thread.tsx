"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { Icon } from "@/components/ui/icon";
import { Pulse } from "@/components/ui/skeleton";
import {
  loadOlderMessagesAction,
  markReadAction,
  refreshMessagesAction,
  sendMessageAction,
} from "@/features/messages/actions";
import { MessageBubble } from "@/features/messages/components/message-bubble";
import type { Message, MessagePage } from "@/features/messages/queries";
import {
  useConversationChannel,
  type LiveMessage,
} from "@/features/messages/use-conversation-channel";
import { formatDayDivider, MESSAGE_MAX_LENGTH, normaliseMessage } from "@/lib/text";
import { cn } from "@/lib/utils/cn";

/**
 * The thread.
 *
 * Rendered in reverse: `flex-col-reverse` with the newest message first in the
 * DOM. That means the browser pins the scroll to the BOTTOM for free — new
 * messages appear without a scroll calculation, and loading older ones at the
 * top does not jump the viewport, because the anchor is at the other end. Doing
 * this the obvious way round means manually restoring scroll offset after every
 * prepend, and getting it wrong by a few pixels on every page.
 *
 * The initial page is server-rendered and handed in; everything after that
 * arrives over the channel or from a paged fetch.
 */
export function MessageThread({
  conversationId,
  currentUserId,
  initial,
  memberNames,
}: {
  conversationId: string;
  currentUserId: string;
  initial: MessagePage;
  memberNames: Record<string, string>;
}) {
  const [messages, setMessages] = useState<Message[]>(initial.messages);
  const [cursor, setCursor] = useState(initial.cursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [, startTransition] = useTransition();
  const topSentinel = useRef<HTMLDivElement>(null);

  /**
   * Re-reads the newest page.
   *
   * Used after a reaction or a delete, where the broadcast carries a delta and
   * recomputing the aggregate locally would mean duplicating the SQL that
   * produced it. Deliberately NOT used for new messages — those arrive over the
   * channel and applying them locally is the whole point of the channel.
   */
  const refresh = useCallback(() => {
    startTransition(async () => {
      const page = await refreshMessagesAction(conversationId);
      setMessages(page.messages);
      setCursor(page.cursor);
    });
  }, [conversationId]);

  /** Applies a broadcast to local state, whatever kind of change it was. */
  const onMessage = useCallback(
    (live: LiveMessage) => {
      setMessages((current) => {
        const existing = current.findIndex((m) => m.id === live.id);

        if (existing >= 0) {
          // An edit or a delete. Merge rather than replace: the broadcast carries
          // the message, not the sender profile or the reactions, and overwriting
          // with it would blank the avatar and drop every reaction on the row.
          const next = [...current];
          const prev = next[existing];
          if (!prev) return current;
          next[existing] = {
            ...prev,
            body: live.body,
            editedAt: live.edited_at,
            deletedAt: live.deleted_at,
          };
          return next;
        }

        // A new message. The sender's profile is not in the payload, so it is
        // filled from the members we already know about — which is everyone in the
        // conversation.
        return [
          {
            id: live.id,
            conversationId: live.conversation_id,
            senderId: live.sender_id,
            body: live.body,
            replyToId: live.reply_to_id,
            createdAt: live.created_at,
            editedAt: live.edited_at,
            deletedAt: live.deleted_at,
            senderUsername: null,
            senderDisplayName: live.sender_id ? (memberNames[live.sender_id] ?? null) : null,
            senderAvatarUrl: null,
            reactions: [],
          },
          ...current,
        ];
      });
    },
    [memberNames],
  );

  const onReaction = useCallback(() => {
    // Reaction payloads are per-user deltas; recomputing the aggregate locally
    // means duplicating the SQL. Re-reading the page is one query for something
    // that happens rarely.
    refresh();
  }, [refresh]);

  const { typingUserIds, connected, sendTyping } = useConversationChannel(
    conversationId,
    currentUserId,
    { onMessage, onReaction },
  );

  // Mark read on arrival and whenever a new message lands while the tab is
  // visible. A background tab must NOT clear the badge — that is the difference
  // between "read" and "delivered to a laptop lid".
  useEffect(() => {
    if (document.visibilityState !== "visible") return;
    void markReadAction(conversationId);
  }, [conversationId, messages.length]);

  // Infinite scroll upward. An IntersectionObserver rather than a scroll
  // handler: it fires once when the sentinel appears instead of on every frame
  // of a flick.
  useEffect(() => {
    const sentinel = topSentinel.current;
    if (!sentinel || cursor === null) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || loadingOlder) return;

        setLoadingOlder(true);
        void loadOlderMessagesAction(conversationId, cursor)
          .then((page) => {
            setMessages((current) => {
              const seen = new Set(current.map((m) => m.id));
              return [...current, ...page.messages.filter((m) => !seen.has(m.id))];
            });
            setCursor(page.cursor);
          })
          .finally(() => setLoadingOlder(false));
      },
      { rootMargin: "200px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [conversationId, cursor, loadingOlder]);

  const typingNames = typingUserIds.map((id) => memberNames[id] ?? "Someone");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ol className="flex min-h-0 flex-1 flex-col-reverse gap-3 overflow-y-auto px-4 py-6 sm:px-6">
        {typingNames.length > 0 ? (
          <li className="flex items-center gap-2 pl-10 text-2xs text-fg-faint" aria-live="polite">
            <Pulse className="text-ember" />
            {typingNames.length === 1
              ? `${typingNames[0]} is typing`
              : `${typingNames.length} people are typing`}
          </li>
        ) : null}

        {messages.map((message, index) => {
          const next = messages[index + 1];
          // In a reversed list, `next` is the OLDER message. Show the avatar when
          // the speaker changes, so a run from one person reads as one block.
          const startsRun = !next || next.senderId !== message.senderId;
          const crossesDay =
            !next ||
            new Date(next.createdAt).toDateString() !== new Date(message.createdAt).toDateString();

          return (
            <div key={message.id} className="flex flex-col gap-3">
              <MessageBubble
                message={message}
                isOwn={message.senderId === currentUserId}
                currentUserId={currentUserId}
                showAvatar={startsRun}
                onChanged={refresh}
              />
              {crossesDay ? (
                <div className="flex items-center gap-3 py-2">
                  <span className="h-px flex-1 bg-line" />
                  <span className="label text-fg-faint">{formatDayDivider(message.createdAt)}</span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              ) : null}
            </div>
          );
        })}

        <div ref={topSentinel} className="h-px" />

        {loadingOlder ? (
          <li className="flex justify-center py-3">
            <Pulse className="text-fg-faint" />
          </li>
        ) : null}

        {cursor === null && messages.length > 0 ? (
          <li className="py-4 text-center text-2xs text-fg-faint">The beginning</li>
        ) : null}

        {messages.length === 0 ? (
          <li className="py-16 text-center text-sm text-fg-dim">
            Nothing here yet. Say something.
          </li>
        ) : null}
      </ol>

      <Composer
        conversationId={conversationId}
        connected={connected}
        onTyping={sendTyping}
        onSent={refresh}
      />
    </div>
  );
}

function Composer({
  conversationId,
  connected,
  onTyping,
  onSent,
}: {
  conversationId: string;
  connected: boolean;
  onTyping: () => void;
  onSent: () => void;
}) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const textarea = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const normalised = normaliseMessage(body);
    if (!normalised.ok) {
      setError(normalised.reason === "too_long" ? "That is too long." : null);
      return;
    }

    // Cleared immediately rather than after the round trip. The message is
    // already validated and the composer is the one thing that must never feel
    // like it is waiting.
    setBody("");
    setError(null);

    startTransition(async () => {
      const data = new FormData();
      data.set("conversationId", conversationId);
      data.set("body", normalised.value);

      const result = await sendMessageAction({ status: "idle" }, data);
      if (result.status === "error") {
        setError(result.message);
        // Give it back rather than losing what they wrote.
        setBody(normalised.value);
      } else {
        onSent();
      }
    });
  };

  return (
    <div className="border-t border-line px-4 py-3 sm:px-6">
      {error ? (
        <p role="alert" className="mb-2 text-2xs text-signal">
          {error}
        </p>
      ) : null}

      <div className="flex items-end gap-2">
        <textarea
          ref={textarea}
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
            onTyping();
          }}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter breaks the line. On a touch keyboard
            // Enter should insert a newline instead, because there is no shift
            // key within reach and no way to send otherwise.
            if (event.key === "Enter" && !event.shiftKey && !("ontouchstart" in window)) {
              event.preventDefault();
              submit();
            }
          }}
          rows={1}
          maxLength={MESSAGE_MAX_LENGTH}
          placeholder="Write something"
          aria-label="Message"
          className={cn(
            "input max-h-40 min-h-[var(--control-md)] flex-1 resize-none px-3 py-2.5 text-sm",
          )}
        />

        <button
          type="button"
          onClick={submit}
          disabled={pending || body.trim().length === 0}
          aria-label="Send"
          className={cn(
            "control-focus grid size-10 shrink-0 place-items-center rounded-soft",
            "bg-ember text-on-accent transition-opacity",
            "disabled:pointer-events-none disabled:opacity-30",
          )}
        >
          <Icon name="send" size={16} />
        </button>
      </div>

      {!connected ? (
        <p className="mt-2 text-2xs text-fg-faint">
          Reconnecting — messages you send will still arrive.
        </p>
      ) : null}
    </div>
  );
}
