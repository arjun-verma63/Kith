"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { createSupabaseSignaling } from "@/features/calls/supabase-signaling";
import { KithPeer, type PeerState } from "@/lib/webrtc/peer";
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
  onHangup?: (reason: HangupReason) => void;
  /** Overridden in tests; defaults to Supabase Realtime. */
  createTransport?: (callId: string, selfId: string) => SignalingTransport;
}

export interface PeerConnectionApi {
  state: PeerState;
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

export function usePeerConnection(options: UsePeerConnectionOptions): PeerConnectionApi {
  const {
    callId,
    selfId,
    peerId,
    localStream,
    enabled = true,
    onHangup,
    createTransport,
  } = options;

  const [state, setState] = useState<PeerState>("new");
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [remoteMedia, setRemoteMedia] = useState<MediaState>(DEFAULT_MEDIA_STATE);
  const [error, setError] = useState<Error | null>(null);

  const peerRef = useRef<KithPeer | null>(null);
  const videoSender = useRef<RTCRtpSender | null>(null);
  const publishedStream = useRef<MediaStream | null>(null);

  const hangupHandler = useRef(onHangup);
  useEffect(() => {
    hangupHandler.current = onHangup;
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
      onState: setState,
      onRemoteStream: setRemoteStream,
      onRemoteMediaState: setRemoteMedia,
      onHangup: (reason) => hangupHandler.current?.(reason),
      onError: setError,
    });

    peerRef.current = peer;

    return () => {
      peerRef.current = null;
      videoSender.current = null;
      publishedStream.current = null;
      peer.close();
      void transport.close();
    };
  }, [callId, selfId, peerId, enabled, createTransport]);

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
      const sender = peer.addTrack(track, localStream);
      if (track.kind === "video") videoSender.current = sender;
    }
  }, [localStream, enabled]);

  /**
   * Camera toggles and device switches.
   *
   * `replaceTrack` when a video sender already exists; `addTrack` only the first
   * time, when the media line has to be created. The distinction matters — going
   * through `addTrack` every time renegotiates the session on every camera
   * toggle, and the other side sees a black frame while it does.
   */
  const setVideoTrack = useCallback(async (track: MediaStreamTrack | null) => {
    const peer = peerRef.current;
    if (!peer) return;

    if (videoSender.current) {
      await peer.replaceTrack(videoSender.current, track);
      return;
    }

    if (!track) return;
    const stream = publishedStream.current ?? new MediaStream();
    videoSender.current = peer.addTrack(track, stream);
  }, []);

  const hangUp = useCallback((reason: HangupReason = "hung_up") => {
    peerRef.current?.hangUp(reason);
  }, []);

  const sendMediaState = useCallback((next: MediaState) => {
    peerRef.current?.sendMediaState(next);
  }, []);

  return {
    state,
    remoteStream,
    remoteMedia,
    error,
    connected: state === "connected",
    hangUp,
    sendMediaState,
    setVideoTrack,
  };
}
