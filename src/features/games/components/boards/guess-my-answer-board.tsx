"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { BoardProps } from "@/features/games/components/boards/registry";
import { describeTogether } from "@/features/games/engine/games/guess-my-answer";
import { GUESS_MY_ANSWER_CATEGORIES, type GuessMyAnswerCategory } from "@/lib/games/config";
import { cn } from "@/lib/utils/cn";

/**
 * Guess My Answer, drawn.
 *
 * ── Making it look like a different game ─────────────────────────────────────
 *
 * The brief asked for something visually distinct from the group games, and the
 * honest way to get that is not a different palette on the same layout. It is a
 * layout that could not be used by any of the others, because it is the shape of
 * this game's rules:
 *
 *   EVERYTHING IS IN TWO COLUMNS. You answer for yourself on the left and
 *   predict them on the right, at the same time, and at the reveal those two
 *   columns become the two people. The other games are a single list of options
 *   with one thing to press; this one is a spread with four decisions on it, and
 *   the doubling is visible before a single word is read.
 *
 *   THE QUESTION IS THE PAGE. Set large in Fraunces across the top of the
 *   spread, with a coloured category chip above it — the group boards put their
 *   question in a line of body text above the options.
 *
 * Plum, because it is a couple game, and a category chip in the category's own
 * tone so that a `petty` round is instantly a different colour from a `tender`
 * one. Both are existing design-system tones; the distinctness comes from the
 * arrangement, not from inventing anything.
 *
 * ── What is on screen and what is not ────────────────────────────────────────
 *
 * Until all four submissions are in, this component has nothing to leak: the
 * server never sends anybody else's choices, so "hidden" here is a fact about
 * the payload rather than a promise about the CSS. What it does show is who has
 * finished, which is the only thing either of them needs while waiting.
 */

/* -------------------------------------------------------------------------- */

interface PublicState {
  round: number;
  totalRounds: number;
  phase: "answering" | "revealed";
  deadline: number;
  category: GuessMyAnswerCategory | null;
  question: string | null;
  options: string[];
  submittedSeats: number[];
  own: Record<number, number | null>;
  predict: Record<number, number | null>;
  correct: number[];
  scores: Record<number, number>;
  together: number;
}

interface PrivateState extends PublicState {
  mySeat: number;
  myOwn: number | null;
  myPredict: number | null;
}

const CATEGORY_TONE: Record<GuessMyAnswerCategory, BadgeTone> = {
  tender: "plum",
  petty: "signal",
  wild: "lantern",
  past: "ice",
};

function first(name: string | undefined): string {
  return name?.split(" ")[0] ?? "them";
}

/* -------------------------------------------------------------------------- */

