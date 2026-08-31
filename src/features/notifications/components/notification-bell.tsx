"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { Avatar } from "@/components/ui/avatar";
import { CountBadge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import {
  dismissNotificationAction,
  markNotificationsReadAction,
  refreshNotificationsAction,
} from "@/features/notifications/actions";
import { describeAge, describeNotification, toneFor } from "@/features/notifications/describe";
import type { AppNotification } from "@/features/notifications/queries";
import { subscribeToUserEvents } from "@/lib/supabase/user-channel";
import { cn } from "@/lib/utils/cn";

/**
 * The bell, its badge, and the panel behind it.
 *
 * Subscribed to `user:{id}` — the personal bus — so the badge moves the moment
 * something arrives rather than on the next navigation. That channel is
 * read-only from a browser (migration 0009): notifications are delivered TO you
 * there, and nobody can broadcast into somebody else's.
 *
 * The initial list and count are server-rendered and handed in, so the bell is
 * correct on first paint and the socket only has to carry what changes.
 *
 * The panel is kept mounted and toggled with `display`, which lets the same CSS
 * handle enter and exit (`@starting-style` + `allow-discrete`) with no animation
 * library and no unmount timing to get wrong. Closed, it is `display: none` and
 * therefore out of the accessibility tree and the tab order.
 */
export function NotificationBell({
  userId,
  initialNotifications,
  initialUnread,
}: {
  userId: string;
  initialNotifications: AppNotification[];
  initialUnread: number;
}) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState(initialNotifications);
  const [unread, setUnread] = useState(initialUnread);
  const [, startTransition] = useTransition();

  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const reload = useCallback(() => {
    startTransition(async () => {
      const fresh = await refreshNotificationsAction();
      setNotifications(fresh);
      setUnread(fresh.filter((n) => n.readAt === null).length);
    });
  }, []);

  // Live arrivals.
  //
  // Through the shared `user:{id}` subscription rather than a channel of its
  // own: calls listen on the same topic, and two Phoenix joins on one topic over
  // one socket is not a thing to rely on.
  useEffect(
    () =>
      subscribeToUserEvents(userId, {
        // The payload carries the notification, but not the actor's profile or a
        // signed avatar URL. Re-reading is one query for something that happens
        // a handful of times a day, and it keeps one shape in one place.
        "notification.new": () => reload(),
      }),
    [userId, reload],
  );

  // Dismiss on an outside press, and on Escape with focus returned to the bell.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (wrapper.current?.contains(event.target as Node)) return;
      setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const markAllRead = () => {
    // Optimistic: the badge clears on the press rather than after the round
    // trip. If the write fails, the next reload puts it back — a badge that is
    // briefly wrong in the safe direction is better than one that lags a tap.
    setUnread(0);
    setNotifications((current) =>
      current.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })),
    );
    startTransition(async () => {
      await markNotificationsReadAction();
      reload();
    });
  };

  return (
    <div ref={wrapper} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          // Opening the panel is the act of reading it.
          if (next && unread > 0) markAllRead();
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className={cn(
          "control-focus relative grid size-9 place-items-center rounded-soft",
          "text-fg-dim transition-colors duration-[var(--t-quick)] hover:text-fg",
        )}
      >
        <Icon name="bell" size={18} />
        {unread > 0 ? (
          <CountBadge
            count={unread}
            label="unread notifications"
            className="absolute -top-0.5 -right-0.5"
          />
        ) : null}
      </button>

      <div
        role="dialog"
        aria-label="Notifications"
        data-open={open}
        className={cn(
          "menu-panel panel panel-overlay absolute top-[calc(100%+0.5rem)] right-0",
          "z-[var(--z-overlay)] w-[min(22rem,calc(100vw-2rem))] rounded-soft",
        )}
        style={{ "--menu-origin": "top right" } as React.CSSProperties}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="label text-fg-faint">Notifications</span>
          {notifications.some((n) => n.readAt === null) ? (
            <button
              type="button"
              onClick={markAllRead}
              className="control-focus rounded-edge text-2xs text-ember hover:underline"
            >
              Mark all read
            </button>
          ) : null}
        </div>

        {notifications.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-fg-faint">Nothing yet.</p>
        ) : (
          <ul className="max-h-[26rem] overflow-y-auto">
            {notifications.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                onDismiss={() => {
                  setNotifications((current) => current.filter((n) => n.id !== notification.id));
                  startTransition(async () => {
                    await dismissNotificationAction(notification.id);
                  });
                }}
                onNavigate={() => setOpen(false)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NotificationRow({
  notification,
  onDismiss,
  onNavigate,
}: {
  notification: AppNotification;
  onDismiss: () => void;
  onNavigate: () => void;
}) {
  const { actor, action, href } = describeNotification(notification);
  const tone = toneFor(notification.kind);
  const unread = notification.readAt === null;

  const body = (
    <>
      <span className="relative shrink-0">
        {notification.actor ? (
          <Avatar
            name={notification.actor.displayName}
            seed={notification.actor.id}
            size="sm"
            src={notification.actor.avatarUrl}
          />
        ) : (
          <span className="grid size-[var(--avatar-sm)] place-items-center rounded-full bg-raised">
            <Icon name="bell" size={13} className="text-fg-faint" />
          </span>
        )}
        <span
          aria-hidden="true"
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-raised",
            tone === "moss" && "bg-moss",
            tone === "signal" && "bg-signal",
            tone === "ice" && "bg-ice",
            tone === "plum" && "bg-plum",
            tone === "ember" && "bg-ember",
          )}
        />
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="truncate text-sm text-fg">
          <span className="font-medium text-fg-loud">{actor}</span> {action}
        </span>
        <span className="numeric text-2xs text-fg-faint">
          {describeAge(notification.createdAt)}
        </span>
      </span>
    </>
  );

  return (
    <li
      className={cn(
        "group/notification flex items-center border-b border-line last:border-b-0",
        unread && "bg-[var(--wash-accent)]",
      )}
    >
      {href ? (
        <Link
          href={href}
          onClick={onNavigate}
          className="control-focus flex min-w-0 flex-1 items-center gap-3 px-4 py-3 hover:bg-[var(--wash-hover)]"
        >
          {body}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3">{body}</div>
      )}

      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className={cn(
          "control-focus mr-2 rounded-inset p-1 text-fg-faint opacity-0 transition-opacity",
          "group-hover/notification:opacity-100 hover:text-fg focus-visible:opacity-100",
        )}
      >
        <Icon name="close" size={13} />
      </button>
    </li>
  );
}
