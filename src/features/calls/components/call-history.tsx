"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { loadMoreCallsAction } from "@/features/calls/actions";
import { CallButton } from "@/features/calls/components/call-button";
import { HISTORY_PAGE_SIZE } from "@/features/calls/constants";
import { describeCall, formatCallDay, formatCallTime } from "@/features/calls/describe";
import type { CallHistoryEntry } from "@/features/calls/queries";
import { cn } from "@/lib/utils/cn";

/**
 * The call log.
 *
 * Grouped by day, because that is how people look for a call — "did I ring them
 * on Tuesday?" — and never by conversation, which would bury the one thing the
 * log is for.
 *
 * A missed call is the only row that carries colour. Everything else is a fact
 * you are scanning past; a missed call is the reason you opened the page.
 */
export function CallHistory({ initial }: { initial: CallHistoryEntry[] }) {
  const [calls, setCalls] = useState(initial);
  const [exhausted, setExhausted] = useState(initial.length < HISTORY_PAGE_SIZE);
  const [pending, startTransition] = useTransition();

  const loadMore = () => {
    const last = calls.at(-1);
    if (!last) return;

    startTransition(async () => {
      const next = await loadMoreCallsAction(last.startedAt);
      setCalls((current) => [...current, ...next]);
      if (next.length < HISTORY_PAGE_SIZE) setExhausted(true);
    });
  };

  if (calls.length === 0) {
    return (
      <EmptyState
        title="No calls yet"
        description="Ring somebody from a conversation and it will show up here."
        action={
          <ButtonLink href="/messages" variant="lit" size="sm">
            Open Messages
          </ButtonLink>
        }
      />
    );
  }

  // Bucketed before rendering rather than tracked with a running variable. The
  // list is already sorted, so this is one pass, and it keeps the render a pure
  // function of `calls`.
  const days: { day: string; calls: CallHistoryEntry[] }[] = [];
  for (const call of calls) {
    const day = formatCallDay(call.startedAt);
    const current = days.at(-1);
    if (current?.day === day) current.calls.push(call);
    else days.push({ day, calls: [call] });
  }

  return (
    <div className="flex flex-col">
      {days.map(({ day, calls: sameDay }) => (
        <section key={day} className="flex flex-col">
          <h2 className="label bg-room/90 sticky top-0 z-[var(--z-raised)] px-1 py-3 text-fg-faint backdrop-blur-sm">
            {day}
          </h2>
          <ul className="flex flex-col">
            {sameDay.map((call) => (
              <li key={call.id}>
                <CallRow call={call} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {!exhausted ? (
        <div className="py-6 text-center">
          <Button variant="quiet" size="sm" onClick={loadMore} loading={pending}>
            Earlier calls
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function CallRow({ call }: { call: CallHistoryEntry }) {
  const { label, detail, direction, tone } = describeCall(call);
  const name = call.peer?.displayName ?? "Unknown";

  return (
    <div className="row-lit group/call flex items-center gap-3 border-b border-line px-1 py-3 last:border-b-0">
      <Avatar
        name={name}
        seed={call.peer?.id ?? call.id}
        size="sm"
        src={call.peer?.avatarUrl ?? null}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {call.peer?.username ? (
          <Link
            href={`/u/${call.peer.username}`}
            className="control-focus link-grow w-fit rounded-edge text-sm text-fg-loud"
          >
            {name}
          </Link>
        ) : (
          <span className="text-sm text-fg-loud">{name}</span>
        )}

        <span className="flex items-center gap-1.5 text-2xs">
          <Icon
            name={direction === "in" ? "callIncoming" : "callOutgoing"}
            size={12}
            className={cn(
              tone === "signal" && "text-signal",
              tone === "moss" && "text-moss",
              tone === "fg-faint" && "text-fg-faint",
            )}
          />
          <span className={cn(tone === "signal" ? "text-signal" : "text-fg-faint")}>{label}</span>
          <span aria-hidden="true" className="text-fg-faint">
            ·
          </span>
          <span className="numeric text-fg-faint">{detail}</span>
        </span>
      </div>

      <time
        dateTime={call.startedAt}
        className="numeric shrink-0 text-2xs text-fg-faint tabular-nums"
      >
        {formatCallTime(call.startedAt)}
      </time>

      {/* Calling back is the only thing anybody does from a call log. */}
      <CallButton
        conversationId={call.conversationId}
        peerName={name}
        className="opacity-0 transition-opacity group-hover/call:opacity-100 focus-visible:opacity-100"
      />
    </div>
  );
}
