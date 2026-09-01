"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

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
  const {
    call,
    connection,
    route,
    micEnabled,
    screenSharing,
    screenShareSupported,
    localScreenStream,
    remoteMicEnabled,
    remoteScreenSharing,
    remoteStream,
    toggleMic,
    toggleScreenShare,
    hangUp,
    busy,
  } = useCall();
  const elapsed = useElapsed(call?.answeredAt ?? null);

  // Detected here rather than inside the stage: the panel has to be open before
  // the stage can render anything, and a video track can arrive before the
  // broadcast announcing it — renegotiation and a broadcast are different paths.
  const hasRemoteVideo = useHasVideoTrack(remoteStream);

  if (!call) return null;

  const name = call.peer?.displayName ?? "Someone";
  const status = describeConnection(connection);
  const unsettled = connection !== "connected";

  // The panel grows when there is something to look at. A voice call is a strip;
  // a shared screen needs room, and the same element becoming bigger reads as one
  // call changing rather than two surfaces swapping.
  const showing = screenSharing || remoteScreenSharing || hasRemoteVideo;

  return (
    <div
      role="region"
      aria-label={`Call with ${name}`}
      className={cn(
        "fixed inset-x-0 z-[var(--z-overlay)] sm:inset-x-auto sm:right-6 sm:bottom-6",
        // Docked above the bottom navigation rather than on top of it, so the
        // call does not cover the way out of the call. Zero from `lg`.
        "bottom-[var(--nav-bar-h)] sm:bottom-6",
        "transition-[width] duration-[var(--t-settle)]",
        showing ? "sm:w-[30rem]" : "sm:w-[22rem]",
      )}
    >
      <div className="panel panel-overlay lit-edge flex flex-col overflow-hidden sm:rounded-soft">
        {showing ? (
          <ScreenStage
            localStream={localScreenStream}
            remoteStream={remoteStream}
            sharing={screenSharing}
            remoteSharing={remoteScreenSharing}
            hasRemoteVideo={hasRemoteVideo}
            peerName={name}
            onStop={() => void toggleScreenShare()}
          />
        ) : null}

        <div className="flex items-center gap-3 p-3">
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
              {remoteScreenSharing && !unsettled ? " · sharing" : ""}
              {/* Said out loud because it explains latency, and because it is
                  the only way anybody finds out whether the relay is being used
                  at all. Direct connections say nothing — that is normal. */}
              {route === "relayed" && !unsettled ? " · relayed" : ""}
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

          {/* Hidden, not disabled, where the browser has no getDisplayMedia — iOS,
            embedded webviews, insecure origins. A control that can never work is
            not a control. */}
          {screenShareSupported ? (
            <button
              type="button"
              onClick={() => void toggleScreenShare()}
              aria-label={screenSharing ? "Stop sharing your screen" : "Share your screen"}
              aria-pressed={screenSharing}
              title={screenSharing ? "Stop sharing your screen" : "Share your screen"}
              className={cn(
                "control-focus grid size-9 shrink-0 place-items-center rounded-full border",
                "transition-colors duration-[var(--t-quick)]",
                screenSharing
                  ? "border-ember bg-ember text-on-accent"
                  : "border-line bg-raised text-fg hover:border-line-lit hover:text-ember",
              )}
            >
              <Icon name="screen" size={16} />
            </button>
          ) : null}

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
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The screen, whoever is sharing it.
 *
 * Remote takes precedence when both are: what somebody else is showing you is
 * the thing you cannot see any other way, whereas your own screen is behind the
 * browser window. Your share still gets its own strip so you are never sharing
 * without being told.
 */
function ScreenStage({
  localStream,
  remoteStream,
  sharing,
  remoteSharing,
  hasRemoteVideo,
  peerName,
  onStop,
}: {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  sharing: boolean;
  remoteSharing: boolean;
  hasRemoteVideo: boolean;
  peerName: string;
  onStop: () => void;
}) {
  // Rendering follows the TRACK; the label follows the announcement. Either one
  // alone would produce a wrong frame — a black rectangle when the announcement
  // is stale, or nothing at all when it is late.
  const showRemote = hasRemoteVideo || remoteSharing;

  return (
    <div className="flex flex-col">
      {showRemote ? (
        <ScreenVideo
          stream={remoteStream}
          label={`${peerName}'s screen`}
          waiting={!hasRemoteVideo}
        />
      ) : null}

      {sharing ? (
        <div
          className={cn(
            "flex items-center gap-2.5 border-b border-line px-3 py-2",
            // Ember, not a neutral. Sharing a screen is the one state in KITH
            // where forgetting you are in it has real consequences, so it is
            // coloured like something that is happening rather than something
            // that is available.
            "bg-[var(--wash-accent)]",
          )}
        >
          <span className="relative grid size-5 shrink-0 place-items-center">
            <span className="pulse-ember absolute inset-0 rounded-full" aria-hidden="true" />
            <Icon name="screen" size={13} className="relative text-ember" />
          </span>

          <span className="min-w-0 flex-1 text-2xs text-fg-loud">
            You&rsquo;re sharing your screen
          </span>

          <button
            type="button"
            onClick={onStop}
            className="control-focus rounded-edge text-2xs font-medium text-ember hover:underline"
          >
            Stop
          </button>
        </div>
      ) : null}

      {/* Your own screen, only when theirs is not already filling the stage.
          Seeing what you are actually showing is the point — a preview is how
          people notice they picked the wrong window. */}
      {sharing && !showRemote ? (
        <ScreenVideo stream={localStream} label="Your screen" muted />
      ) : null}
    </div>
  );
}

/**
 * One video surface.
 *
 * `muted` on every one of these: the audio arrives through the `<audio>` element
 * that is mounted for the whole call, and a second element playing the same
 * stream would double it.
 */
function ScreenVideo({
  stream,
  label,
  muted = true,
  waiting = false,
}: {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
  waiting?: boolean;
}) {
  const element = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = element.current;
    if (!video) return;

    video.srcObject = stream;
    if (stream) void video.play().catch(() => {});

    return () => {
      // Released on unmount so the decoder is not left holding a stream that is
      // no longer on screen.
      video.srcObject = null;
    };
  }, [stream]);

  return (
    <div className="relative aspect-video w-full overflow-hidden bg-sunken">
      <video
        ref={element}
        autoPlay
        playsInline
        muted={muted}
        aria-label={label}
        // `contain`, never `cover`. A shared screen cropped to fit is a shared
        // screen with the edges cut off, which is where the toolbars live.
        className="size-full object-contain"
      />

      {waiting ? (
        <div className="absolute inset-0 grid place-items-center">
          <span className="text-2xs text-fg-faint">Waiting for the screen&hellip;</span>
        </div>
      ) : null}

      <span className="absolute bottom-1.5 left-2 rounded-edge bg-[var(--wash-scrim)] px-1.5 py-0.5 text-[0.625rem] text-fg-dim backdrop-blur-sm">
        {label}
      </span>
    </div>
  );
}

