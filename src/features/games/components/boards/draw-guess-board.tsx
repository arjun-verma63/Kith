"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { BoardProps } from "@/features/games/components/boards/registry";
import { DrawCanvas } from "@/features/games/components/boards/draw-canvas";
import { channels } from "@/lib/supabase/realtime";
import { subscribeToTopic } from "@/lib/supabase/shared-channel";
import { cn } from "@/lib/utils/cn";

/**
 * Draw & Guess, drawn.
 *
 * The canvas and the chat, side by side on a wide screen and stacked on a phone.
 *
 * ── Two channels of traffic, one socket ──────────────────────────────────────
 *
 * Guesses are MOVES: they go through the server, get judged there, and come back
 * as state. Strokes are BROADCAST: client to client, never stored, never
 * validated. Both travel on the same `game:{id}` topic, which is shared rather
 * than opened twice — see `lib/supabase/shared-channel.ts`.
 *
 * ── The one thing a client has to police ─────────────────────────────────────
 *
 * The channel's write policy allows any player to broadcast, because SQL cannot
 * know which of them is drawing this round. So stroke events from anybody who is
 * not the current drawer are ignored here. The worst a mischievous player can do
 * is send messages nobody applies.
 */

interface PublicState {
  round: number;
  totalRounds: number;
  phase: "drawing" | "revealed";
  deadline: number;
  roundMs: number;
  drawerSeat: number;
  wordLength: number;
  hint: string;
  word: string | null;
  solvedSeats: number[];
  chat: { seat: number; text: string | null; kind: "guess" | "correct" | "close" }[];
  scores: Record<string, number>;
  drawerPoints: number;
}

interface PrivateState extends PublicState {
  mySeat: number;
  amDrawer: boolean;
  secretWord: string | null;
  hasSolved: boolean;
}