export function GuessMyAnswerBoard({
  publicState,
  privateState,
  mySeat,
  players,
  submit,
  busy,
}: BoardProps) {
  const view = publicState as PublicState | null;
  const mine = privateState as PrivateState | null;

  const [draftOwn, setDraftOwn] = useState<number | null>(null);
  const [draftPredict, setDraftPredict] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remaining = useCountdown(view?.deadline ?? 0, view?.phase === "answering");

  const other = players.find((player) => player.seat !== mySeat);
  const me = players.find((player) => player.seat === mySeat);
  const theirName = first(other?.displayName);

  /*
   * A new round is a clean sheet.
   *
   * Adjusted during render rather than in an effect: an effect would paint one
   * frame of the new round with the previous round's selections still lit, and
   * this is a game about what you committed to.
   *
   * Keyed on the round rather than the phase, so the reveal keeps showing what
   * was chosen right up until "next".
   */
  const round = view?.round ?? 0;
  const [drafted, setDrafted] = useState(round);
  if (drafted !== round) {
    setDrafted(round);
    setDraftOwn(null);
    setDraftPredict(null);
  }

  /*
   * Closing the round when the clock runs out.
   *
   * The engine has no clock of its own — it only ever sees the time a move
   * arrived — so somebody has to say the deadline passed. Both say it, and the
   * version check makes one of them a no-op.
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

  if (!view?.question) {
    return (
      <div className="panel panel-sunken grid min-h-40 place-items-center rounded-soft p-6">
        <p className="text-sm text-fg-faint">Setting up…</p>
      </div>
    );
  }

  const revealed = view.phase === "revealed";
  const committed = mine ? mine.myOwn !== null && mine.myPredict !== null : false;
  const ready = draftOwn !== null && draftPredict !== null;
  const last = view.totalRounds - 1 === view.round;

  return (
    <div className="flex flex-col gap-5">
      {/* ---------------------------------------------------------- heading */}
      <div className="flex flex-col items-center gap-3">
        <div className="flex w-full items-center justify-between gap-3">
          {view.category ? (
            <Badge tone={CATEGORY_TONE[view.category]} caps>
              {GUESS_MY_ANSWER_CATEGORIES.find((c) => c.key === view.category)?.name ??
                view.category}
            </Badge>
          ) : (
            <span />
          )}

          <span className="flex items-center gap-2">
            <span className="numeric text-2xs text-fg-faint tabular-nums">
              {view.round + 1}/{view.totalRounds}
            </span>
            {revealed ? null : (
              <Countdown remaining={remaining} inCount={view.submittedSeats.length} />
            )}
          </span>
        </div>

        {/* The question is the page, not a caption above the options. */}
        <h3 className="display max-w-lg text-center text-d-xs text-balance text-fg-loud sm:text-d-sm">
          {view.question}
        </h3>
      </div>

      {/* ------------------------------------------------------------ spread */}
      {revealed ? (
        <Reveal
          view={view}
          players={players}
          mySeat={mySeat}
          meName={first(me?.displayName)}
          theirName={theirName}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Column
            heading="You would say"
            hint="Honestly."
            options={view.options}
            selected={committed ? (mine?.myOwn ?? null) : draftOwn}
            locked={committed || mySeat === null}
            accent="plum"
            round={view.round}
            onChoose={setDraftOwn}
          />
          <Column
            heading={`${theirName} will say`}
            hint="Your prediction."
            options={view.options}
            selected={committed ? (mine?.myPredict ?? null) : draftPredict}
            locked={committed || mySeat === null}
            accent="ember"
            round={view.round}
            onChoose={setDraftPredict}
          />
        </div>
      )}

      {/* ------------------------------------------------------------ action */}
      {!revealed && mySeat !== null ? (
        committed ? (
          <Waiting players={players} submitted={view.submittedSeats} mySeat={mySeat} />
        ) : (
          <div className="flex flex-col items-center gap-2">
            <Button
              variant="lit"
              size="sm"
              disabled={!ready}
              loading={busy}
              onClick={() => void send({ type: "submit", own: draftOwn, predict: draftPredict })}
            >
              Lock both in
            </Button>
            <p className="text-2xs text-fg-faint">
              {ready ? "You cannot change them after this." : "Pick one on each side."}
            </p>
          </div>
        )
      ) : null}

      {revealed && mySeat !== null ? (
        <div className="flex justify-center">
          <Button
            variant="lit"
            size="sm"
            loading={busy}
            onClick={() => void send({ type: "next" })}
          >
            {last ? "See how you did" : "Next question"}
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

/** One half of the spread while answering. */
function Column({
  heading,
  hint,
  options,
  selected,
  locked,
  accent,
  round,
  onChoose,
}: {
  heading: string;
  hint: string;
  options: string[];
  selected: number | null;
  locked: boolean;
  accent: "plum" | "ember";
  round: number;
  onChoose: (index: number) => void;
}) {
  const ring = accent === "plum" ? "border-plum" : "border-ember";
  const wash =
    accent === "plum"
      ? "bg-[color-mix(in_oklab,var(--plum)_12%,transparent)]"
      : "bg-[color-mix(in_oklab,var(--ember)_12%,transparent)]";

  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-soft border border-line bg-sunken p-3">
      <header className="flex items-baseline justify-between gap-2">
        <span className="label text-fg-dim">{heading}</span>
        <span className="text-[0.625rem] text-fg-faint">{hint}</span>
      </header>

      <ul className="flex flex-col gap-1.5">
        {options.map((option, index) => (
          <li key={`${round}-${index}`}>
            <button
              type="button"
              disabled={locked}
              aria-pressed={selected === index}
              onClick={() => onChoose(index)}
              className={cn(
                "control-focus w-full rounded-inset border px-3 py-2 text-left text-sm",
                "transition-colors duration-[var(--t-quick)]",
                selected === index
                  ? cn(ring, wash, "text-fg-loud")
                  : "border-line bg-raised text-fg",
                !locked &&
                  selected !== index &&
                  "hover:border-line-lit hover:bg-[var(--wash-hover)]",
                locked && "cursor-default",
              )}
            >
              {option}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The reveal.
 *
 * One panel per person: what they said, and what the other one thought they
 * would say. Read left to right it answers "did you get me", read as a pair it
 * answers "did we get each other" — which is the question the game is actually
 * about, and the reason both are on screen at once rather than in sequence.
 */
function Reveal({
  view,
  players,
  mySeat,
  meName,
  theirName,
}: {
  view: PublicState;
  players: BoardProps["players"];
  mySeat: number | null;
  meName: string;
  theirName: string;
}) {
  const ordered = [...players].sort((a, b) => {
    // Yours first, so the eye lands on "what they thought of me".
    if (mySeat === null) return a.seat - b.seat;
    return a.seat === mySeat ? -1 : b.seat === mySeat ? 1 : 0;
  });

  const scored = view.correct.length;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {ordered.map((player) => {
          const guesser = players.find((p) => p.seat !== player.seat);
          const said = view.own[player.seat] ?? null;
          const guessed = guesser ? (view.predict[guesser.seat] ?? null) : null;
          const hit = guesser ? view.correct.includes(guesser.seat) : false;
          const isMe = player.seat === mySeat;

          return (
            <section
              key={player.userId}
              className={cn(
                "flex min-w-0 flex-col gap-3 rounded-soft border p-3",
                hit
                  ? "border-[color-mix(in_oklab,var(--moss)_45%,transparent)] bg-[color-mix(in_oklab,var(--moss)_8%,transparent)]"
                  : "border-line bg-sunken",
              )}
            >
              <header className="flex items-center gap-2">
                <Avatar
                  name={player.displayName}
                  seed={player.userId}
                  size="2xs"
                  src={player.avatarUrl}
                />
                <span className="label text-fg-dim">
                  {isMe ? "You" : first(player.displayName)}
                </span>
              </header>

              <Line
                label="said"
                value={said === null ? null : (view.options[said] ?? null)}
                strong
              />
              <Line
                label={`${isMe ? theirName : meName} guessed`}
                value={guessed === null ? null : (view.options[guessed] ?? null)}
                hit={hit}
              />
            </section>
          );
        })}
      </div>

      <p className="text-center text-sm text-fg-dim">
        {scored === 2
          ? "Both of you. Straight through."
          : scored === 1
            ? "One of you had it."
            : "Neither. Which is its own kind of information."}
      </p>
    </div>
  );
}

function Line({
  label,
  value,
  strong = false,
  hit,
}: {
  label: string;
  value: string | null;
  strong?: boolean;
  hit?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.625rem] text-fg-faint">{label}</span>
      <span className="flex items-start gap-1.5">
        <span
          className={cn(
            "min-w-0 flex-1 text-sm",
            value === null ? "text-fg-faint italic" : strong ? "text-fg-loud" : "text-fg",
          )}
        >
          {value ?? "Ran out of time"}
        </span>
        {hit === undefined || value === null ? null : (
          <span
            aria-hidden="true"
            className={cn(
              "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full",
              hit ? "bg-moss text-on-accent" : "border border-line text-fg-faint",
            )}
          >
            <Icon name={hit ? "check" : "close"} size={9} />
          </span>
        )}
      </span>
    </div>
  );
}

function Countdown({ remaining, inCount }: { remaining: number; inCount: number }) {
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  const urgent = seconds <= 8;

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

/** Who has committed. Never to what. */
function Waiting({
  players,
  submitted,
  mySeat,
}: {
  players: BoardProps["players"];
  submitted: number[];
  mySeat: number | null;
}) {
  return (
    <ul className="flex items-center justify-center gap-6 py-1">
      {players.map((player) => {
        const done = submitted.includes(player.seat);

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
              {player.seat === mySeat ? "You" : first(player.displayName)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The ending.
 *
 * The pair's combined total is the headline, in the largest type on the screen,
 * and the two individual counts sit under it in the same size as each other.
 *
 * Showing them separately is a departure from How Well Do You Know Me?, and it
 * is defensible here for one specific reason: both people made a prediction
 * about the same question in every round, so the two numbers are measuring the
 * same thing. In How Well only one of them guesses per round, so a personal
 * total would mostly record who drew the easier questions.
 *
 * There is still no winner. Neither number is styled as beating the other, the
 * engine names both seats as winners, and the closing line is about the pair.
 */
export function GuessMyAnswerResult({
  scores,
  together,
  total,
  players,
  mySeat,
}: {
  scores: Record<number, number>;
  together: number;
  total: number;
  players: BoardProps["players"];
  mySeat: number | null;
}) {
  const { title, line } = describeTogether(together, total);

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <div className="flex items-baseline gap-1.5">
        <span className="numeric display text-d-md text-plum">{together}</span>
        <span className="numeric text-md text-fg-faint">/ {total}</span>
      </div>

      <div className="flex flex-col gap-1">
        <p className="heading text-md text-fg-loud">{title}</p>
        <p className="max-w-sm text-sm text-fg-dim">{line}</p>
      </div>

      {/* Two counts, deliberately identical in weight. */}
      <ul className="flex items-center gap-6">
        {players.map((player) => (
          <li key={player.userId} className="flex flex-col items-center gap-1">
            <Avatar
              name={player.displayName}
              seed={player.userId}
              size="sm"
              src={player.avatarUrl}
            />
            <span className="numeric text-sm text-fg-loud tabular-nums">
              {scores[player.seat] ?? 0}
            </span>
            <span className="text-[0.625rem] text-fg-faint">
              {player.seat === mySeat ? "You" : first(player.displayName)}
            </span>
          </li>
        ))}
      </ul>

      <p className="max-w-xs text-2xs text-fg-faint">
        Four multiple-choice questions about biscuits do not add up to a fact about anybody. Enjoy
        the arguments.
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
