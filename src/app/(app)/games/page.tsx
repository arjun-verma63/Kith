import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { GameShelf, type ShelfConversation } from "@/features/games/components/game-shelf";
import { listGames, listMySessions } from "@/features/games/queries";
import { listConversations } from "@/features/messages/queries";
import { getCurrentUser } from "@/lib/supabase/server";

/**
 * The games hub.
 *
 * Games run inside KITH, in a conversation, with the people already in it —
 * never as a link somewhere else. That is why starting one asks which room
 * rather than who to invite: the room IS the guest list, everybody in it is
 * notified, and there is somewhere to talk while you play.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Games" };

export default async function GamesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [games, sessions, conversations] = await Promise.all([
    listGames(),
    listMySessions(),
    listConversations(),
  ]);

  const shelfConversations: ShelfConversation[] = conversations.map((conversation) => ({
    id: conversation.id,
    title: conversation.title ?? conversation.other?.displayName ?? "Conversation",
    memberCount: conversation.memberCount,
    other: conversation.other
      ? {
          id: conversation.other.id,
          displayName: conversation.other.displayName,
          avatarUrl: conversation.other.avatarUrl,
        }
      : null,
  }));

  const live = sessions.filter((s) => s.status === "lobby" || s.status === "active");
  const past = sessions.filter((s) => s.status !== "lobby" && s.status !== "active");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-8 sm:gap-8 sm:px-10 sm:py-10">
      <header className="flex flex-col gap-1">
        <h1 className="heading text-d-xs text-fg-loud">Games</h1>
        <p className="text-sm text-fg-dim">Played here, with the people already in the room.</p>
      </header>

      {live.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="label text-fg-faint">Happening now</h2>
          <ul className="flex flex-col gap-2">
            {live.map((session) => (
              <li key={session.id}>
                <Link
                  href={`/games/${session.id}`}
                  className="row-lit control-focus panel flex items-center gap-3 rounded-soft px-4 py-3"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-fg-loud">{session.gameName}</span>
                    <span className="numeric truncate text-2xs text-fg-faint">
                      {session.conversationTitle ?? "A conversation"} · {session.playerCount}/
                      {session.maxPlayers}
                    </span>
                  </span>
                  <Badge tone={session.status === "active" ? "ember" : "neutral"}>
                    {session.status === "active" ? "Playing" : "Lobby"}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="label text-fg-faint">The shelf</h2>
        {games.length === 0 ? (
          <EmptyState title="Nothing on the shelf" description="No games are listed yet." />
        ) : (
          <GameShelf games={games} conversations={shelfConversations} />
        )}
      </section>

      {past.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="label text-fg-faint">Recently played</h2>
          <ul className="flex flex-col">
            {past.slice(0, 8).map((session) => (
              <li key={session.id} className="border-b border-line last:border-b-0">
                <Link
                  href={`/games/${session.id}`}
                  className="control-focus flex items-center gap-3 px-1 py-3"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-fg">{session.gameName}</span>
                    <span className="numeric truncate text-2xs text-fg-faint">
                      {session.conversationTitle ?? "A conversation"}
                    </span>
                  </span>
                  {session.myPlacement === 1 ? (
                    <Badge tone="moss">Won</Badge>
                  ) : (
                    <span className="numeric text-2xs text-fg-faint">{session.myScore}</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
