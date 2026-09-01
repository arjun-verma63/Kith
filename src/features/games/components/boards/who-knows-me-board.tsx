"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { BoardProps } from "@/features/games/components/boards/registry";
import { cn } from "@/lib/utils/cn";

/**
 * Who Knows Me Better?, drawn.
 *
 * The screen has to say three things at a glance and never a fourth: whose round
 * it is, what the question is, and who has locked something in. What they locked
 * in is the fourth thing, and it stays off the screen until the reveal — not
 * because the component is careful, but because it was never sent it.
 *
 * The subject sees the same board as everybody else, with one difference: their
 * buttons pick the truth rather than a guess. Same layout, different verb, so
 * being the subject does not feel like a different app.
 */

interface PublicState {
  round: number;
  totalRounds: number;
  phase: "answering" | "revealed";
  deadline: number;
  subjectSeat: number;
  prompt: string | null;
  options: string[];
  answered: boolean;
  guessedSeats: number[];
  answerIndex: number | null;
  guesses: Record<string, number>;
  correctSeats: number[];
  voided: boolean;
  scores: Record<string, number>;
  streaks: Record<string, number>;
}

interface PrivateState extends PublicState {
  mySeat: number;
  amSubject: boolean;
  myAnswer: number | null;
  myGuess: number | null;
}

