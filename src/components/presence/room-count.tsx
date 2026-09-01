"use client";

import Link from "next/link";

import { PresenceEmber } from "@/components/ui/presence-ember";
import { useOnlineCount } from "@/components/presence/use-presence";
import { usePresenceContext } from "@/components/presence/provider";
import { cn } from "@/lib/utils/cn";

/**
 * "3 in the room" — the third presence surface, and the one that stands in for
 * the chat list until messaging exists.
 *
 * When there is no live connection this renders a plain "Friends" link rather
 * than a count. Showing "0 in the room" during a dropped socket would be a
 * confident lie, and showing the last known number would be the same lie with
 * better manners.
 */
export function RoomCount({ friendIds, className }: { friendIds: string[]; className?: string }) {
  const { connected } = usePresenceContext();
  const { online, known } = useOnlineCount(friendIds);

  return (
    <Link
      href="/friends"
      className={cn(
        "control-focus link-grow flex items-center gap-2 rounded-edge text-sm text-fg-dim",
        className,
      )}
    >
      {known && connected ? (
        <>
          <PresenceEmber state={online > 0 ? "lit" : "dark"} size="sm" />
          <span aria-live="polite">{online > 0 ? `${online} in the room` : "Nobody around"}</span>
        </>
      ) : (
        "Friends"
      )}
    </Link>
  );
}
