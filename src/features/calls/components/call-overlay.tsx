"use client";

import { useEffect, useRef, useState } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useCall } from "@/features/calls/call-provider";
import { CALL_TICK_MS } from "@/features/calls/constants";
import { describeConnection, formatDuration } from "@/features/calls/describe";
import { cn } from "@/lib/utils/cn";

/**
 * Every state of a call, on one surface.
 *
 * Incoming, outgoing and connected are the same object at three moments, so they
 * are one component that changes rather than three that swap. The avatar does
 * not move between ringing and answered; only what surrounds it does. A person
 * who has just pressed answer should see the call they were already looking at.
 *
 * ── Where it sits ────────────────────────────────────────────────────────────
 *
 * A ring is a full-screen event: it is the only thing that matters until it is
 * dealt with, and burying it in a corner is how calls get missed. Once
 * connected, it shrinks to a bar — you are meant to carry on using the app while
 * talking, and a modal over the whole screen would stop that.
 *
 * The `<audio>` element is mounted for the life of the overlay rather than
 * conditionally: attaching a stream to an element that has only just appeared is
 * the single most common cause of a call that connects but is silent.
 */
export function CallOverlay() {
  const call = useCall();

  if (call.phase === "idle") {
    return call.error ? <CallError message={call.error} onDismiss={call.dismissError} /> : null;
  }

  return (
    <>
      <RemoteAudio stream={call.remoteStream} />
      {call.phase === "active" ? <ConnectedBar /> : <RingingScreen />}
    </>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The other person's voice.
 *
 * `autoPlay` plus a `srcObject` set in an effect — a `src` attribute cannot
 * carry a MediaStream, and this is the one piece of a voice call with no visual
 * feedback at all, so it is kept deliberately boring.
 */
function RemoteAudio({ stream }: { stream: MediaStream | null }) {
  const element = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = element.current;
    if (!audio) return;

    audio.srcObject = stream;
    if (stream) {
      // Blocked before any interaction on some browsers. The person is mid-call,
      // so they have interacted — but a rejection must not throw into a render.
      void audio.play().catch(() => {});
    }
  }, [stream]);

  return <audio ref={element} autoPlay playsInline className="hidden" />;
}

/* -------------------------------------------------------------------------- */