export function WhoKnowsMeBoard({
  publicState,
  privateState,
  mySeat,
  players,
  submit,
  busy,
}: BoardProps) {
  const view = publicState as PublicState | null;
  const mine = privateState as PrivateState | null;

  const [error, setError] = useState<string | null>(null);
  const remaining = useCountdown(view?.deadline ?? 0, view?.phase === "answering");

  const subject = players.find((player) => player.seat === view?.subjectSeat);
  const amSubject = mySeat !== null && mySeat === view?.subjectSeat;
  const committed = amSubject ? (mine?.myAnswer ?? null) : (mine?.myGuess ?? null);

  /*
   * Closing the round.
   *
   * The engine has no clock — it is pure, and `now` is whatever the server hands
   * it — so when the deadline passes somebody has to say so. Every client says
   * it at once and `state_version` picks one; the rest come back stale and are
   * ignored.
   */
  const asked = useRef(0);
  useEffect(() => {
    if (!view || mySeat === null) return;
    if (view.phase !== "answering" || remaining > 0) return;
    if (asked.current === view.round + 1) return;

    asked.current = view.round + 1;
    void submit({ type: "reveal" });
  }, [view, remaining, mySeat, submit]);

  const send = async (move: unknown) => {
    setError(null);
    const failure = await submit(move);
    // Losing a race during a simultaneous round is the normal outcome, not
    // something worth putting in front of anybody.
    if (failure && !failure.startsWith("The game moved on")) setError(failure);
  };

  if (!view?.prompt) {
    return (
      <div className="panel panel-sunken grid min-h-40 place-items-center rounded-soft p-6">
        <p className="text-sm text-fg-faint">Setting up the next round…</p>
      </div>
    );
  }

  const revealed = view.phase === "revealed";
  const guessers = players.filter((player) => player.seat !== view.subjectSeat);
  const locked = view.guessedSeats.length + (view.answered ? 1 : 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="label text-fg-faint">
          Round {view.round + 1} of {view.totalRounds}
        </span>
        {revealed ? null : (
          <Countdown remaining={remaining} locked={locked} total={players.length} />
        )}
      </div>

      {/* Whose round it is, made unmissable. Everything else on screen is about
          this person, so they belong at the top of it. */}
      <div className="flex flex-col items-center gap-2 text-center">
        <Avatar
          name={subject?.displayName ?? "Someone"}
          seed={subject?.userId ?? "subject"}
          size="lg"
          src={subject?.avatarUrl ?? null}
          className="ring-2 ring-ember"
        />
        <p className="heading text-md text-fg-loud sm:text-d-xs">
          {amSubject ? "You" : (subject?.displayName ?? "Someone")}&rsquo;s{" "}
          <span className="text-ember">{view.prompt}</span>
        </p>
        <p className="text-2xs text-fg-faint">
          {amSubject
            ? "Pick the true answer. Everybody else is guessing it."
            : `What would ${subject?.displayName.split(" ")[0] ?? "they"} say?`}
        </p>
      </div>

      <ul className="grid gap-2">
        {view.options.map((option, index) => (
          <li key={`${view.round}-${index}`}>
            <OptionRow
              label={option}
              revealed={revealed}
              chosen={committed === index}
              isTruth={revealed && view.answerIndex === index}
              guessers={
                revealed
                  ? guessers.filter((player) => view.guesses[String(player.seat)] === index)
                  : []
              }
              disabled={revealed || committed !== null || mySeat === null || busy}
              onChoose={() => void send({ type: amSubject ? "answer" : "guess", option: index })}
            />
          </li>
        ))}
      </ul>

      {!revealed ? (
        <LockedRow
          players={players}
          subjectSeat={view.subjectSeat}
          answered={view.answered}
          guessedSeats={view.guessedSeats}
          mySeat={mySeat}
        />
      ) : (
        <RevealSummary
          view={view}
          subjectName={subject?.displayName ?? "They"}
          guessers={guessers}
          mySeat={mySeat}
          amSubject={amSubject}
        />
      )}

      {revealed && mySeat !== null ? (
        <div className="flex justify-center pt-1">
          <Button
            variant="lit"
            size="sm"
            loading={busy}
            onClick={() => void send({ type: "next" })}
          >
            {view.round + 1 >= view.totalRounds ? "Finish" : "Next round"}
          </Button>
        </div>
      ) : null}

      {mySeat === null ? (
        <p className="text-center text-2xs text-fg-faint">
          You are watching. Answers stay hidden from you until the reveal, same as everyone.
        </p>
      ) : null}

      {error ? (
        <p role="status" className="text-center text-sm text-signal">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function OptionRow({
  label,
  revealed,
  chosen,
  isTruth,
  guessers,
  disabled,
  onChoose,
}: {
  label: string;
  revealed: boolean;
  chosen: boolean;
  isTruth: boolean;
  guessers: BoardProps["players"];
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChoose}
      disabled={disabled}
      aria-pressed={chosen}
      className={cn(
        "control-focus flex w-full items-center gap-3 rounded-soft border p-3 text-left",
        "transition-colors duration-[var(--t-quick)]",
        chosen ? "border-ember bg-[var(--wash-accent)]" : "border-line bg-raised",
        !disabled && "hover:border-line-lit hover:bg-[var(--wash-hover)]",
        disabled && !chosen && "cursor-default",
        revealed && isTruth && "border-moss bg-[color-mix(in_oklab,var(--moss)_10%,transparent)]",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full text-[0.625rem]",
          revealed && isTruth
            ? "bg-moss text-on-accent"
            : chosen
              ? "bg-ember text-on-accent"
              : "bg-room text-fg-faint",
        )}
      >
        {revealed && isTruth ? <Icon name="check" size={11} /> : null}
      </span>

      <span className="min-w-0 flex-1 text-sm text-fg-loud">{label}</span>

      {/* Who guessed this, once it is safe to say. */}
      {revealed ? (
        <span className="flex shrink-0 -space-x-1.5">
          {guessers.map((player) => (
            <Avatar
              key={player.userId}
              name={player.displayName}
              seed={player.userId}
              size="2xs"
              src={player.avatarUrl}
              className="ring-1 ring-raised"
            />
          ))}
        </span>
      ) : null}
    </button>
  );
}

function Countdown({
  remaining,
  locked,
  total,
}: {
  remaining: number;
  locked: number;
  total: number;
}) {
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  const urgent = seconds <= 5;

  return (
    <span className="flex items-center gap-2">
      <span className="numeric text-2xs text-fg-faint tabular-nums">
        {locked}/{total} in
      </span>
      <span
        className={cn(
          "numeric rounded-edge px-1.5 py-0.5 text-2xs tabular-nums",
          urgent ? "bg-signal text-on-accent" : "bg-raised text-fg-dim",
        )}
      >
        {seconds}s
      </span>
    </span>
  );
}

/**
 * Who has locked in.
 *
 * The subject is marked, so the room can see whether they are waiting on the
 * person the question is about or on each other. Never what anybody picked.
 */
function LockedRow({
  players,
  subjectSeat,
  answered,
  guessedSeats,
  mySeat,
}: {
  players: BoardProps["players"];
  subjectSeat: number;
  answered: boolean;
  guessedSeats: number[];
  mySeat: number | null;
}) {
  return (
    <ul className="flex flex-wrap items-center justify-center gap-3 py-1">
      {players.map((player) => {
        const isSubject = player.seat === subjectSeat;
        const done = isSubject ? answered : guessedSeats.includes(player.seat);

        return (
          <li key={player.userId} className="flex flex-col items-center gap-1">
            <span className="relative">
              <Avatar
                name={player.displayName}
                seed={player.userId}
                size="sm"
                src={player.avatarUrl}
                className={cn(
                  "transition-opacity",
                  done ? "opacity-100" : "opacity-40",
                  isSubject && "ring-2 ring-ember",
                )}
              />
              {done ? (
                <span
                  aria-hidden="true"
                  className="ring-room absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-moss text-on-accent ring-2"
                >
                  <Icon name="check" size={9} />
                </span>
              ) : null}
            </span>
            <span className="text-[0.625rem] text-fg-faint">
              {player.seat === mySeat ? "You" : player.displayName.split(" ")[0]}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function RevealSummary({
  view,
  subjectName,
  guessers,
  mySeat,
  amSubject,
}: {
  view: PublicState;
  subjectName: string;
  guessers: BoardProps["players"];
  mySeat: number | null;
  amSubject: boolean;
}) {
  if (view.voided) {
    return (
      <p className="py-1 text-center text-sm text-fg-dim">
        {subjectName} never answered, so this one does not count.
      </p>
    );
  }

  const right = view.correctSeats.length;
  const total = guessers.length;
  const iWasRight = mySeat !== null && view.correctSeats.includes(mySeat);
  const streak = mySeat === null ? 0 : (view.streaks[String(mySeat)] ?? 0);

  return (
    <div className="flex flex-col items-center gap-1.5 py-1 text-center">
      {/* The point of the whole game, said plainly. */}
      <p className="text-sm text-fg">
        <span className="numeric text-fg-loud">
          {right} of {total}
        </span>{" "}
        {amSubject ? "of them know you" : right === 1 ? "person got it" : "people got it"}.
      </p>

      {amSubject ? (
        right === total && total > 0 ? (
          <p className="text-2xs text-moss">Not a mystery to anybody.</p>
        ) : right === 0 ? (
          <p className="text-2xs text-signal">Nobody saw that coming.</p>
        ) : null
      ) : iWasRight ? (
        <p className="text-2xs text-moss">
          You knew.
          {streak >= 2 ? <span className="text-ember"> {streak} in a row.</span> : null}
        </p>
      ) : mySeat !== null ? (
        <p className="text-2xs text-fg-faint">Not this time.</p>
      ) : null}
    </div>
  );
}

/**
 * Milliseconds left, ticking.
 *
 * Recomputed from the absolute deadline on every tick rather than counted down,
 * so a throttled background tab comes back with the right number instead of one
 * that lost however long it was asleep. The deadline is the server's, so every
 * client agrees on it.
 */
function useCountdown(deadline: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running, deadline]);

  return useMemo(() => Math.max(0, deadline - now), [deadline, now]);
}
