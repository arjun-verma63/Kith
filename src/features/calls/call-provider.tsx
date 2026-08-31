"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  answerCallAction,
  endCallAction,
  refreshActiveCallAction,
  setCallMediaStateAction,
  startCallAction,
  type CallResult,
} from "@/features/calls/actions";
import { CallOverlay } from "@/features/calls/components/call-overlay";
import { RING_TIMEOUT_MS } from "@/features/calls/constants";
import type { ActiveCall } from "@/features/calls/queries";
import { startRinging, stopRinging } from "@/features/calls/ringtone";
import { useLocalMedia } from "@/features/calls/use-local-media";
import { usePeerConnection } from "@/features/calls/use-peer-connection";
import { subscribeToUserEvents } from "@/lib/supabase/user-channel";
import type { PeerState } from "@/lib/webrtc/peer";
import type { MediaState } from "@/lib/webrtc/signaling";

/**
 * The one place a call exists.
 *
 * Mounted once, in the app shell, for three reasons that all come down to the
 * same thing: a call outlives the page you were on when it started.
 *
 *   - A call can arrive while you are anywhere. The ring has to follow you.
 *   - Navigating from Messages to Friends must not tear down the audio. If the
 *     peer connection lived in a route, it would.
 *   - There is only ever one call, and one place holding it is what makes that
 *     true rather than hoped for.
 *
 * ── The division of labour ───────────────────────────────────────────────────
 *
 * This file owns *what the call is* — ringing, answered, over — and gets that
 * from the database, which is the authority. `lib/webrtc` owns the connection.
 * The join between them is one line: when the status becomes `active`, the peer
 * connection is enabled.
 *
 * Nothing here decides whether a call was missed, declined or cancelled. That is
 * derived server-side in `end_call`, because it drives a notification and an end
 * reason a client could name is an end reason a client could forge.
 */

