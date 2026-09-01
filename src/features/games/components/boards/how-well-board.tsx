"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { describeResult } from "@/features/games/engine/games/how-well";
import type { BoardProps } from "@/features/games/components/boards/registry";
import { cn } from "@/lib/utils/cn";

/**
 * How Well Do You Know Me?, drawn.
 *
 * Two people, one question, two answers that appear together. The screen has to
 * make three things obvious and never a fourth: whose round it is, which job you
 * have this round, and whether the other one has finished. What they picked is
 * the fourth, and it is not here until it is.
 *
 * ── One number, twice the size of anything else ──────────────────────────────
 *
 * The score is the couple's, not either person's, and the layout says so: a
 * single figure in the middle rather than two totals side by side. Everything
 * about the presentation is arranged so that nobody can read a winner out of it,
 * because there is not one.
 */

interface PublicState {
  round: number;
  totalRounds: number;
  phase: "answering" | "revealed";
  deadline: number;
  subjectSeat: number;
  subject: string | null;
  options: string[];
  truthIn: boolean;
  guessIn: boolean;
  truthIndex: number | null;
  guessIndex: number | null;
  matched: boolean;
  score: number;
  played: number;
}

interface PrivateState extends PublicState {
  mySeat: number;
  amSubject: boolean;
  myAnswer: number | null;
}

