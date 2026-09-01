"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Panel } from "@/components/ui/panel";
import { startCoupleGameAction } from "@/features/couple/actions";
import type { CoupleGame, CoupleGameSession } from "@/features/couple/queries";
import { GUESS_MY_ANSWER_CATEGORIES, type GuessMyAnswerCategory } from "@/lib/games/config";
import { cn } from "@/lib/utils/cn";

/**
 * Games, on the couple page.
 *
 * Deliberately not on the games shelf. A couple game is played in the couple's
 * own space with the one person it is for — putting it on a list beside Draw &
 * Guess would mean asking "who do you want to play this with", which is the one
 * question it does not have.
 *
 * -- Games that need asking first --------------------------------------------
 *
 * Guess My Answer is the first game with something to decide before it starts.
 * The rest go straight from Play to a lobby and should keep doing so: a settings
 * step in front of a game nobody needs to configure is a step for nothing. So
 * the shelf checks whether a game has a setup screen and only stops for the ones
 * that do.
 */

/** Games that ask something before they open. */
const NEEDS_SETUP = new Set(["guess-my-answer"]);

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
  const [setup, setSetup] = useState<CoupleGame | null>(null);

  const live = history.find((s) => s.status === "lobby" || s.status === "active");
  const finished = history.filter((s) => s.status === "finished");

  const open = (game: CoupleGame, config?: unknown) => {
    setError(null);
    startTransition(async () => {
      const result = await startCoupleGameAction(coupleId, game.key, config);
      if (result.ok && result.sessionId) {
        setSetup(null);
        router.push(`/games/${result.sessionId}`);
      } else if (!result.ok) {
        setError(result.reason);
      }
    });
  };

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
                  loading={pending && setup === null}
                  onClick={() => (NEEDS_SETUP.has(game.key) ? setSetup(game) : open(game))}
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

      {setup?.key === "guess-my-answer" ? (
        <CategoryPicker
          game={setup}
          pending={pending}
          onClose={() => setSetup(null)}
          onStart={(categories) => open(setup, { categories })}
        />
      ) : null}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * What kind of evening is this.
 *
 * The categories in Guess My Answer are not a filter over one pile of questions
 * -- petty and tender genuinely produce different games, and choosing between
 * them is most of the fun of starting one. So it is a real screen with the
 * blurbs on it rather than a dropdown.
 *
 * Choosing nothing means everything, which is why the button stays enabled on an
 * empty selection: "surprise us" is a legitimate answer and should not require
 * pressing four things to express.
 */
function CategoryPicker({
  game,
  pending,
  onClose,
  onStart,
}: {
  game: CoupleGame;
  pending: boolean;
  onClose: () => void;
  onStart: (categories: GuessMyAnswerCategory[]) => void;
}) {
  const [picked, setPicked] = useState<GuessMyAnswerCategory[]>([]);

  const toggle = (key: GuessMyAnswerCategory) =>
    setPicked((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );

  return (
    <Dialog
      open
      onClose={onClose}
      title={game.name}
      description="Pick what you are in the mood for. Choose nothing and you get all of it."
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Not now
          </Button>
          <Button variant="lit" size="sm" loading={pending} onClick={() => onStart(picked)}>
            {picked.length === 0 ? "Surprise us" : "Start"}
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-2">
        {GUESS_MY_ANSWER_CATEGORIES.map((category) => {
          const on = picked.includes(category.key);

          return (
            <li key={category.key}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => toggle(category.key)}
                className={cn(
                  "control-focus flex w-full items-baseline gap-3 rounded-inset border px-3 py-2.5",
                  "text-left transition-colors duration-[var(--t-quick)]",
                  on
                    ? "border-plum bg-[color-mix(in_oklab,var(--plum)_12%,transparent)]"
                    : "border-line bg-raised hover:border-line-lit hover:bg-[var(--wash-hover)]",
                )}
              >
                <span className={cn("text-sm", on ? "text-fg-loud" : "text-fg")}>
                  {category.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-2xs text-fg-faint">
                  {category.blurb}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
