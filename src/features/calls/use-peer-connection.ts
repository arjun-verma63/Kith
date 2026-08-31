"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { createSupabaseSignaling } from "@/features/calls/supabase-signaling";
import { buildIceConfiguration } from "@/lib/webrtc/config";
import { KithPeer, type IceRoute, type PeerState } from "@/lib/webrtc/peer";
import { VideoPublisher } from "@/lib/webrtc/video";
import {
  DEFAULT_MEDIA_STATE,
  type HangupReason,
  type MediaState,
  type SignalingTransport,
} from "@/lib/webrtc/signaling";

/**
 * One peer connection, for the lifetime of a component.
 *
 * The split is the point of this file: `KithPeer` owns negotiation and knows
 * nothing about React; this hook owns mounting, unmounting and mirroring state
 * into a render. A connection is created once per (call, peer) pair and torn
 * down exactly once, whatever the parent re-renders.
 *
 * Media is passed in rather than captured here, because in a group call one
 * local stream feeds several connections. `useLocalMedia` captures; this
 * publishes.
 */

export interface UsePeerConnectionOptions {
  callId: string;
  selfId: string;
  peerId: string;
  /** Published as soon as it exists; passing null keeps the connection silent. */
  localStream: MediaStream | null;
  /** False keeps the hook dormant — nothing is created until the call is live. */
  enabled?: boolean;
  /**
   * Relay entries, already fetched.
   *
   * Passed in rather than fetched here so the connection is created the moment
   * the call goes live: the provider asks for them while the phone is still
   * ringing, which is dead time anyway. An empty list is a working answer —
   * the call runs on STUN.
   */
  iceServers?: RTCIceServer[];
  /** Called before an ICE restart, to replace credentials that may have expired. */
  refreshIceServers?: () => Promise<RTCIceServer[] | null>;
  onHangup?: (reason: HangupReason) => void;
  /** Overridden in tests; defaults to Supabase Realtime. */
  createTransport?: (callId: string, selfId: string) => SignalingTransport;
}

export interface PeerConnectionApi {
  state: PeerState;
  /**
   * How the media is actually travelling.
   *
   * Read from the connection rather than from what we hoped we configured. On an
   * open network every call connects directly, so a completely broken relay
   * configuration looks perfect until the first person on a locked-down network
   * tries to call somebody. This is what makes that visible.
   */
  route: IceRoute;
  /** Round-trip time in seconds, or null before the first sample. */
  rtt: number | null;
  remoteStream: MediaStream | null;
  /** What the other side says it is sending. Never inferred from the tracks. */
  remoteMedia: MediaState;
  error: Error | null;
  connected: boolean;
  hangUp: (reason?: HangupReason) => void;
  sendMediaState: (state: MediaState) => void;
  /** Camera on/off and device switches, without renegotiating. */
  setVideoTrack: (track: MediaStreamTrack | null) => Promise<void>;
}

/** How often to read the connection's route and round-trip time. */
const STATS_INTERVAL_MS = 4000;

