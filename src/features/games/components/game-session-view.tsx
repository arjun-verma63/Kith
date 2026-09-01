"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Panel } from "@/components/ui/panel";
import {
  joinGameAction,
  leaveGameAction,
  rematchAction,
  setReadyAction,
  startGameAction,
  submitMoveAction,
} from "@/features/games/actions";
import {
  GameBoard,
  GameResult,
  hasBoard,
  hasOwnResult,
} from "@/features/games/components/boards/registry";
import type { GameSession, GamePlayer } from "@/features/games/queries";
import {
  useGameSession,
  type GameView,
  type InitialViews,
} from "@/features/games/use-game-session";
import { cn } from "@/lib/utils/cn";

/**
 * One game, at whatever stage it is at.
 *
 * Lobby, board and results are the same screen changing rather than three that
 * swap: the people at the table stay where they are throughout, which is what
 * makes a game feel like a room you are in rather than a sequence of pages.
 *
 * Nothing here knows what game it is. That is the point of the whole phase — the
 * lobby, seating, readiness, turn indicator, scoreboard, winner and rematch are
 * written once and work for every game that will ever be added. The only
 * game-specific thing is what renders on the board, and that arrives from the
 * engine registry.
 */
export function GameSessionView({
  initial,
  initialViews,
  userId,
}: {
  initial: GameSession;
  initialViews: InitialViews | null;
  userId: string;
}) {
  const { session, view, connected } = useGameSession(initial.id, userId, initial, initialViews);

  const seated = session.players.filter((player) => !player.hasLeft);
  const isPlayer = session.mySeat !== null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-8 sm:px-10">
      <Header session={session} view={view} connected={connected} />

      {session.status === "lobby" ? (
        <Lobby session={session} players={seated} isPlayer={isPlayer} />
      ) : (
        <>
          <Board session={session} view={view} />
          <Scoreboard session={session} players={session.players} view={view} />
        </>
      )}

      {session.status === "finished" || session.status === "abandoned" ? (
        <Results session={session} view={view} />
      ) : null}

      <Footer session={session} isPlayer={isPlayer} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Header({
  session,
  view,
  connected,
}: {
  session: GameSession;
  view: GameView;
  connected: boolean;
}) {
  const turnPlayer =
    view.turnSeat === null ? null : session.players.find((player) => player.seat === view.turnSeat);

  return (
    <header className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <h1 className="heading text-d-xs text-fg-loud">{session.gameName}</h1>
        <StatusBadge status={session.status} />
      </div>

      <p className="text-sm text-fg-dim">
        {session.status === "lobby" ? (
          <>Waiting for everyone. The game starts when the host says so.</>
        ) : session.status === "active" ? (
          turnPlayer ? (
            <>
              <span className="text-fg-loud">
                {turnPlayer.seat === session.mySeat ? "Your" : `${turnPlayer.displayName}'s`}
              </span>{" "}
              turn
            </>
          ) : (
            <>Everyone plays at once.</>
          )
        ) : session.status === "finished" ? (
          <>The game is over.</>
        ) : (
          <>Nobody stayed.</>
        )}
      </p>

      {!connected && session.status === "active" ? (
        // Said out loud rather than hidden: a board that has quietly stopped
        // updating looks exactly like a board where nothing is happening.
        <p className="numeric flex items-center gap-1.5 text-2xs text-signal">
          <span className="size-1.5 animate-pulse rounded-full bg-signal" aria-hidden="true" />
          Reconnecting to the table…
        </p>
      ) : null}
    </header>
  );
}

function StatusBadge({ status }: { status: GameSession["status"] }) {
  switch (status) {
    case "lobby":
      return <Badge tone="neutral">Lobby</Badge>;
    case "active":
      return <Badge tone="ember">Playing</Badge>;
    case "finished":
      return <Badge tone="moss">Finished</Badge>;
    default:
      return <Badge tone="neutral">Abandoned</Badge>;
  }
}

/* -------------------------------------------------------------------- lobby */

function Lobby({
  session,
  players,
  isPlayer,
}: {
  session: GameSession;
  players: GamePlayer[];
  isPlayer: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const me = players.find((player) => player.seat === session.mySeat);
  const needed = Math.max(0, session.minPlayers - players.length);

  const run = (task: () => Promise<{ ok: boolean; reason?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await task();
      if (!result.ok) setError(result.reason ?? "That did not work.");
    });
  };

  return (
    <Panel tone="raised" padding="none" className="rounded-soft">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="label text-fg-faint">
          Players · {players.length}/{session.maxPlayers}
        </span>
        {needed > 0 ? (
          <span className="numeric text-2xs text-fg-faint">{needed} more to start</span>
        ) : null}
      </div>

      <ul className="flex flex-col">
        {players.map((player) => (
          <li
            key={player.userId}
            className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
          >
            <Avatar
              name={player.displayName}
              seed={player.userId}
              size="sm"
              src={player.avatarUrl}
            />

            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-2">
                <Link
                  href={`/u/${player.username}`}
                  className="control-focus link-grow truncate rounded-edge text-sm text-fg-loud"
                >
                  {player.displayName}
                </Link>
                {player.isHost ? <Badge tone="ember">Host</Badge> : null}
              </span>
              <span className="numeric text-2xs text-fg-faint">Seat {player.seat + 1}</span>
            </span>

            {player.isReady ? (
              <span className="flex items-center gap-1.5 text-2xs text-moss">
                <Icon name="check" size={13} />
                Ready
              </span>
            ) : (
              <span className="text-2xs text-fg-faint">Waiting</span>
            )}
          </li>
        ))}

        {/* The empty seats, drawn. A lobby that just shows two people gives no
            sense of whether it is nearly full or nearly empty. */}
        {Array.from({ length: session.maxPlayers - players.length }).map((_, index) => (
          <li
            key={`empty-${index}`}
            className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
          >
            <span className="size-[var(--avatar-sm)] rounded-full border border-dashed border-line" />
            <span className="text-sm text-fg-faint">Empty seat</span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        {isPlayer ? (
          <>
            <Button
              variant={me?.isReady ? "quiet" : "lit"}
              size="sm"
              loading={pending}
              onClick={() => run(() => setReadyAction(session.id, !me?.isReady))}
            >
              {me?.isReady ? "Not ready" : "I'm ready"}
            </Button>

            {session.hostId && session.mySeat !== null && session.canStart ? (
              <Button
                variant="primary"
                size="sm"
                loading={pending}
                onClick={() => run(() => startGameAction(session.id))}
              >
                Start game
              </Button>
            ) : null}
          </>
        ) : (
          <Button
            variant="lit"
            size="sm"
            loading={pending}
            onClick={() => run(() => joinGameAction(session.id))}
          >
            Take a seat
          </Button>
        )}
      </div>

      {error ? (
        <p role="status" className="border-t border-line px-4 py-3 text-sm text-signal">
          {error}
        </p>
      ) : null}
    </Panel>
  );
}

/* -------------------------------------------------------------------- board */

/**
 * Where a game draws itself.
 *
 * Looked up by `session.gameKey`. A game with no board — the four catalogue
 * entries that are still just a name — gets the panel below, which says so
 * plainly rather than rendering something that looks broken.
 *
 * Everything a board receives is already redacted: `publicState` is the engine's
 * public view and `privateState` is this player's own. A board cannot see
 * anybody else's secrets because it was never sent them.
 */
function Board({ session, view }: { session: GameSession; view: GameView }) {
  const [busy, setBusy] = useState(false);

  /**
   * Submits a move and reports what happened.
   *
   * Returns the reason rather than throwing, because most refusals here are
   * ordinary events a board should handle quietly — "somebody else got there
   * first" during a simultaneous round is not an error worth a banner.
   */
  const submit = useCallback(
    async (move: unknown) => {
      setBusy(true);
      try {
        const result = await submitMoveAction(session.id, move);
        return result.ok ? null : result.reason;
      } finally {
        setBusy(false);
      }
    },
    [session.id],
  );

  const players = useMemo(
    () =>
      session.players
        .filter((player) => !player.hasLeft)
        .map((player) => ({
          seat: player.seat,
          displayName: player.displayName,
          avatarUrl: player.avatarUrl,
          userId: player.userId,
        })),
    [session.players],
  );

  if (hasBoard(session.gameKey)) {
    return (
      <Panel tone="flat" padding="lg" className="rounded-soft">
        <GameBoard
          gameKey={session.gameKey}
          sessionId={session.id}
          publicState={view.publicState}
          privateState={view.privateState}
          mySeat={session.mySeat}
          players={players}
          submit={submit}
          busy={busy}
        />
      </Panel>
    );
  }

  return (
    <Panel tone="sunken" padding="lg" className="rounded-soft">
      <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
        <Icon name="games" size={26} className="text-fg-faint" />
        <div className="flex flex-col gap-1">
          <p className="text-sm text-fg">No board for {session.gameName} yet.</p>
          <p className="text-2xs text-fg-faint">
            The lobby, turns, scoring and rematch all work. The game itself is the next thing to
            build.
          </p>
        </div>
      </div>
    </Panel>
  );
}

/* --------------------------------------------------------------- scoreboard */

function Scoreboard({
  session,
  players,
  view,
}: {
  session: GameSession;
  players: GamePlayer[];
  view: GameView;
}) {
  // Live scores from the engine while playing; the stored ones once it is over,
  // because those are what was written down.
  const finished = session.status === "finished";
  const scoreFor = (seat: number, stored: number) =>
    finished ? stored : (view.scores[seat] ?? stored);

  const ranked = [...players].sort((a, b) => scoreFor(b.seat, b.score) - scoreFor(a.seat, a.score));

  return (
    <Panel tone="flat" padding="none" className="rounded-soft">
      <div className="border-b border-line px-4 py-3">
        <span className="label text-fg-faint">Scores</span>
      </div>

      <ul className="flex flex-col">
        {ranked.map((player) => {
          const score = scoreFor(player.seat, player.score);
          const isTurn = view.turnSeat === player.seat && session.status === "active";

          return (
            <li
              key={player.userId}
              className={cn(
                "flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0",
                isTurn && "lit-edge-left bg-[var(--wash-accent)]",
                player.hasLeft && "opacity-50",
              )}
            >
              <Avatar
                name={player.displayName}
                seed={player.userId}
                size="2xs"
                src={player.avatarUrl}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-fg">
                {player.displayName}
                {player.hasLeft ? <span className="text-fg-faint"> · left</span> : null}
              </span>
              {player.placement === 1 ? <Badge tone="moss">Winner</Badge> : null}
              <span className="numeric text-sm text-fg-loud tabular-nums">{score}</span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/* ------------------------------------------------------------------ results */

function Results({ session, view }: { session: GameSession; view: GameView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const winners = session.players.filter((player) => player.placement === 1);
  const abandoned = session.status === "abandoned";
  // A co-operative game writes its own ending. See the registry.
  const ownResult = !abandoned && hasOwnResult(session.gameKey);

  return (
    <Panel
      tone="raised"
      padding="lg"
      className="lit-edge flex flex-col items-center gap-4 rounded-soft text-center"
    >
      {abandoned ? (
        <p className="text-sm text-fg-dim">This game was abandoned before it finished.</p>
      ) : ownResult ? (
        <GameResult
          gameKey={session.gameKey}
          publicState={view.publicState}
          players={session.players}
          mySeat={session.mySeat}
        />
      ) : winners.length === 0 ? (
        <p className="heading text-md text-fg-loud">A draw.</p>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="flex -space-x-2">
            {winners.map((winner) => (
              <Avatar
                key={winner.userId}
                name={winner.displayName}
                seed={winner.userId}
                size="lg"
                src={winner.avatarUrl}
                className="ring-2 ring-ember"
              />
            ))}
          </div>
          <p className="heading text-d-xs text-fg-loud">
            {winners.length === 1
              ? `${winners[0]?.displayName} wins`
              : `${winners.map((w) => w.displayName).join(" and ")} win`}
          </p>
          {view.outcome ? (
            <p className="numeric text-2xs text-fg-faint">
              {winners.map((w) => view.outcome?.scores[w.seat] ?? w.score).join(" · ")}
            </p>
          ) : null}
        </div>
      )}

      {session.mySeat !== null ? (
        <Button
          variant="lit"
          size="sm"
          loading={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await rematchAction(session.id);
              if (result.ok && result.sessionId) {
                router.push(`/games/${result.sessionId}`);
                return;
              }
              setError(result.ok ? "That did not work." : result.reason);
            });
          }}
        >
          Play again
        </Button>
      ) : null}

      {error ? (
        <p role="status" className="text-sm text-signal">
          {error}
        </p>
      ) : null}
    </Panel>
  );
}

/* ------------------------------------------------------------------- footer */

function Footer({ session, isPlayer }: { session: GameSession; isPlayer: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const live = session.status === "lobby" || session.status === "active";

  return (
    <div className="flex items-center justify-between gap-3">
      <Link href="/games" className="control-focus link-grow rounded-edge text-sm text-fg-dim">
        All games
      </Link>

      {isPlayer && live ? (
        <Button
          variant="ghost"
          size="sm"
          loading={pending}
          onClick={() =>
            startTransition(async () => {
              await leaveGameAction(session.id);
              router.push("/games");
            })
          }
        >
          {session.status === "lobby" ? "Leave lobby" : "Leave game"}
        </Button>
      ) : null}
    </div>
  );
}
