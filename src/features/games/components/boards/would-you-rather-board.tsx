"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { BoardProps } from "@/features/games/components/boards/registry";
import { cn } from "@/lib/utils/cn";

/**
 * Would You Rather, drawn.
 *
 * Two states, one screen. While answering, the two options are buttons and the
 * only thing you learn about anybody else is that they have decided — never
 * what. On the reveal, the same two panels fill with faces.
 *
 * Nothing here is authoritative. Every value comes from `publicState`, which the
 * server computed and redacted; the only thing this component owns is which
 * button you last pressed, and even that is confirmed by the server before it
 * sticks.
 */

interface PublicState {
  round: number;
  totalRounds: number;
  phase: "answering" | "revealed";
  deadline: number;
  prompt: { a: string; b: string } | null;
  answeredSeats: number[];
  answers: Record<string, "a" | "b">;
  tally: { a: number; b: number } | null;
  majority: "a" | "b" | null;
  scored: number[];
  scores: Record<string, number>;
  streaks: Record<string, number>;
}

interface PrivateState extends PublicState {
  myAnswer: "a" | "b" | null;
}

export function WouldYouRatherBoard({
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

  /*
   * Closing the round.
   *
   * The engine cannot see a clock — it is pure, and `now` is whatever the server
   * passes it. So when the timer runs out somebody has to say so, and every
   * client says it at once. The version check settles that: one request lands,
   * the rest come back stale and are dropped.
   *
   * Only players ask. A spectator has no seat and no business closing a round.
   */
  const asked = useRef(0);
  useEffect(() => {
    if (!view || mySeat === null) return;
    if (view.phase !== "answering") return;
    if (remaining > 0) return;
    // Once per round, not once per tick.
    if (asked.current === view.round + 1) return;

    asked.current = view.round + 1;
    void submit({ type: "reveal" });
  }, [view, remaining, mySeat, submit]);

  const send = async (move: unknown) => {
    setError(null);
    const failure = await submit(move);
    // "The game moved on" means somebody else got there first, which during a
    // simultaneous round is the normal outcome rather than a problem worth
    // showing anybody.
    if (failure && !failure.startsWith("The game moved on")) setError(failure);
  };

  if (!view?.prompt) {
    return (
      <div className="panel panel-sunken grid min-h-40 place-items-center rounded-soft p-6">
        <p className="text-sm text-fg-faint">Waiting for the next question…</p>
      </div>
    );
  }

  const revealed = view.phase === "revealed";
  const myAnswer = mine?.myAnswer ?? null;
  const total = players.length;
  const answered = view.answeredSeats.length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="label text-fg-faint">
          Round {view.round + 1} of {view.totalRounds}
        </span>

        {revealed ? (
          <span className="numeric text-2xs text-fg-faint">
            {answered} of {total} answered
          </span>
        ) : (
          <Countdown remaining={remaining} answered={answered} total={total} />
        )}
      </div>

      <p className="heading text-center text-md text-fg-loud sm:text-d-xs">Would you rather…</p>

      <div className="grid gap-3 sm:grid-cols-2">
        {(["a", "b"] as const).map((option) => (
          <Option
            key={option}
            label={view.prompt![option]}
            option={option}
            revealed={revealed}
            chosen={myAnswer === option}
            isMajority={view.majority === option}
            voters={revealed ? players.filter((p) => view.answers[String(p.seat)] === option) : []}
            count={revealed ? (view.tally?.[option] ?? 0) : 0}
            total={total}
            // Locked once answered: watching the count fill and switching at the
            // last moment is a different game, and a worse one.
            disabled={revealed || myAnswer !== null || mySeat === null || busy}
            onChoose={() => void send({ type: "answer", choice: option })}
          />
        ))}
      </div>

      {!revealed ? (
        <WaitingRow players={players} answeredSeats={view.answeredSeats} mySeat={mySeat} />
      ) : (
        <RevealRow view={view} players={players} mySeat={mySeat} />
      )}

      {revealed && mySeat !== null ? (
        <div className="flex justify-center pt-1">
          <Button
            variant="lit"
            size="sm"
            loading={busy}
            onClick={() => void send({ type: "next" })}
          >
            {view.round + 1 >= view.totalRounds ? "Finish" : "Next question"}
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

function Option({
  label,
  option,
  revealed,
  chosen,
  isMajority,
  voters,
  count,
  total,
  disabled,
  onChoose,
}: {
  label: string;
  option: "a" | "b";
  revealed: boolean;
  chosen: boolean;
  isMajority: boolean;
  voters: BoardProps["players"];
  count: number;
  total: number;
  disabled: boolean;
  onChoose: () => void;
}) {
  const share = total > 0 ? Math.round((count / total) * 100) : 0;

  return (
    <button
      type="button"
      onClick={onChoose}
      disabled={disabled}
      aria-pressed={chosen}
      className={cn(
        "control-focus relative flex min-h-32 flex-col justify-between overflow-hidden rounded-soft",
        "border p-4 text-left transition-colors duration-[var(--t-quick)]",
        chosen ? "border-ember bg-[var(--wash-accent)]" : "border-line bg-raised",
        !disabled && "hover:border-line-lit hover:bg-[var(--wash-hover)]",
        disabled && !chosen && "cursor-default",
        revealed && isMajority && "border-moss",
      )}
    >
      {/* The share, drawn as a fill behind the text rather than a chart beside
          it — the distribution IS the answer, so it belongs in the answer. */}
      {revealed ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0 left-0 transition-[width] duration-[var(--t-settle)]",
            isMajority ? "bg-[var(--wash-accent)]" : "bg-[var(--wash-hover)]",
          )}
          style={{ width: `${share}%` }}
        />
      ) : null}

      <span className="relative flex items-start gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "numeric mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[0.625rem]",
            chosen ? "bg-ember text-on-accent" : "bg-room text-fg-faint",
          )}
        >
          {option.toUpperCase()}
        </span>
        <span className="text-sm text-fg-loud">{label}</span>
      </span>

      {revealed ? (
        <span className="relative mt-3 flex items-center justify-between gap-2">
          <span className="flex -space-x-1.5">
            {voters.map((voter) => (
              <Avatar
                key={voter.userId}
                name={voter.displayName}
                seed={voter.userId}
                size="2xs"
                src={voter.avatarUrl}
                className="ring-1 ring-raised"
              />
            ))}
            {voters.length === 0 ? <span className="text-2xs text-fg-faint">Nobody</span> : null}
          </span>
          <span className="numeric text-2xs text-fg-dim tabular-nums">
            {count} · {share}%
          </span>
        </span>
      ) : null}
    </button>
  );
}