export function usePeerConnection(options: UsePeerConnectionOptions): PeerConnectionApi {
  const {
    callId,
    selfId,
    peerId,
    localStream,
    enabled = true,
    iceServers,
    refreshIceServers,
    onHangup,
    createTransport,
  } = options;

  const [state, setState] = useState<PeerState>("new");
  const [quality, setQuality] = useState<{ route: IceRoute; rtt: number | null }>({
    route: "unknown",
    rtt: null,
  });
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [remoteMedia, setRemoteMedia] = useState<MediaState>(DEFAULT_MEDIA_STATE);
  const [error, setError] = useState<Error | null>(null);

  const peerRef = useRef<KithPeer | null>(null);
  const publisher = useRef<VideoPublisher | null>(null);
  const publishedStream = useRef<MediaStream | null>(null);

  const hangupHandler = useRef(onHangup);
  useEffect(() => {
    hangupHandler.current = onHangup;
  });

  // In a ref so a re-render of the shell never rebuilds the connection.
  const refreshHandler = useRef(refreshIceServers);
  useEffect(() => {
    refreshHandler.current = refreshIceServers;
  });

  /*
   * Create and destroy.
   *
   * `localStream` is intentionally NOT a dependency. Media arriving a moment
   * after mount is the normal case (permission prompts are slow), and rebuilding
   * the connection when it does would restart negotiation from scratch every
   * time somebody granted access.
   */
  useEffect(() => {
    if (!enabled) return;

    const transport = createTransport
      ? createTransport(callId, selfId)
      : createSupabaseSignaling({ callId, selfId });

    const peer = new KithPeer({
      selfId,
      peerId,
      transport,
      configuration: buildIceConfiguration({ turnServers: iceServers ?? [] }),
      refreshConfiguration: async () => {
        const fresh = await refreshHandler.current?.();
        return fresh ? buildIceConfiguration({ turnServers: fresh }) : null;
      },
      onState: setState,
      onRemoteStream: setRemoteStream,
      onRemoteMediaState: setRemoteMedia,
      onHangup: (reason) => hangupHandler.current?.(reason),
      onError: setError,
    });

    peerRef.current = peer;
    publisher.current = new VideoPublisher(peer);

    return () => {
      peerRef.current = null;
      publisher.current = null;
      publishedStream.current = null;
      peer.close();
      void transport.close();
    };
  }, [callId, selfId, peerId, enabled, createTransport, iceServers]);

  /*
   * Publish local tracks.
   *
   * Runs whenever the stream identity changes, which happens once in practice.
   * Adding a track fires `negotiationneeded`, so this is what actually starts
   * the call.
   */
  useEffect(() => {
    const peer = peerRef.current;
    if (!peer || !localStream) return;
    if (publishedStream.current === localStream) return;

    publishedStream.current = localStream;
    for (const track of localStream.getTracks()) {
      // Video, if the stream already has any, goes through the publisher so
      // there is one place that owns the video sender.
      if (track.kind === "video") {
        void publisher.current?.publish(track, localStream);
        continue;
      }
      peer.addTrack(track, localStream);
    }
  }, [localStream, enabled]);

  /*
   * Poll the connection for its route and round-trip time.
   *
   * Only while connected, and slowly: `getStats()` walks the whole report, and
   * nothing here changes second to second. The route is settled within a moment
   * of connecting and then holds unless ICE re-nominates a different pair, which
   * is exactly the event worth noticing.
   */
  useEffect(() => {
    if (state !== "connected") return;

    let cancelled = false;

    const sample = async () => {
      const stats = await peerRef.current?.getStats();
      if (cancelled || !stats) return;
      setQuality({ route: stats.route, rtt: stats.rtt });
    };

    void sample();
    const timer = setInterval(() => void sample(), STATS_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state]);

  /**
   * Screen shares, camera toggles and device switches all come through here.
   *
   * The replace-or-add rule lives in `VideoPublisher`, out of React, because it
   * is the piece that decides whether a switch costs a renegotiation — and it is
   * testable there.
   */
  const setVideoTrack = useCallback(async (track: MediaStreamTrack | null) => {
    if (!peerRef.current || !publisher.current) return;
    // Grouped with the audio already being sent, so the far end gets one stream
    // carrying both rather than two it has to correlate.
    const stream = publishedStream.current ?? new MediaStream();
    await publisher.current.publish(track, stream);
  }, []);

  const hangUp = useCallback((reason: HangupReason = "hung_up") => {
    peerRef.current?.hangUp(reason);
  }, []);

  const sendMediaState = useCallback((next: MediaState) => {
    peerRef.current?.sendMediaState(next);
  }, []);

  return {
    state,
    route: quality.route,
    rtt: quality.rtt,
    remoteStream,
    remoteMedia,
    error,
    connected: state === "connected",
    hangUp,
    sendMediaState,
    setVideoTrack,
  };
}
