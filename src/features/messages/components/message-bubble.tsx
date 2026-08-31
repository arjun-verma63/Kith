"use client";

import { useState, useTransition } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { deleteMessageAction, REACTIONS, toggleReactionAction } from "@/features/messages/actions";
import type { Message } from "@/features/messages/queries";
import { formatMessageTime, segmentText } from "@/lib/text";
import { cn } from "@/lib/utils/cn";

/**
 * One message.
 *
 * The asymmetric radius does the work colour usually does: the flat corner sits
 * on the speaker's side, so the thread reads correctly with the avatars stripped
 * out and in greyscale. Two identical rounded rectangles in different colours is
 * what every messaging app already looks like, and it tells you nothing without
 * the colour.
 *
 * ── On sanitisation ──────────────────────────────────────────────────────────
 *
 * The body is rendered as React children, never as HTML. There is no
 * `dangerouslySetInnerHTML` anywhere in this codebase, which is the actual
 * defence — React escapes every string it renders, so stripping tags from text
 * that is about to be escaped would be theatre.
 *
 * Links are the one place raw input reaches an attribute, and `segmentText`
 * allows only `http` and `https`. A `javascript:` URL stays plain text.
 */
export function MessageBubble({
  message,
  isOwn,
  currentUserId,
  showAvatar,
  onChanged,
}: {
  message: Message;
  isOwn: boolean;
  currentUserId: string;
  showAvatar: boolean;
  onChanged: () => void;
}) {
  const [showActions, setShowActions] = useState(false);
  const [, startTransition] = useTransition();

  const deleted = message.deletedAt !== null;

  return (
    <li
      className={cn("group/message flex gap-2.5", isOwn ? "flex-row-reverse" : "flex-row")}
      onMouseLeave={() => setShowActions(false)}
    >
      <span className="w-8 shrink-0 self-end">
        {showAvatar && !isOwn ? (
          <Avatar
            name={message.senderDisplayName ?? "Someone"}
            seed={message.senderId ?? message.id}
            size="xs"
            src={message.senderAvatarUrl}
          />
        ) : null}
      </span>

      <div className={cn("flex min-w-0 flex-col gap-1", isOwn ? "items-end" : "items-start")}>
        {showAvatar && !isOwn ? (
          <span className="px-1 text-2xs text-fg-faint">
            {message.senderDisplayName ?? "Someone who left"}
          </span>
        ) : null}

        <div className={cn("flex items-end gap-1.5", isOwn ? "flex-row-reverse" : "flex-row")}>
          <div
            className={cn(
              "max-w-[min(34rem,78vw)] px-3.5 py-2.5 text-sm leading-body",
              isOwn
                ? "bubble-out bg-[var(--wash-accent-strong)] text-fg-loud"
                : "bubble-in bg-surface text-fg",
              deleted && "text-fg-faint italic",
            )}
          >
            {deleted ? (
              "This message was deleted"
            ) : (
              // `pre-wrap` so newlines survive without turning the body into
              // markup. `break-words` so a 200-character URL cannot widen the
              // thread past the viewport.
              <span className="break-words whitespace-pre-wrap">
                {segmentText(message.body ?? "").map((segment, index) =>
                  segment.type === "link" ? (
                    <a
                      key={index}
                      href={segment.href}
                      target="_blank"
                      // noreferrer as well as noopener: without it the linked
                      // page learns which conversation the click came from.
                      rel="noopener noreferrer nofollow"
                      className="underline underline-offset-2 hover:text-ember"
                    >
                      {segment.value}
                    </a>
                  ) : (
                    <span key={index}>{segment.value}</span>
                  ),
                )}
              </span>
            )}
          </div>

          {!deleted ? (
            <button
              type="button"
              onClick={() => setShowActions((value) => !value)}
              aria-label="Message actions"
              aria-expanded={showActions}
              className={cn(
                "control-focus rounded-inset p-1 text-fg-faint opacity-0 transition-opacity",
                "group-hover/message:opacity-100 hover:text-fg focus-visible:opacity-100",
              )}
            >
              <Icon name="more" size={14} />
            </button>
          ) : null}
        </div>

        {message.reactions.length > 0 ? (
          <ul className={cn("flex flex-wrap gap-1", isOwn ? "justify-end" : "justify-start")}>
            {message.reactions.map((reaction) => {
              const mine = reaction.userIds.includes(currentUserId);
              return (
                <li key={reaction.emoji}>
                  <button
                    type="button"
                    onClick={() =>
                      startTransition(async () => {
                        await toggleReactionAction(message.id, reaction.emoji);
                        onChanged();
                      })
                    }
                    aria-pressed={mine}
                    className={cn(
                      "control-focus numeric flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-2xs",
                      mine
                        ? "border-ember bg-[var(--wash-accent)] text-fg-loud"
                        : "border-line bg-surface text-fg-dim hover:border-line-lit",
                    )}
                  >
                    <span aria-hidden="true">{reaction.emoji}</span>
                    {reaction.userIds.length}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {showActions && !deleted ? (
          <div className="panel panel-overlay flex items-center gap-1 rounded-full px-1.5 py-1">
            {REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`React with ${emoji}`}
                onClick={() =>
                  startTransition(async () => {
                    await toggleReactionAction(message.id, emoji);
                    setShowActions(false);
                    onChanged();
                  })
                }
                className="control-focus rounded-full px-1 text-sm transition-transform hover:scale-125"
              >
                {emoji}
              </button>
            ))}

            {isOwn ? (
              <button
                type="button"
                onClick={() =>
                  startTransition(async () => {
                    const data = new FormData();
                    data.set("messageId", message.id);
                    await deleteMessageAction({ status: "idle" }, data);
                    setShowActions(false);
                    onChanged();
                  })
                }
                className="control-focus ml-1 rounded-full p-1 text-fg-faint hover:text-signal"
                aria-label="Delete message"
              >
                <Icon name="block" size={13} />
              </button>
            ) : null}
          </div>
        ) : null}

        <time
          dateTime={message.createdAt}
          className="px-1 text-[0.625rem] text-fg-faint opacity-0 transition-opacity group-hover/message:opacity-100"
        >
          {formatMessageTime(message.createdAt)}
          {message.editedAt ? " · edited" : ""}
        </time>
      </div>
    </li>
  );
}
