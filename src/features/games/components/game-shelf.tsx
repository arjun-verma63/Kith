"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { createGameAction } from "@/features/games/actions";
import type { CatalogueGame } from "@/features/games/queries";
import { cn } from "@/lib/utils/cn";

/**
 * The shelf.
 *
 * Every game in the catalogue, including the ones that are not playable yet.
 * Hiding those would make the shelf look empty and tell nobody that anything is
 * coming — and "Soon" is a more honest answer than an absence.
 *
 * A game is playable only when its catalogue row is enabled AND an engine is
 * registered for it. Nothing here can tell the difference, and it does not need
 * to: pressing Start on a game with no rules gets a plain message back rather
 * than a broken board.
 */

export interface ShelfConversation {
  id: string;
  title: string;
  memberCount: number;
  other: { displayName: string; avatarUrl: string | null; id: string } | null;
}

export function GameShelf({
  games,
  conversations,
}: {
  games: CatalogueGame[];
  conversations: ShelfConversation[];
}) {
  const [choosing, setChoosing] = useState<CatalogueGame | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <ul className="grid gap-3 sm:grid-cols-2">
        {games.map((game) => (
          <li key={game.key}>
            <GameCard
              game={game}
              onStart={() => {
                setError(null);
                setChoosing(game);
              }}
            />
          </li>
        ))}
      </ul>

      {error ? (
        <p role="status" className="mt-4 text-sm text-signal">
          {error}
        </p>
      ) : null}

      <ChooseRoom
        game={choosing}
        conversations={conversations}
        onClose={() => setChoosing(null)}
        onError={(message) => {
          setChoosing(null);
          setError(message);
        }}
      />
    </>
  );
}

function GameCard({ game, onStart }: { game: CatalogueGame; onStart: () => void }) {
  return (
    <div
      className={cn(
        "panel flex h-full flex-col gap-3 rounded-soft p-4",
        game.enabled ? "lit-edge" : "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="heading text-md text-fg-loud">{game.name}</h3>
          {game.tagline ? <p className="text-sm text-fg-dim">{game.tagline}</p> : null}
        </div>

        <span
          aria-hidden="true"
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-soft",
            game.enabled ? "bg-[var(--wash-accent)] text-ember" : "bg-raised text-fg-faint",
          )}
        >
          <Icon name="games" size={17} />
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-2xs text-fg-faint">
        <span className="numeric">
          {game.minPlayers === game.maxPlayers
            ? `${game.minPlayers} players`
            : `${game.minPlayers}–${game.maxPlayers} players`}
        </span>
        <span aria-hidden="true">·</span>
        <span>{game.pace === "realtime" ? "Realtime" : "Turn by turn"}</span>
        {game.audience === "couple" ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="text-plum">Couple</span>
          </>
        ) : null}
      </div>

      <div className="mt-auto pt-1">
        {game.enabled ? (
          <Button variant="lit" size="sm" onClick={onStart}>
            Start a game
          </Button>
        ) : (
          <Badge tone="neutral">Soon</Badge>
        )}
      </div>
    </div>
  );
}

/**
 * Which room to play in.
 *
 * A game belongs to a conversation rather than floating free: that is what gives
 * it a guest list, a place for the invitation to arrive, and somewhere to talk
 * while you play. Choosing the room IS inviting people — everybody in it is
 * notified, which is why there is no separate invite step.
 */
function ChooseRoom({
  game,
  conversations,
  onClose,
  onError,
}: {
  game: CatalogueGame | null;
  conversations: ShelfConversation[];
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // A conversation with fewer people in it than the game needs cannot host it,
  // and offering it would mean a lobby nobody can start.
  const eligible = game
    ? conversations.filter((conversation) => conversation.memberCount >= game.minPlayers)
    : [];

  return (
    <Dialog
      open={game !== null}
      onClose={onClose}
      title={game ? `Start ${game.name}` : "Start a game"}
      description="Everybody in the conversation is invited."
    >
      {eligible.length === 0 ? (
        <p className="py-4 text-sm text-fg-dim">
          You need a conversation with enough people in it first.
        </p>
      ) : (
        <ul className="flex max-h-80 flex-col overflow-y-auto">
          {eligible.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (!game) return;
                  startTransition(async () => {
                    const result = await createGameAction(conversation.id, game.key);
                    if (result.ok && result.sessionId) {
                      router.push(`/games/${result.sessionId}`);
                      return;
                    }
                    onError(result.ok ? "That game could not be started." : result.reason);
                  });
                }}
                className={cn(
                  "row-lit control-focus flex w-full items-center gap-3 rounded-inset px-2 py-2.5",
                  "text-left disabled:opacity-50",
                )}
              >
                <Avatar
                  name={conversation.other?.displayName ?? conversation.title}
                  seed={conversation.other?.id ?? conversation.id}
                  size="sm"
                  src={conversation.other?.avatarUrl ?? null}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-fg-loud">{conversation.title}</span>
                  <span className="numeric text-2xs text-fg-faint">
                    {conversation.memberCount}{" "}
                    {conversation.memberCount === 1 ? "person" : "people"}
                  </span>
                </span>
                <Icon name="chevronRight" size={14} className="shrink-0 text-fg-faint" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
