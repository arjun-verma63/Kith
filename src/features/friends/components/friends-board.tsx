"use client";

import { useState } from "react";

import { CountBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  acceptFriendRequestAction,
  cancelFriendRequestAction,
  declineFriendRequestAction,
  removeFriendAction,
} from "@/features/friends/actions";
import { FriendSearch } from "@/features/friends/components/friend-search";
import { ActionForm, PersonRow } from "@/features/friends/components/person-row";
import type { Friend, FriendRequest } from "@/features/friends/queries";
import { cn } from "@/lib/utils/cn";

/**
 * The Friends board.
 *
 * Four views behind one set of tabs rather than four stacked sections. With six
 * people, a page showing friends AND incoming AND outgoing AND search at once is
 * mostly empty headings — and the one thing that actually needs attention, an
 * incoming request, gets lost among them. So the count rides on the tab and the
 * tab does the asking.
 *
 * The lists are rendered on the server and passed down; only the tab state lives
 * here. Switching tabs is not a reason to refetch six rows.
 */

type Tab = "friends" | "incoming" | "outgoing" | "search";

export function FriendsBoard({
  friends,
  incoming,
  outgoing,
}: {
  friends: Friend[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}) {
  // Open on requests when somebody is waiting: the page starts on the thing that
  // needs a decision rather than on the list that needs nothing.
  const [tab, setTab] = useState<Tab>(incoming.length > 0 ? "incoming" : "friends");

  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: "friends", label: "Friends", count: friends.length },
    { key: "incoming", label: "Requests", count: incoming.length },
    { key: "outgoing", label: "Sent", count: outgoing.length },
    { key: "search", label: "Find people", count: 0 },
  ];

  return (
    <div className="flex flex-col gap-8">
      <div role="tablist" aria-label="Friends" className="flex gap-1 border-b border-line">
        {tabs.map((item) => {
          const active = item.key === tab;
          return (
            <button
              key={item.key}
              role="tab"
              type="button"
              id={`friends-tab-${item.key}`}
              aria-selected={active}
              aria-controls={`friends-panel-${item.key}`}
              onClick={() => setTab(item.key)}
              className={cn(
                "control-focus relative flex cursor-pointer items-center gap-2 rounded-t-soft",
                "px-3 py-3 text-sm transition-colors duration-[var(--t-quick)] sm:px-4",
                active ? "text-fg-loud" : "text-fg-dim hover:text-fg",
              )}
            >
              {item.label}
              {item.count > 0 ? (
                <CountBadge
                  count={item.count}
                  tone={item.key === "incoming" ? "ember" : "neutral"}
                  label={item.label}
                />
              ) : null}
              {active ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-ember"
                  style={{ boxShadow: "var(--elev-lit)" }}
                />
              ) : null}
            </button>
          );
        })}
      </div>

      <div
        id={`friends-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`friends-tab-${tab}`}
        tabIndex={-1}
      >
        {tab === "friends" ? <FriendsList friends={friends} /> : null}
        {tab === "incoming" ? <IncomingList requests={incoming} /> : null}
        {tab === "outgoing" ? <OutgoingList requests={outgoing} /> : null}
        {tab === "search" ? <FriendSearch /> : null}
      </div>
    </div>
  );
}

function FriendsList({ friends }: { friends: Friend[] }) {
  if (friends.length === 0) {
    return (
      <EmptyState
        title="Nobody here yet"
        description="KITH is better with your people in it. Find someone by their username and send them a request."
      />
    );
  }

  return (
    <ul className="flex flex-col border-t border-line">
      {friends.map((friend) => (
        <PersonRow
          key={friend.id}
          person={friend}
          actions={
            <ActionForm
              action={removeFriendAction}
              fields={{ userId: friend.id }}
              variant="ghost"
              size="sm"
            >
              Remove
            </ActionForm>
          }
        />
      ))}
    </ul>
  );
}

function IncomingList({ requests }: { requests: FriendRequest[] }) {
  if (requests.length === 0) {
    return (
      <EmptyState
        figure={null}
        title="No requests waiting"
        description="When somebody asks to add you, it will show up here."
      />
    );
  }

  return (
    <ul className="flex flex-col border-t border-line">
      {requests.map((request) => (
        <PersonRow
          key={request.requestId}
          person={request}
          {...(request.message ? { meta: request.message } : {})}
          actions={
            <>
              <ActionForm
                action={acceptFriendRequestAction}
                fields={{ requestId: request.requestId }}
                variant="primary"
                size="sm"
              >
                Accept
              </ActionForm>
              <ActionForm
                action={declineFriendRequestAction}
                fields={{ requestId: request.requestId }}
                variant="ghost"
                size="sm"
              >
                Decline
              </ActionForm>
            </>
          }
        />
      ))}
    </ul>
  );
}

function OutgoingList({ requests }: { requests: FriendRequest[] }) {
  if (requests.length === 0) {
    return (
      <EmptyState
        figure={null}
        title="Nothing sent"
        description="Requests you send will wait here until they are answered."
      />
    );
  }

  return (
    <ul className="flex flex-col border-t border-line">
      {requests.map((request) => (
        <PersonRow
          key={request.requestId}
          person={request}
          meta="Waiting for a reply"
          actions={
            <ActionForm
              action={cancelFriendRequestAction}
              fields={{ requestId: request.requestId }}
              variant="ghost"
              size="sm"
            >
              Withdraw
            </ActionForm>
          }
        />
      ))}
    </ul>
  );
}