export interface CallContextValue {
  call: ActiveCall | null;
  phase: "idle" | "outgoing" | "incoming" | "active";
  connection: PeerState;
  micEnabled: boolean;
  screenSharing: boolean;
  screenShareSupported: boolean;
  /** Your own screen, so you can see exactly what you are showing. */
  localScreenStream: MediaStream | null;
  /** What the other side says it is sending. Never inferred from the audio. */
  remoteMicEnabled: boolean;
  remoteScreenSharing: boolean;
  remoteStream: MediaStream | null;
  error: string | null;
  busy: boolean;
  startCall: (conversationId: string) => Promise<void>;
  answer: () => Promise<void>;
  decline: () => Promise<void>;
  hangUp: () => Promise<void>;
  toggleMic: () => void;
  /** Call straight from a click handler — the picker needs the activation. */
  toggleScreenShare: () => Promise<void>;
  dismissError: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

export function useCall(): CallContextValue {
  const value = useContext(CallContext);
  if (!value) throw new Error("useCall must be used inside <CallProvider>.");
  return value;
}

/** The broadcast payload. Small on purpose — it is sent on every transition. */
interface CallEvent {
  id?: string;
  conversation_id?: string;
  initiator_id?: string;
  initiator_display_name?: string;
  initiator_username?: string;
  status?: string;
  started_at?: string;
  answered_at?: string | null;
}

function messageFor(result: Extract<CallResult, { ok: false }>): string {
  switch (result.reason) {
    case "busy":
      return "You are already on a call.";
    case "gone":
      return "That call has already ended.";
    case "not_permitted":
      return "You cannot call this conversation.";
    case "unauthenticated":
      return "Sign in again to make a call.";
    default:
      return "Something went wrong with that call.";
  }
}

export function CallProvider({
  userId,
  initialCall,
  children,
}: {
  userId: string;
  initialCall: ActiveCall | null;
  children: React.ReactNode;
}) {
  const [call, setCall] = useState<ActiveCall | null>(initialCall);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The video sender, handed to the media controller so a screen share reaches
  // the far end. `setVideoTrack` replaces the track on the existing sender when
  // there is one and adds a sender only the first time — which on a voice call
  // is the first share, and is the one renegotiation the feature costs.
  const setVideoTrack = useRef<(track: MediaStreamTrack | null) => Promise<void>>(async () => {});

  const media = useLocalMedia({
    onVideoTrack: (track) => setVideoTrack.current(track),
  });

  const phase: CallContextValue["phase"] = !call
    ? "idle"
    : call.status === "active"
      ? "active"
      : call.isInitiator
        ? "outgoing"
        : "incoming";

  const peer = usePeerConnection({
    callId: call?.id ?? "",
    selfId: userId,
    peerId: call?.peer?.id ?? "",
    localStream: media.stream,
    // Nothing is created until there is a real call with a real other person.
    enabled: phase === "active" && Boolean(call?.peer),
    onHangup: () => {
      // The other side left. The database transition is theirs to make; this
      // just stops showing a call that is over.
      stopRinging();
      media.stop();
      setCall(null);
    },
  });

  useEffect(() => {
    setVideoTrack.current = peer.setVideoTrack;
  }, [peer.setVideoTrack]);

  // Kept in a ref so the socket handlers and the timeout do not have to be
  // rebuilt every time the call object changes identity.
  const callRef = useRef(call);
  useEffect(() => {
    callRef.current = call;
  });

  const refresh = useCallback(async () => {
    const fresh = await refreshActiveCallAction();
    setCall(fresh);
    return fresh;
  }, []);

  /* ------------------------------------------------------------- lifecycle */

  useEffect(() => {
    return subscribeToUserEvents(userId, {
      "call.incoming": (payload) => {
        const event = payload as CallEvent;
        // Your own outgoing call comes back on this channel too; ignore it,
        // `startCall` already has the authoritative row.
        if (!event.id || event.initiator_id === userId) return;
        if (callRef.current) return;

        // Rendered immediately from the broadcast so the ring is instant, then
        // filled in — the payload cannot carry a signed avatar URL.
        setCall({
          id: event.id,
          conversationId: event.conversation_id ?? "",
          status: "ringing",
          kind: "audio",
          isInitiator: false,
          startedAt: event.started_at ?? new Date().toISOString(),
          answeredAt: null,
          joinedAt: null,
          participantCount: 2,
          peer: {
            id: event.initiator_id ?? "",
            username: event.initiator_username ?? "",
            displayName: event.initiator_display_name ?? "Someone",
            avatarUrl: null,
          },
        });
        void refresh();
      },

      "call.updated": (payload) => {
        const event = payload as CallEvent;
        if (!event.id || event.id !== callRef.current?.id) return;
        void refresh();
      },

      "call.ended": (payload) => {
        const event = payload as CallEvent;
        if (!event.id || event.id !== callRef.current?.id) return;
        stopRinging();
        media.stop();
        setCall(null);
      },
    });
    // `media` is a stable set of callbacks over a ref; re-subscribing on every
    // render of the shell would drop events during the gap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, refresh]);

  /* ---------------------------------------------------------------- ringing */

  useEffect(() => {
    if (phase === "incoming") startRinging("incoming");
    else if (phase === "outgoing") startRinging("outgoing");
    else stopRinging();

    return () => stopRinging();
  }, [phase]);

  /**
   * The client half of the ring timeout.
   *
   * The database is the authority — `expire_ringing_calls()` catches a ring
   * whose browser has gone away entirely — but waiting for a sweep would leave
   * a phone ringing at somebody after the caller has given up. Both sides run
   * this, and `end_call` is idempotent, so whichever fires first is fine.
   */
  useEffect(() => {
    if (phase !== "outgoing" && phase !== "incoming") return;
    const current = call;
    if (!current) return;

    const elapsed = Date.now() - new Date(current.startedAt).getTime();
    const remaining = Math.max(0, RING_TIMEOUT_MS - elapsed);

    const timer = setTimeout(() => {
      void endCallAction(current.id, "expired").then(() => {
        stopRinging();
        media.stop();
        setCall(null);
      });
    }, remaining);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, call?.id, call?.startedAt]);

  /**
   * A connection that will not come back ends the call.
   *
   * `KithPeer` already waits out a blip and tries an ICE restart; by the time it
   * reports `failed` it has given up. Somebody has to write that down — otherwise
   * a call whose other end vanished stays `active` in the database, and since a
   * person may only be on one call at a time, it would block them from making
   * another. The surviving browser is the one that noticed, so it is the one
   * that reports it.
   */
  useEffect(() => {
    if (phase !== "active" || peer.state !== "failed") return;
    const current = callRef.current;
    if (!current) return;

    stopRinging();
    media.stop();
    setCall(null);
    void endCallAction(current.id, "failed");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, peer.state]);

  /**
   * A closed tab must not leave a call running.
   *
   * `sendBeacon` on `pagehide` is the only thing that survives a tab closing —
   * a server action would be cancelled mid-flight. It is best-effort by design,
   * and it does not have to be perfect: if it is missed, the other side's peer
   * connection fails, they hang up, and `end_call` ends the call for both.
   */
  useEffect(() => {
    if (!call) return;
    const id = call.id;

    const onPageHide = () => {
      navigator.sendBeacon?.("/api/calls/end", new Blob([JSON.stringify({ callId: id })]));
    };

    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [call]);

  /* ---------------------------------------------------------------- actions */

  const handle = useCallback(
    async (run: () => Promise<CallResult>, onSuccess?: (call: ActiveCall | null) => void) => {
      setBusy(true);
      setError(null);
      try {
        const result = await run();
        if (!result.ok) {
          setError(messageFor(result));
          stopRinging();
          media.stop();
          setCall(null);
          return;
        }
        setCall(result.call);
        onSuccess?.(result.call);
      } finally {
        setBusy(false);
      }
    },
    // `media.stop` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const startCall = useCallback(
    async (conversationId: string) => {
      // The microphone is acquired BEFORE the call is placed. Ringing somebody
      // and then discovering the mic is blocked wastes their time and looks like
      // a dropped call; failing here costs nobody anything.
      setBusy(true);
      setError(null);
      try {
        await media.start();
      } finally {
        setBusy(false);
      }

      if (!media.hasStream()) {
        setError("KITH needs your microphone to make a call.");
        return;
      }

      await handle(() => startCallAction(conversationId));
    },
    [handle, media],
  );

  const answer = useCallback(async () => {
    const current = callRef.current;
    if (!current) return;

    stopRinging();
    setBusy(true);
    try {
      await media.start();
    } finally {
      setBusy(false);
    }

    if (!media.hasStream()) {
      setError("KITH needs your microphone to answer.");
      await endCallAction(current.id, "declined");
      setCall(null);
      return;
    }

    await handle(() => answerCallAction(current.id));
  }, [handle, media]);

  const end = useCallback(
    async (reason: "hung_up" | "declined") => {
      const current = callRef.current;
      if (!current) return;

      stopRinging();
      media.stop();
      // Cleared optimistically. The confirmation is a round trip away and a call
      // that stays on screen after you hang up feels broken; the broadcast will
      // confirm what already happened.
      setCall(null);
      await endCallAction(current.id, reason);
    },
    [media],
  );

  const decline = useCallback(() => end("declined"), [end]);
  const hangUp = useCallback(() => end("hung_up"), [end]);

  /**
   * Publishes what this side is sending.
   *
   * Always the whole `MediaState`, never a patch. The far end renders icons from
   * it, and a partial update is how a mute indicator ends up describing a state
   * nobody is in.
   */
  const publishMediaState = useCallback(
    (next: MediaState) => {
      const current = callRef.current;
      peer.sendMediaState(next);
      if (current) void setCallMediaStateAction(current.id, next);
    },
    [peer],
  );

  const toggleMic = useCallback(() => {
    const next = !media.media.micEnabled;
    media.toggleMic();

    // Told, not inferred: a muted track still arrives, just silent, so the other
    // side cannot tell "muted" from "quiet room" by listening.
    publishMediaState({ ...media.media, micEnabled: next });
  }, [media, publishMediaState]);

  /**
   * Share, or stop sharing.
   *
   * Nothing is awaited before `media.toggleScreenShare()` — `getDisplayMedia`
   * needs the click's transient activation and a server round trip would spend
   * it. The far end is told only after the picker has resolved, so a share that
   * was never started is never announced.
   */
  const toggleScreenShare = useCallback(async () => {
    await media.toggleScreenShare();
    // Read from the controller, not from React state: the toggle has already
    // resolved and `media.media` is still a render behind it.
    publishMediaState(media.getState());
  }, [media, publishMediaState]);

  const value = useMemo<CallContextValue>(
    () => ({
      call,
      phase,
      connection: peer.state,
      micEnabled: media.media.micEnabled,
      screenSharing: media.media.screenSharing,
      screenShareSupported: media.screenShareSupported,
      localScreenStream: media.displayStream,
      remoteMicEnabled: peer.remoteMedia.micEnabled,
      remoteScreenSharing: peer.remoteMedia.screenSharing,
      remoteStream: peer.remoteStream,
      error,
      busy,
      startCall,
      answer,
      decline,
      hangUp,
      toggleMic,
      toggleScreenShare,
      dismissError: () => setError(null),
    }),
    [
      call,
      phase,
      peer.state,
      peer.remoteMedia.micEnabled,
      peer.remoteMedia.screenSharing,
      peer.remoteStream,
      media.media.micEnabled,
      media.media.screenSharing,
      media.displayStream,
      media.screenShareSupported,
      error,
      busy,
      startCall,
      answer,
      decline,
      hangUp,
      toggleMic,
      toggleScreenShare,
    ],
  );

  return (
    <CallContext.Provider value={value}>
      {children}
      <CallOverlay />
    </CallContext.Provider>
  );
}
