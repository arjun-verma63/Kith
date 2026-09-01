"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { startCoupleGameAction } from "@/features/couple/actions";
import type { CoupleGame, CoupleGameSession } from "@/features/couple/queries";
import { cn } from "@/lib/utils/cn";

/**
 * Games, on the couple page.
 *
 * Deliberately not on the games shelf. A couple game is played in the couple's
 * own space with the one person it is for — putting it on a list beside Draw &
 * Guess would mean asking "who do you want to play this with", which is the one
 * question it does not have.
 */
export function CoupleGames({
  coupleId,
  games,
  history,
}: {
  coupleId: string;
  games: CoupleGame[];
  history: CoupleGameSession[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const live = history.find((s) => s.status === "lobby" || s.status === "active");
  const finished = history.filter((s) => s.status === "finished");

  if (games.length === 0) return null;

  return (
    <Panel tone="flat" padding="md" className="flex flex-col gap-4 rounded-soft">
      <span className="label text-fg-faint">Something to do</span>

      {live ? (
        <Link
          href={`/games/${live.id}`}
          className="row-lit control-focus flex items-center gap-3 rounded-inset px-2 py-2.5"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-fg-loud">{live.gameName}</span>
            <span className="text-2xs text-fg-faint">Carry on where you left off.</span>
          </span>
          <Badge tone="plum">{live.status === "active" ? "Playing" : "Ready?"}</Badge>
        </Link>
      ) : (
        <ul className="flex flex-col gap-2">
          {games.map((game) => (
            <li key={game.key}>
              <div className="flex items-center gap-3 rounded-inset border border-line px-3 py-2.5">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-fg-loud">{game.name}</span>
                  {game.tagline ? (
                    <span className="truncate text-2xs text-fg-faint">{game.tagline}</span>
                  ) : null}
                </span>
                <Button
                  variant="lit"
                  size="sm"
                  loading={pending}
                  onClick={() => {
                    setError(null);
                    startTransition(async () => {
                      const result = await startCoupleGameAction(coupleId, game.key);
                      if (result.ok && result.sessionId) router.push(`/games/${result.sessionId}`);
                      else if (!result.ok) setError(result.reason);
                    });
                  }}
                >
                  Play
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* The history the brief asked for. Scores, not verdicts. */}
      {finished.length > 0 ? (
        <div className="flex flex-col gap-1 border-t border-line pt-3">
          <span className="label text-fg-faint">Before</span>
          <ul className="flex flex-col">
            {finished.slice(0, 5).map((session) => (
              <li key={session.id}>
                <Link
                  href={`/games/${session.id}`}
                  className={cn(
                    "control-focus flex items-center gap-3 rounded-inset px-1 py-2",
                    "hover:bg-[var(--wash-hover)]",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">
                    {session.gameName}
                  </span>
                  <span className="numeric text-2xs text-fg-faint">
                    {new Date(session.createdAt).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "short",
                    })}
                  </span>
                  <span className="numeric text-sm text-plum tabular-nums">{session.ourScore}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? (
        <p role="status" className="text-sm text-signal">
          {error}
        </p>
      ) : null}
    </Panel>
  );
}
