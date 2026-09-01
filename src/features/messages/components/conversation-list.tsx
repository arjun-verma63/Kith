"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { LiveEmber } from "@/components/presence/live-presence";
import { Avatar } from "@/components/ui/avatar";
import { CountBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import type { ConversationSummary } from "@/features/messages/queries";
import type { DeclaredStatus } from "@/lib/presence";
import { cn } from "@/lib/utils/cn";

/**
 * The conversation list, and the responsive rule for the whole section.
 *
 * On a phone there is room for exactly one pane. `/messages` is the list;
 * `/messages/<id>` is the thread, full width, with the list hidden. On a wide
 * screen both are visible and the list marks which thread is open.
 *
 * That decision needs the current route, which a layout cannot see — so this is
 * a client component reading `usePathname`. The alternative is duplicating the
 * list into both routes, which means two copies to keep in step.
 */
export function ConversationList({ conversations }: { conversations: ConversationSummary[] }) {
  const pathname = usePathname();
  const openId = pathname.startsWith("/messages/") ? pathname.slice("/messages/".length) : null;

  return (
    <nav
      aria-label="Conversations"
      className={cn(
        "flex-col border-line lg:flex lg:w-[21rem] lg:shrink-0 lg:border-r",
        // Hidden on a phone whenever a thread is open.
        openId ? "hidden" : "flex w-full",
      )}
    >
      <div className="flex items-baseline justify-between border-b border-line px-5 py-4">
        <h1 className="display text-d-xs text-fg-loud">Messages</h1>
      </div>

      {conversations.length === 0 ? (
        <EmptyState
          figure={null}
          title="No conversations yet"
          description="Open one from a friend's profile, or from the Friends page."
          className="py-14"
        />
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          {conversations.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === openId}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}

function ConversationRow({
  conversation,
  active,
}: {
  conversation: ConversationSummary;
  active: boolean;
}) {
  const name =
    conversation.kind === "dm"
      ? (conversation.other?.displayName ?? "Someone who left")
      : (conversation.title ?? "Group");

  const preview =
    conversation.lastMessageBody ??
    (conversation.lastMessageAt ? "Message deleted" : "No messages yet");

  return (
    <li>
      <Link
        href={`/messages/${conversation.id}`}
        aria-current={active ? "page" : undefined}
        data-active={active}
        className={cn(
          "lit-edge lit-edge-left control-focus flex items-center gap-3 border-b border-line px-5 py-3.5",
          "transition-colors duration-[var(--t-quick)]",
          active ? "bg-[var(--wash-hover)]" : "hover:bg-[var(--wash-hover)]",
        )}
      >
        {conversation.other ? (
          <Avatar
            name={conversation.other.displayName}
            seed={conversation.other.id}
            size="md"
            src={conversation.other.avatarUrl}
          />
        ) : (
          <span className="numeric grid size-[var(--avatar-md)] shrink-0 place-items-center rounded-full bg-raised text-2xs text-fg-dim">
            {conversation.memberCount}
          </span>
        )}

        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span
              className={cn(
                "truncate text-sm",
                conversation.unreadCount > 0 ? "font-medium text-fg-loud" : "text-fg",
              )}
            >
              {name}
            </span>
            {conversation.other ? (
              <LiveEmber
                subject={{
                  userId: conversation.other.id,
                  status: conversation.other.status as DeclaredStatus,
                  lastSeenAt: conversation.other.lastSeenAt,
                }}
                name={conversation.other.displayName}
                size="sm"
              />
            ) : null}
          </span>

          <span
            className={cn(
              "truncate text-2xs",
              conversation.unreadCount > 0 ? "text-fg" : "text-fg-faint",
            )}
          >
            {preview}
          </span>
        </span>

        {conversation.unreadCount > 0 ? (
          <CountBadge count={conversation.unreadCount} label="unread messages" />
        ) : null}
      </Link>
    </li>
  );
}