function RingingScreen() {
  const { call, phase, busy, answer, decline, hangUp } = useCall();
  if (!call) return null;

  const incoming = phase === "incoming";
  const name = call.peer?.displayName ?? "Someone";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={incoming ? `Incoming call from ${name}` : `Calling ${name}`}
      className={cn(
        "fixed inset-0 z-[var(--z-modal)] grid place-items-center",
        "bg-[var(--wash-scrim)] backdrop-blur-md",
      )}
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-8 px-6 text-center">
        <div className="relative">
          {/* The ring, drawn. Two expanding rings on a slow loop — the visual
              half of the sound, and the half that still works when the browser
              refuses to play audio. */}
          {incoming ? (
            <>
              <span className="pulse-ember absolute inset-0 rounded-full" aria-hidden="true" />
              <span
                className="pulse-ember absolute inset-0 rounded-full [animation-delay:0.6s]"
                aria-hidden="true"
              />
            </>
          ) : null}

          <Avatar
            name={name}
            seed={call.peer?.id ?? call.id}
            size="xl"
            src={call.peer?.avatarUrl ?? null}
            className="relative"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <h2 className="heading text-d-xs text-fg-loud">{name}</h2>
          <p className="text-sm text-fg-dim">
            {incoming ? "is calling you" : busy ? "Connecting…" : "Ringing…"}
          </p>
          {call.peer?.username ? (
            <p className="numeric text-2xs text-fg-faint">@{call.peer.username}</p>
          ) : null}
        </div>

        <div className="flex items-center gap-4">
          {incoming ? (
            <>
              <RoundButton
                tone="decline"
                label="Decline"
                onClick={() => void decline()}
                disabled={busy}
              />
              <RoundButton
                tone="answer"
                label="Answer"
                onClick={() => void answer()}
                disabled={busy}
              />
            </>
          ) : (
            <RoundButton
              tone="decline"
              label="Cancel call"
              onClick={() => void hangUp()}
              disabled={busy}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The answer and hang-up buttons.
 *
 * Deliberately not `<Button>`. These are the two controls in KITH that must be
 * hit correctly under pressure and without reading: big, round, colour-coded,
 * and far enough apart that a thumb cannot catch the wrong one. Everything else
 * in the app uses the design system; this is the exception that earns it.
 */
function RoundButton({
  tone,
  label,
  onClick,
  disabled,
}: {
  tone: "answer" | "decline";
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "control-focus grid size-16 place-items-center rounded-full transition-transform",
        "duration-[var(--t-quick)] hover:scale-105 active:scale-95 disabled:opacity-50",
        tone === "answer"
          ? "bg-moss text-on-accent shadow-raised"
          : "bg-signal text-on-accent shadow-raised",
      )}
    >
      <Icon
        name="calls"
        size={24}
        // The rotated handset is the universal hang-up glyph; it needs no
        // second icon and reads at a glance in a way a word does not.
        className={tone === "decline" ? "rotate-[135deg]" : undefined}
      />
    </button>
  );
}

/* -------------------------------------------------------------------------- */

function ConnectedBar() {
  const { call, connection, micEnabled, remoteMicEnabled, toggleMic, hangUp, busy } = useCall();
  const elapsed = useElapsed(call?.answeredAt ?? null);

  if (!call) return null;

  const name = call.peer?.displayName ?? "Someone";
  const status = describeConnection(connection);
  const unsettled = connection !== "connected";

  return (
    <div
      role="region"
      aria-label={`Call with ${name}`}
      className={cn(
        "fixed inset-x-0 bottom-0 z-[var(--z-overlay)] sm:inset-x-auto sm:right-6 sm:bottom-6",
        "sm:w-[22rem]",
      )}
    >
      <div className="panel panel-overlay lit-edge flex items-center gap-3 p-3 sm:rounded-soft">
        <span className="relative shrink-0">
          <Avatar
            name={name}
            seed={call.peer?.id ?? call.id}
            size="sm"
            src={call.peer?.avatarUrl ?? null}
          />
          {!remoteMicEnabled ? (
            <span
              aria-hidden="true"
              className="absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-raised ring-2 ring-[var(--panel-overlay-bg,var(--bg-raised))]"
            >
              <Icon name="micOff" size={9} className="text-signal" />
            </span>
          ) : null}
        </span>

        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-fg-loud">{name}</span>
          <span
            className={cn(
              "numeric text-2xs",
              unsettled ? "text-signal" : "text-fg-faint",
              connection === "reconnecting" && "animate-pulse",
            )}
          >
            {/* The timer only runs once there is a call to time. While it is
                still connecting, saying so is more use than 0:00. */}
            {unsettled ? status : elapsed}
            {!remoteMicEnabled && !unsettled ? " · muted" : ""}
          </span>
        </div>

        <button
          type="button"
          onClick={toggleMic}
          aria-label={micEnabled ? "Mute" : "Unmute"}
          aria-pressed={!micEnabled}
          title={micEnabled ? "Mute" : "Unmute"}
          className={cn(
            "control-focus grid size-9 shrink-0 place-items-center rounded-full border transition-colors",
            "duration-[var(--t-quick)]",
            micEnabled
              ? "border-line bg-raised text-fg hover:border-line-lit"
              : "border-signal bg-signal text-on-accent",
          )}
        >
          <Icon name={micEnabled ? "mic" : "micOff"} size={16} />
        </button>

        <button
          type="button"
          onClick={() => void hangUp()}
          disabled={busy}
          aria-label="Hang up"
          title="Hang up"
          className={cn(
            "control-focus grid size-9 shrink-0 place-items-center rounded-full",
            "bg-signal text-on-accent transition-transform duration-[var(--t-quick)]",
            "hover:scale-105 active:scale-95 disabled:opacity-50",
          )}
        >
          <Icon name="calls" size={16} className="rotate-[135deg]" />
        </button>
      </div>
    </div>
  );
}

/** Ticks the call timer. Derived from the answer time, never accumulated. */
function useElapsed(answeredAt: string | null): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!answeredAt) return;
    const timer = setInterval(() => setNow(Date.now()), CALL_TICK_MS);
    return () => clearInterval(timer);
  }, [answeredAt]);

  if (!answeredAt) return "0:00";

  // Recomputed from the timestamp on every tick rather than incremented, so a
  // throttled background tab comes back with the right time instead of a clock
  // that lost however long it was asleep.
  const started = new Date(answeredAt).getTime();
  return formatDuration((now - started) / 1000);
}

/* -------------------------------------------------------------------------- */

function CallError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 6000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-6 z-[var(--z-toast)] mx-auto w-fit max-w-[calc(100vw-2rem)]"
    >
      <div className="panel panel-overlay flex items-center gap-3 rounded-soft px-4 py-3">
        <Icon name="alert" size={15} className="shrink-0 text-signal" />
        <span className="text-sm text-fg">{message}</span>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
