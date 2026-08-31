"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton, SkeletonAvatar } from "@/components/ui/skeleton";
import { sendFriendRequestAction } from "@/features/friends/actions";
import { ActionForm, PersonRow } from "@/features/friends/components/person-row";
import { searchAction } from "@/features/friends/search-action";
import type { SearchResult } from "@/features/friends/queries";

/**
 * Member search.
 *
 * Debounced at 250ms, and every in-flight request carries a sequence number.
 * Without that second part, a slow response for "a" can land after a fast one
 * for "ada" and replace the right results with stale ones — the classic
 * out-of-order search bug, which is intermittent and therefore rarely caught
 * by hand.
 *
 * A blank query renders nothing at all rather than the full member list. On an
 * invitation-only app an empty search that lists everybody is a directory, and
 * the SQL function refuses it too.
 */
export function FriendSearch() {
  const [query, setQuery] = useState("");
  // Results are stored WITH the query that produced them, so "are these results
  // still current?" is derived at render rather than kept in sync by an effect
  // that clears state. Clearing state from an effect means an extra render where
  // the old results are still on screen under the new query.
  const [answer, setAnswer] = useState<{ query: string; results: SearchResult[] } | null>(null);
  const [, startTransition] = useTransition();
  const sequence = useRef(0);

  const trimmed = query.trim();
  const results = answer && answer.query === trimmed ? answer.results : null;

  useEffect(() => {
    if (trimmed.length === 0) return;

    const timer = window.setTimeout(() => {
      const ticket = ++sequence.current;

      startTransition(async () => {
        const found = await searchAction(trimmed);
        // Drop anything that is no longer the newest request.
        if (ticket === sequence.current) setAnswer({ query: trimmed, results: found });
      });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [trimmed]);

  return (
    <div className="flex flex-col gap-5">
      <Input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by username or name"
        icon="search"
        aria-label="Search for people"
        autoComplete="off"
        spellCheck={false}
      />

      {/* One live region for the whole result set, so a screen reader hears
          "4 results" rather than four separate insertions. */}
      <p aria-live="polite" className="sr-only">
        {results === null
          ? ""
          : results.length === 0
            ? "No people found"
            : `${results.length} ${results.length === 1 ? "person" : "people"} found`}
      </p>

      {trimmed.length > 0 && results === null ? <SearchSkeleton /> : null}

      {results !== null && results.length === 0 ? (
        <EmptyState
          figure={null}
          title="Nobody by that name"
          description="Check the spelling. Some people choose not to be findable in search."
        />
      ) : null}

      {results !== null && results.length > 0 ? (
        <ul className="flex flex-col border-t border-line">
          {results.map((person) => (
            <PersonRow
              key={person.id}
              person={person}
              actions={<SearchActions person={person} />}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SearchActions({ person }: { person: SearchResult }) {
  switch (person.relationship) {
    case "friend":
      return (
        <span className="flex items-center gap-1.5 text-2xs text-moss">
          <Icon name="check" size={13} />
          Friends
        </span>
      );

    case "outgoing":
      return (
        <span className="flex items-center gap-1.5 text-2xs text-fg-faint">
          <Icon name="send" size={13} />
          Requested
        </span>
      );

    case "incoming":
      return (
        <span className="flex items-center gap-1.5 text-2xs text-ember">
          <Icon name="bell" size={13} />
          Wants to add you
        </span>
      );

    default:
      return (
        <ActionForm
          action={sendFriendRequestAction}
          fields={{ userId: person.id }}
          variant="lit"
          size="sm"
          icon="plus"
        >
          Add
        </ActionForm>
      );
  }
}

/** Matches the geometry of a result row, not a generic grey bar. */
function SearchSkeleton() {
  return (
    <ul className="flex flex-col border-t border-line" aria-hidden="true">
      {[0, 1, 2].map((row) => (
        <li key={row} className="flex items-center gap-4 border-b border-line py-4 pl-4">
          <SkeletonAvatar size="md" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-40 rounded-full" />
            <Skeleton className="h-2.5 w-24 rounded-full" />
          </div>
        </li>
      ))}
    </ul>
  );
}