/**
 * Whether a stream is carrying live video right now.
 *
 * Two things make this less obvious than it looks.
 *
 * `remoteStream` keeps the same object identity when a track is added to it —
 * the browser mutates the stream rather than replacing it — so React never
 * re-renders on its own when a screen share starts.
 *
 * And stopping a share does NOT end the remote track. `replaceTrack(sender,
 * null)` leaves the transceiver in place and the receiver's track alive but
 * MUTED; `ended` only fires when the connection goes away. Watching for `ended`
 * alone would leave a frozen last frame on screen for the rest of the call.
 * So the test is live AND unmuted, and `mute`/`unmute` are the events that
 * matter most.
 *
 * `useSyncExternalStore` rather than an effect: this is a subscription to
 * something outside React, which is exactly what it is for, and it renders
 * correctly on the server (where there is no stream) without a mismatch.
 */
function useHasVideoTrack(stream: MediaStream | null): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!stream) return () => {};

      // Tracks arriving later need the same listeners, and `subscribe` does not
      // re-run for them — so attaching is repeated whenever the set changes.
      const listening = new Set<MediaStreamTrack>();

      const attach = () => {
        for (const track of stream.getVideoTracks()) {
          if (listening.has(track)) continue;
          listening.add(track);
          track.addEventListener("mute", onChange);
          track.addEventListener("unmute", onChange);
          track.addEventListener("ended", onChange);
        }
      };

      const handle = () => {
        attach();
        onChange();
      };

      attach();
      stream.addEventListener("addtrack", handle);
      stream.addEventListener("removetrack", handle);

      return () => {
        stream.removeEventListener("addtrack", handle);
        stream.removeEventListener("removetrack", handle);
        for (const track of listening) {
          track.removeEventListener("mute", onChange);
          track.removeEventListener("unmute", onChange);
          track.removeEventListener("ended", onChange);
        }
      };
    },
    [stream],
  );

  const snapshot = useCallback(
    () => stream?.getVideoTracks().some((t) => t.readyState === "live" && !t.muted) ?? false,
    [stream],
  );

  return useSyncExternalStore(subscribe, snapshot, returnFalse);
}

const returnFalse = () => false;

/* -------------------------------------------------------------------------- */

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
      className={cn(
        "fixed inset-x-0 z-[var(--z-toast)] mx-auto w-fit",
        // `dvw` rather than `vw`: on a phone with a visible scrollbar gutter
        // `100vw` is wider than the viewport, which pushes a centred toast
        // off-centre and can introduce a horizontal scroll.
        "max-w-[calc(100dvw-2rem)]",
        "bottom-[calc(var(--nav-bar-h)+1.5rem)] sm:bottom-6",
      )}
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