/* -------------------------------------------------------------------------- */

function Countdown({
  remaining,
  answered,
  total,
}: {
  remaining: number;
  answered: number;
  total: number;
}) {
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  const urgent = seconds <= 5;

  return (
    <span className="flex items-center gap-2">
      <span className="numeric text-2xs text-fg-faint tabular-nums">
        {answered}/{total} in
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
 * Who has decided.
 *
 * Faces light up as answers land — never what they chose. Watching the room fill
 * in is most of the tension, and it is the only thing that can be shown without
 * spoiling the round.
 */
function WaitingRow({
  players,
  answeredSeats,
  mySeat,
}: {
  players: BoardProps["players"];
  answeredSeats: number[];
  mySeat: number | null;
}) {
  return (
    <ul className="flex flex-wrap items-center justify-center gap-3 py-1">
      {players.map((player) => {
        const done = answeredSeats.includes(player.seat);
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

function RevealRow({
  view,
  players,
  mySeat,
}: {
  view: PublicState;
  players: BoardProps["players"];
  mySeat: number | null;
}) {
  const me = mySeat === null ? null : view.answers[String(mySeat)];
  const inStep = me !== undefined && (view.majority === null || me === view.majority);
  const streak = mySeat === null ? 0 : (view.streaks[String(mySeat)] ?? 0);

  return (
    <div className="flex flex-col items-center gap-2 py-1">
      {view.majority === null ? (
        <p className="text-sm text-fg">
          Split down the middle. <span className="text-moss">Everybody scores.</span>
        </p>
      ) : mySeat === null ? (
        <p className="text-sm text-fg-dim">
          {players.length - (view.tally?.[view.majority] ?? 0)} went the other way.
        </p>
      ) : me === undefined ? (
        <p className="text-sm text-signal">You ran out of time.</p>
      ) : inStep ? (
        <p className="text-sm text-moss">
          With the room.
          {streak >= 2 ? <span className="numeric text-ember"> {streak} in a row.</span> : null}
        </p>
      ) : (
        <p className="text-sm text-fg-dim">On your own with that one.</p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Milliseconds left, ticking.
 *
 * Derived from the absolute deadline on every tick rather than counted down, so
 * a tab that was throttled in the background comes back with the right number
 * instead of one that lost however long it was asleep. The deadline is the
 * server's, so every client agrees.
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