export function DrawGuessBoard({
  publicState,
  privateState,
  mySeat,
  players,
  submit,
  busy,
  sessionId,
}: BoardProps) {
  const view = publicState as PublicState | null;
  const mine = privateState as PrivateState | null;

  const [error, setError] = useState<string | null>(null);
  const remaining = useCountdown(view?.deadline ?? 0, view?.phase === "drawing");

  const drawer = players.find((player) => player.seat === view?.drawerSeat);
  const amDrawer = mySeat !== null && mySeat === view?.drawerSeat;
  const drawerSeat = view?.drawerSeat ?? -1;

  /* ------------------------------------------------------- the canvas wire */

  // Handlers live in a ref so the subscription is opened once per session rather
  // than rebuilt on every render — a canvas that resubscribes drops strokes.
  const canvasHandler = useRef<((event: string, payload: unknown) => void) | null>(null);
  const channel = useRef<{ send: (event: string, payload: unknown) => void } | null>(null);

  // Who is drawing changes every round, but the subscription must not be rebuilt
  // when it does — a canvas that resubscribes drops strokes. Kept in a ref and
  // updated in an effect, so the handler always reads the current value without
  // being recreated.
  const drawerSeatRef = useRef(drawerSeat);
  useEffect(() => {
    drawerSeatRef.current = drawerSeat;
  }, [drawerSeat]);

  useEffect(() => {
    const relay = (event: string) => (payload: unknown) => {
      const from = (payload as { from?: number } | null)?.from;
      // Only the current drawer's strokes are applied. The channel cannot
      // enforce this — it does not know who is drawing — so the client does.
      if (event !== "draw.request" && from !== drawerSeatRef.current) return;
      canvasHandler.current?.(event, payload);
    };

    const subscription = subscribeToTopic(channels.game(sessionId), {
      "draw.chunk": relay("draw.chunk"),
      "draw.clear": relay("draw.clear"),
      "draw.undo": relay("draw.undo"),
      "draw.snapshot": relay("draw.snapshot"),
      // A catch-up request may come from anybody who can see the game.
      "draw.request": (payload) => canvasHandler.current?.("draw.request", payload),
    });

    channel.current = subscription;
    return () => {
      channel.current = null;
      subscription.unsubscribe();
    };
  }, [sessionId]);

  /** Stamped with the sender's seat so receivers can ignore impostors. */
  const send = useCallback(
    (event: string, payload: unknown) => {
      channel.current?.send(event, { ...(payload as object), from: mySeat });
    },
    [mySeat],
  );

  const subscribeCanvas = useCallback((handler: (event: string, payload: unknown) => void) => {
    canvasHandler.current = handler;
    return () => {
      canvasHandler.current = null;
    };
  }, []);

  /* ---------------------------------------------------------- round timing */

  const asked = useRef(0);
  useEffect(() => {
    if (!view || mySeat === null) return;
    if (view.phase !== "drawing" || remaining > 0) return;
    if (asked.current === view.round + 1) return;

    asked.current = view.round + 1;
    void submit({ type: "reveal" });
  }, [view, remaining, mySeat, submit]);

  const sendMove = async (move: unknown) => {
    setError(null);
    const failure = await submit(move);
    if (failure && !failure.startsWith("The game moved on")) setError(failure);
  };

  if (!view) {
    return (
      <div className="panel panel-sunken grid min-h-40 place-items-center rounded-soft p-6">
        <p className="text-sm text-fg-faint">Setting up…</p>
      </div>
    );
  }

  const revealed = view.phase === "revealed";
  const solved = mine?.hasSolved ?? false;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <span className="label text-fg-faint">
          Round {view.round + 1} of {view.totalRounds}
        </span>

        {/* The word, as much of it as anybody is allowed to see. */}
        <span className="numeric flex items-center gap-2 text-sm tracking-[0.2em] text-fg-loud">
          {amDrawer && mine?.secretWord ? (
            <span className="tracking-normal text-ember">{mine.secretWord}</span>
          ) : revealed && view.word ? (
            <span className="tracking-normal text-moss">{view.word}</span>
          ) : (
            <span aria-label={`${view.wordLength} letters`}>{view.hint}</span>
          )}
        </span>

        {revealed ? (
          <span className="numeric text-2xs text-fg-faint">{view.solvedSeats.length} got it</span>
        ) : (
          <Countdown remaining={remaining} total={view.roundMs} />
        )}
      </header>

      <p className="text-center text-2xs text-fg-faint">
        {revealed ? (
          <>
            The word was <span className="text-fg">{view.word}</span>.
            {view.drawerPoints > 0 ? (
              <>
                {" "}
                {drawer?.displayName ?? "The drawer"} scored{" "}
                <span className="numeric text-moss">{view.drawerPoints}</span>.
              </>
            ) : null}
          </>
        ) : amDrawer ? (
          "Draw it. No letters, no numbers, no pointing at the screen."
        ) : (
          <>
            <span className="text-fg">{drawer?.displayName ?? "Somebody"}</span> is drawing. Type
            your guess.
          </>
        )}
      </p>

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <DrawCanvas
          canDraw={amDrawer && !revealed}
          send={send}
          subscribe={subscribeCanvas}
          roundKey={view.round}
        />

        <Chat
          view={view}
          players={players}
          mySeat={mySeat}
          amDrawer={amDrawer}
          solved={solved}
          revealed={revealed}
          busy={busy}
          onGuess={(text) => void sendMove({ type: "guess", text })}
        />
      </div>

      {revealed && mySeat !== null ? (
        <div className="flex justify-center">
          <Button
            variant="lit"
            size="sm"
            loading={busy}
            onClick={() => void sendMove({ type: "next" })}
          >
            {view.round + 1 >= view.totalRounds ? "Finish" : "Next round"}
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

function Chat({
  view,
  players,
  mySeat,
  amDrawer,
  solved,
  revealed,
  busy,
  onGuess,
}: {
  view: PublicState;
  players: BoardProps["players"];
  mySeat: number | null;
  amDrawer: boolean;
  solved: boolean;
  revealed: boolean;
  busy: boolean;
  onGuess: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const list = useRef<HTMLUListElement>(null);

  const nameOf = useMemo(
    () => new Map(players.map((player) => [player.seat, player.displayName])),
    [players],
  );

  // Pinned to the newest line, the way every chat since the beginning of time
  // has behaved.
  useEffect(() => {
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [view.chat.length]);

  const canGuess = mySeat !== null && !amDrawer && !solved && !revealed;

  return (
    <div className="panel flex h-full max-h-[26rem] min-h-56 flex-col rounded-soft lg:max-h-none">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="label text-fg-faint">Guesses</span>
        <span className="flex -space-x-1.5">
          {players
            .filter((player) => view.solvedSeats.includes(player.seat))
            .map((player) => (
              <Avatar
                key={player.userId}
                name={player.displayName}
                seed={player.userId}
                size="2xs"
                src={player.avatarUrl}
                className="ring-1 ring-moss"
              />
            ))}
        </span>
      </div>

      <ul ref={list} className="flex-1 overflow-y-auto px-3 py-2">
        {view.chat.length === 0 ? (
          <li className="py-4 text-center text-2xs text-fg-faint">Nothing yet.</li>
        ) : (
          view.chat.map((line, index) => (
            <li key={index} className="py-0.5 text-sm">
              {line.kind === "correct" ? (
                // The word itself is never here. Printing it would hand the
                // answer to everybody still guessing.
                <span className="text-moss">
                  <span className="font-medium">{nameOf.get(line.seat) ?? "Somebody"}</span> got it
                </span>
              ) : (
                <span className={cn(line.kind === "close" && "text-ember")}>
                  <span className="text-fg-dim">{nameOf.get(line.seat) ?? "Somebody"}</span>{" "}
                  <span className="text-fg">{line.text}</span>
                  {line.kind === "close" && line.seat === mySeat ? (
                    <span className="text-2xs text-ember"> · close</span>
                  ) : null}
                </span>
              )}
            </li>
          ))
        )}
      </ul>

      <form
        className="flex items-center gap-2 border-t border-line p-2"
        onSubmit={(event) => {
          event.preventDefault();
          const value = text.trim();
          if (!value || !canGuess) return;
          setText("");
          onGuess(value);
        }}
      >
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={!canGuess || busy}
          maxLength={48}
          placeholder={
            amDrawer
              ? "You are drawing"
              : solved
                ? "You got it"
                : revealed
                  ? "Round over"
                  : "Your guess…"
          }
          aria-label="Your guess"
          className="input min-w-0 flex-1 text-sm"
        />
        <button
          type="submit"
          disabled={!canGuess || busy || text.trim().length === 0}
          aria-label="Send guess"
          className="control-focus grid size-8 shrink-0 place-items-center rounded-inset bg-raised text-fg-dim hover:text-ember disabled:opacity-40"
        >
          <Icon name="send" size={14} />
        </button>
      </form>
    </div>
  );
}

function Countdown({ remaining, total }: { remaining: number; total: number }) {
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  const fraction = total > 0 ? remaining / total : 0;
  const urgent = seconds <= 10;

  return (
    <span className="flex items-center gap-2">
      {/* A bar as well as a number: at a glance you want "lots of time" or "no
          time", not arithmetic. */}
      <span aria-hidden="true" className="h-1 w-16 overflow-hidden rounded-full bg-raised">
        <span
          className={cn("block h-full transition-[width]", urgent ? "bg-signal" : "bg-ember")}
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
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

/** Milliseconds left, recomputed from the deadline so a throttled tab recovers. */
function useCountdown(deadline: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running, deadline]);

  return useMemo(() => Math.max(0, deadline - now), [deadline, now]);
}