export function HowWellBoard({
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
  const other = players.find((player) => player.seat !== mySeat);
  const amSubject = mySeat !== null && mySeat === view?.subjectSeat;

  /*
   * Closing the round when the clock runs out.
   *
   * The engine has no clock, so somebody has to say so. Both say it, and the
   * version check picks one.
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
    if (failure && !failure.startsWith("The game moved on")) setError(failure);
  };

  if (!view?.subject) {
    return (
      <div className="panel panel-sunken grid min-h-40 place-items-center rounded-soft p-6">
        <p className="text-sm text-fg-faint">Setting up…</p>
      </div>
    );
  }

  const revealed = view.phase === "revealed";
  const committed = mine?.myAnswer ?? null;
  const theirName = other?.displayName.split(" ")[0] ?? "they";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <span className="label text-fg-faint">
          Round {view.round + 1} of {view.totalRounds}
        </span>
        {revealed ? (
          <span className="numeric text-2xs text-fg-faint">
            {view.score} of {view.played}
          </span>
        ) : (
          <Countdown remaining={remaining} truthIn={view.truthIn} guessIn={view.guessIn} />
        )}
      </div>

      {/* The question, with the name in it. */}
      <div className="flex flex-col items-center gap-2 text-center">
        <Avatar
          name={subject?.displayName ?? "Them"}
          seed={subject?.userId ?? "subject"}
          size="md"
          src={subject?.avatarUrl ?? null}
          className="ring-2 ring-plum"
        />
        <p className="heading text-md text-fg-loud sm:text-d-xs">
          {amSubject ? "Your" : `${subject?.displayName.split(" ")[0] ?? "Their"}'s`}{" "}
          <span className="text-plum">{view.subject}</span>
        </p>
        <p className="text-2xs text-fg-faint">
          {amSubject
            ? "Answer honestly. They're guessing what you'll say."
            : `What would ${subject?.displayName.split(" ")[0] ?? "they"} pick?`}
        </p>
      </div>

      <ul className="grid gap-2">
        {view.options.map((option, index) => (
          <li key={`${view.round}-${index}`}>
            <OptionRow
              label={option}
              chosen={committed === index}
              revealed={revealed}
              isTruth={revealed && view.truthIndex === index}
              isGuess={revealed && view.guessIndex === index}
              subjectName={subject?.displayName.split(" ")[0] ?? "Them"}
              otherName={theirName}
              amSubject={amSubject}
              disabled={revealed || committed !== null || mySeat === null || busy}
              onChoose={() => void send({ type: "answer", option: index })}
            />
          </li>
        ))}
      </ul>

      {!revealed ? (
        <WaitingRow
          players={players}
          subjectSeat={view.subjectSeat}
          truthIn={view.truthIn}
          guessIn={view.guessIn}
          mySeat={mySeat}
        />
      ) : (
        <RevealLine
          matched={view.matched}
          subjectName={subject?.displayName.split(" ")[0] ?? "They"}
        />
      )}

      {revealed && mySeat !== null ? (
        <div className="flex justify-center">
          <Button
            variant="lit"
            size="sm"
            loading={busy}
            onClick={() => void send({ type: "next" })}
          >
            {view.round + 1 >= view.totalRounds ? "See how you did" : "Next question"}
          </Button>
        </div>
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
  chosen,
  revealed,
  isTruth,
  isGuess,
  subjectName,
  otherName,
  amSubject,
  disabled,
  onChoose,
}: {
  label: string;
  chosen: boolean;
  revealed: boolean;
  isTruth: boolean;
  isGuess: boolean;
  subjectName: string;
  otherName: string;
  amSubject: boolean;
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
        chosen && !revealed
          ? "border-plum bg-[color-mix(in_oklab,var(--plum)_12%,transparent)]"
          : "border-line bg-raised",
        !disabled && "hover:border-line-lit hover:bg-[var(--wash-hover)]",
        disabled && !chosen && "cursor-default",
        revealed &&
          isTruth &&
          isGuess &&
          "border-moss bg-[color-mix(in_oklab,var(--moss)_10%,transparent)]",
        revealed && isTruth && !isGuess && "border-plum",
      )}
    >
      <span className="min-w-0 flex-1 text-sm text-fg-loud">{label}</span>

      {/* Both markers on one row when they agreed, which is the shape of a
          point. Separate markers when they did not. */}
      {revealed ? (
        <span className="flex shrink-0 items-center gap-1.5">
          {isTruth ? (
            <span className="rounded-edge bg-plum px-1.5 py-0.5 text-[0.625rem] text-on-accent">
              {amSubject ? "You" : subjectName}
            </span>
          ) : null}
          {isGuess ? (
            <span className="rounded-edge border border-line px-1.5 py-0.5 text-[0.625rem] text-fg-dim">
              {amSubject ? otherName : "You"} guessed
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

function Countdown({
  remaining,
  truthIn,
  guessIn,
}: {
  remaining: number;
  truthIn: boolean;
  guessIn: boolean;
}) {
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  const urgent = seconds <= 5;
  const inCount = (truthIn ? 1 : 0) + (guessIn ? 1 : 0);

  return (
    <span className="flex items-center gap-2">
      <span className="numeric text-2xs text-fg-faint tabular-nums">{inCount}/2 in</span>
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

/** Who has committed. Never what to. */
function WaitingRow({
  players,
  subjectSeat,
  truthIn,
  guessIn,
  mySeat,
}: {
  players: BoardProps["players"];
  subjectSeat: number;
  truthIn: boolean;
  guessIn: boolean;
  mySeat: number | null;
}) {
  return (
    <ul className="flex items-center justify-center gap-6 py-1">
      {players.map((player) => {
        const isSubject = player.seat === subjectSeat;
        const done = isSubject ? truthIn : guessIn;

        return (
          <li key={player.userId} className="flex flex-col items-center gap-1">
            <span className="relative">
              <Avatar
                name={player.displayName}
                seed={player.userId}
                size="sm"
                src={player.avatarUrl}
                className={cn("transition-opacity", done ? "opacity-100" : "opacity-40")}
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

function RevealLine({ matched, subjectName }: { matched: boolean; subjectName: string }) {
  return (
    <p className={cn("py-1 text-center text-sm", matched ? "text-moss" : "text-fg-dim")}>
      {matched ? "Same answer." : `Not quite — but now you know about ${subjectName}.`}
    </p>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The result, when the game is over.
 *
 * Exported so the session screen can show it in place of the generic winner
 * panel, which would otherwise announce that both people won — technically
 * correct here and completely the wrong tone.
 */
export function HowWellResult({ score, total }: { score: number; total: number }) {
  const { title, line } = describeResult(score, total);

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="flex items-baseline gap-1.5">
        <span className="numeric display text-d-md text-plum">{score}</span>
        <span className="numeric text-md text-fg-faint">/ {total}</span>
      </div>

      <div className="flex flex-col gap-1">
        <p className="heading text-md text-fg-loud">{title}</p>
        <p className="max-w-sm text-sm text-fg-dim">{line}</p>
      </div>

      {/* Said out loud, because a number in a big typeface is exactly the sort
          of thing people quote at each other later. */}
      <p className="max-w-xs text-2xs text-fg-faint">
        This is a quiz about holidays and biscuits. It is not a measure of anything and should not
        be used as one.
      </p>
    </div>
  );
}

function useCountdown(deadline: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running, deadline]);

  return useMemo(() => Math.max(0, deadline - now), [deadline, now]);
}
