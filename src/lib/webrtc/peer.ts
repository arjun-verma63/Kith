import {
  buildIceConfiguration,
  ICE_BATCH_MS,
  RECONNECT_GRACE_MS,
  RECONNECT_TIMEOUT_MS,
} from "@/lib/webrtc/config";
import {
  DEFAULT_MEDIA_STATE,
  isPolite,
  type HangupReason,
  type MediaState,
  type SignalingTransport,
  type SignalMessage,
} from "@/lib/webrtc/signaling";

/**
 * One peer connection, wrapped.
 *
 * This is the whole of KITH's WebRTC logic. It has no React in it, no Supabase
 * in it, and no DOM in it beyond the WebRTC API itself — which is injectable, so
 * the same code runs in a browser and under test against a real native
 * implementation.
 *
 * ── Perfect negotiation ──────────────────────────────────────────────────────
 *
 * The hard part of WebRTC is not connecting; it is connecting when both sides
 * try to renegotiate at once. Somebody starts a screen share exactly as somebody
 * else toggles their camera, both call `setLocalDescription`, and both then
 * receive an offer while in `have-local-offer`. Handled naively, both fail, both
 * retry, and the call deadlocks in a way that only shows up under load.
 *
 * The WHATWG "perfect negotiation" pattern fixes this by making the roles
 * asymmetric: one peer is POLITE and rolls back its own offer to accept the
 * other's; one is IMPOLITE and ignores the incoming offer. Politeness is derived
 * from comparing user ids, so both sides agree without a round trip.
 *
 * Everything below follows that pattern exactly. The three flags —
 * `makingOffer`, `ignoreOffer`, `settingRemoteAnswerPending` — are load-bearing;
 * removing any of them reintroduces the deadlock under exactly the conditions
 * that are hardest to reproduce by hand.
 *
 * ── What this deliberately does not do ───────────────────────────────────────
 *
 * No media capture (that is `media.ts`), no ringing or call lifecycle (that is
 * the `calls` table and the UI above it), and no persistence of anything. Audio
 * and video travel peer to peer over SRTP and never touch a server we run.
 */

export type PeerState = "new" | "connecting" | "connected" | "reconnecting" | "failed" | "closed";

export interface PeerEvents {
  onState?: (state: PeerState) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onRemoteMediaState?: (state: MediaState) => void;
  onHangup?: (reason: HangupReason) => void;
  onError?: (error: Error) => void;
}

export interface PeerOptions extends PeerEvents {
  selfId: string;
  peerId: string;
  transport: SignalingTransport;
  /** STUN by default; relay entries are passed in when TURN lands. */
  configuration?: RTCConfiguration;
  /**
   * Injected so tests can supply a real native implementation instead of a
   * browser one. Defaults to the global in a browser.
   */
  createConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  iceBatchMs?: number;
}

export class KithPeer {
  readonly connection: RTCPeerConnection;
  readonly polite: boolean;

  private readonly selfId: string;
  private readonly peerId: string;
  private readonly transport: SignalingTransport;
  private readonly events: PeerEvents;
  private readonly iceBatchMs: number;
  private readonly unsubscribe: () => void;

  /** Perfect-negotiation flags. See the class comment. */
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswerPending = false;

  private pendingCandidates: RTCIceCandidateInit[] = [];
  /**
   * Inbound candidates that arrived before the description they belong to.
   *
   * `addIceCandidate` rejects while there is no remote description, and
   * broadcast delivery is not ordered end to end — a candidate genuinely can
   * overtake the SDP. Without this queue the first candidates of every racy
   * negotiation are thrown away, which does not break the call outright; it just
   * makes connecting intermittently slow, which is far harder to diagnose.
   */
  private earlyCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private iceFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Gives up on a recovery that is never going to happen. */
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  private state: PeerState = "new";
  private closed = false;
  /**
   * Lazily built. `MediaStream` is a DOM constructor and does not exist outside a
   * browser, so constructing it eagerly would make this class unusable in the
   * Node test that proves two peers can actually connect.
   */
  private remoteStream: MediaStream | null = null;

  constructor(options: PeerOptions) {
    this.selfId = options.selfId;
    this.peerId = options.peerId;
    this.transport = options.transport;
    this.events = options;
    this.iceBatchMs = options.iceBatchMs ?? ICE_BATCH_MS;
    this.polite = isPolite(options.selfId, options.peerId);

    const configuration = options.configuration ?? buildIceConfiguration();
    const create =
      options.createConnection ?? ((config: RTCConfiguration) => new RTCPeerConnection(config));

    this.connection = create(configuration);

    this.attachConnectionHandlers();
    this.unsubscribe = this.transport.subscribe((message) => {
      void this.handleSignal(message);
    });
  }

  /* ---------------------------------------------------------------- outbound */

  /**
   * Begins negotiation explicitly.
   *
   * Normally unnecessary: adding a track or opening a data channel fires
   * `negotiationneeded` and the offer follows on its own. This exists for the
   * caller side of a call that has no media yet, and for implementations that do
   * not raise the event. Calling it when an offer is already in flight is a
   * no-op, so it is safe to call alongside the automatic path.
   */
  async start(): Promise<void> {
    await this.negotiate();
  }

  /**
   * Publishes a local track.
   *
   * Adding a track fires `negotiationneeded`, so this is the normal way a call
   * starts: add your microphone, and the offer follows.
   */
  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
    return this.connection.addTrack(track, stream);
  }

  /**
   * Swaps the track a sender is publishing without renegotiating.
   *
   * This is how a camera switch or a screen share replacing the camera should be
   * done — `replaceTrack` changes the source in place, where remove-then-add
   * would tear down and rebuild the media line and produce a visible black frame
   * on the other side.
   */
  async replaceTrack(sender: RTCRtpSender, track: MediaStreamTrack | null): Promise<void> {
    await sender.replaceTrack(track);
  }

  removeTrack(sender: RTCRtpSender): void {
    this.connection.removeTrack(sender);
  }

  /** Tells the other side what is muted. Explicit, never inferred. */
  sendMediaState(state: MediaState): void {
    void this.transport.send({ type: "media", from: this.selfId, to: this.peerId, state });
  }

  hangUp(reason: HangupReason = "hung_up"): void {
    void this.transport.send({ type: "bye", from: this.selfId, to: this.peerId, reason });
    this.close();
  }

  getState(): PeerState {
    return this.state;
  }

  /** Live connection quality, for the signal-strength indicator. */
  async getStats(): Promise<{ rtt: number | null; packetsLost: number; jitter: number | null }> {
    const report = await this.connection.getStats();
    let rtt: number | null = null;
    let packetsLost = 0;
    let jitter: number | null = null;

    report.forEach((entry) => {
      if (entry.type === "candidate-pair" && entry.state === "succeeded") {
        rtt = typeof entry.currentRoundTripTime === "number" ? entry.currentRoundTripTime : rtt;
      }
      if (entry.type === "inbound-rtp") {
        packetsLost += typeof entry.packetsLost === "number" ? entry.packetsLost : 0;
        jitter = typeof entry.jitter === "number" ? entry.jitter : jitter;
      }
    });

    return { rtt, packetsLost, jitter };
  }

  /**
   * Tears everything down.
   *
   * Safe to call twice, and safe to call from inside a handler. Order matters:
   * unsubscribe first so a late message cannot resurrect a closing connection,
   * then clear the timers, then close the connection.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    this.unsubscribe();
    this.clearTimer("ice");
    this.clearTimer("disconnect");
    this.clearTimer("recovery");

    try {
      for (const sender of this.connection.getSenders()) {
        // The tracks belong to whoever created them — stopping them here would
        // switch off a camera that another connection is still using. Only the
        // sender is detached.
        try {
          void sender.replaceTrack(null);
        } catch {
          // Already closed.
        }
      }
    } catch {
      // Data-channel-only implementations do not expose senders at all.
    }

    this.connection.onnegotiationneeded = null;
    this.connection.onicecandidate = null;
    this.connection.ontrack = null;
    this.connection.onconnectionstatechange = null;
    this.connection.oniceconnectionstatechange = null;

    this.connection.close();
    this.setState("closed");
  }

  /* ----------------------------------------------------------------- inbound */

  private attachConnectionHandlers(): void {
    const pc = this.connection;

    pc.onnegotiationneeded = () => {
      void this.negotiate();
    };

    pc.onicecandidate = ({ candidate }) => {
      // A null candidate marks the end of gathering. Anything already queued
      // still needs sending, so flush rather than ignore.
      if (!candidate) {
        this.flushCandidates();
        return;
      }

      this.pendingCandidates.push(candidate.toJSON());
      if (this.iceFlushTimer === null) {
        this.iceFlushTimer = setTimeout(() => this.flushCandidates(), this.iceBatchMs);
      }
    };

    pc.ontrack = ({ track, streams }) => {
      // Prefer the stream the sender grouped the track into; fall back to a
      // stable local one so the consumer always sees the same MediaStream object
      // and does not have to re-attach a video element per track.
      const grouped = streams[0];
      if (grouped) {
        this.events.onRemoteStream?.(grouped);
        return;
      }

      this.remoteStream ??= new MediaStream();
      this.remoteStream.addTrack(track);
      this.events.onRemoteStream?.(this.remoteStream);
    };

    pc.onconnectionstatechange = () => this.syncState();
    pc.oniceconnectionstatechange = () => this.syncState();
  }

  private async negotiate(): Promise<void> {
    if (this.closed || this.makingOffer) return;
    const pc = this.connection;

    try {
      this.makingOffer = true;
      // Explicit createOffer rather than the implicit `setLocalDescription()`
      // overload: the implicit form is not available everywhere this runs.
      const offer = await pc.createOffer();
      // If a remote offer was accepted while this one was being created, ours is
      // stale — applying it now would throw. Narrowly `have-remote-offer` rather
      // than "not stable", because an implementation that marks the state the
      // moment it generates a description is not a collision.
      if (pc.signalingState === "have-remote-offer") return;
      await pc.setLocalDescription(offer);

      this.sendDescription(pc.localDescription ?? offer);
    } catch (error) {
      this.fail(error);
    } finally {
      this.makingOffer = false;
    }
  }

  /**
   * Sends a description as a plain object.
   *
   * `RTCSessionDescription` is a host object; what reaches the transport must be
   * JSON, because the real one is a broadcast socket. Flattening here rather than
   * relying on `toJSON` keeps the wire shape identical across implementations.
   */
  private sendDescription(description: RTCSessionDescriptionInit): void {
    void this.transport.send({
      type: "sdp",
      from: this.selfId,
      to: this.peerId,
      description: { type: description.type, sdp: description.sdp ?? "" },
    });
  }

  private async handleSignal(message: SignalMessage): Promise<void> {
    if (this.closed) return;
    // A transport is expected to route correctly, but a stray message must not
    // be applied to the wrong connection.
    if (message.to !== this.selfId || message.from !== this.peerId) return;

    try {
      switch (message.type) {
        case "sdp":
          await this.handleDescription(message.description);
          break;
        case "ice":
          await this.handleCandidates(message.candidates);
          break;
        case "media":
          this.events.onRemoteMediaState?.(message.state);
          break;
        case "bye":
          this.events.onHangup?.(message.reason);
          this.close();
          break;
      }
    } catch (error) {
      this.fail(error);
    }
  }

  /** The perfect-negotiation core. */
  private async handleDescription(description: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.connection;

    const readyForOffer =
      !this.makingOffer && (pc.signalingState === "stable" || this.settingRemoteAnswerPending);
    const offerCollision = description.type === "offer" && !readyForOffer;

    // The impolite peer wins a collision: it ignores the incoming offer and
    // carries on with its own. The polite peer falls through and rolls back.
    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return;

    this.settingRemoteAnswerPending = description.type === "answer";
    await pc.setRemoteDescription(description);
    this.settingRemoteAnswerPending = false;
    this.remoteDescriptionSet = true;
    await this.drainEarlyCandidates();

    if (description.type !== "offer") return;

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.sendDescription(pc.localDescription ?? answer);
  }

  private async handleCandidates(candidates: RTCIceCandidateInit[]): Promise<void> {
    if (!this.remoteDescriptionSet) {
      this.earlyCandidates.push(...candidates);
      return;
    }
    await this.addCandidates(candidates);
  }

  private async drainEarlyCandidates(): Promise<void> {
    if (this.earlyCandidates.length === 0) return;
    const queued = this.earlyCandidates;
    this.earlyCandidates = [];
    await this.addCandidates(queued);
  }

  private async addCandidates(candidates: RTCIceCandidateInit[]): Promise<void> {
    for (const candidate of candidates) {
      try {
        await this.connection.addIceCandidate(candidate);
      } catch (error) {
        // Candidates for an offer we deliberately ignored will fail, and that is
        // correct. Anything else is real.
        if (!this.ignoreOffer) throw error;
      }
    }
  }

  private flushCandidates(): void {
    this.clearTimer("ice");
    if (this.pendingCandidates.length === 0 || this.closed) return;

    const candidates = this.pendingCandidates;
    this.pendingCandidates = [];

    void this.transport.send({
      type: "ice",
      from: this.selfId,
      to: this.peerId,
      candidates,
    });
  }

  /* ------------------------------------------------------------------- state */

  private syncState(): void {
    if (this.closed) return;

    switch (this.connection.connectionState) {
      case "new":
        this.setState("new");
        break;

      case "connecting":
        this.setState("connecting");
        break;

      case "connected":
        this.clearTimer("disconnect");
        this.clearTimer("recovery");
        this.setState("connected");
        break;

      case "disconnected":
        // NOT a failure yet. `disconnected` is routinely transient — a wifi
        // handover produces it and recovers on its own within a second or two.
        // Tearing the call down here would end perfectly good calls every time
        // somebody walks past a lift.
        this.setState("reconnecting");
        this.armRecoveryDeadline();
        if (this.disconnectTimer === null) {
          this.disconnectTimer = setTimeout(() => this.restart(), RECONNECT_GRACE_MS);
        }
        break;

      case "failed":
        this.setState("reconnecting");
        this.armRecoveryDeadline();
        this.restart();
        break;

      case "closed":
        this.setState("closed");
        break;
    }
  }

  /**
   * Stops "Reconnecting…" from becoming permanent.
   *
   * Applies to both sides. The polite peer never restarts ICE, so nothing else
   * would ever move it off this state; and a restart the other end never answers
   * does not fail on its own either.
   */
  private armRecoveryDeadline(): void {
    if (this.recoveryTimer !== null) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.closed || this.connection.connectionState === "connected") return;
      this.setState("failed");
    }, RECONNECT_TIMEOUT_MS);
  }

  /**
   * ICE restart.
   *
   * Only the IMPOLITE peer restarts. Both restarting at once produces exactly
   * the glare that perfect negotiation then has to resolve, turning one recovery
   * into two round trips — and the polite peer will pick up the restart offer
   * anyway. The asymmetry that solves negotiation solves recovery too.
   */
  private restart(): void {
    this.clearTimer("disconnect");
    if (this.closed || this.polite) return;
    if (this.connection.connectionState === "connected") return;

    try {
      if (typeof this.connection.restartIce === "function") {
        try {
          // Fires negotiationneeded, which sends a fresh offer with new
          // credentials.
          this.connection.restartIce();
          return;
        } catch {
          // Present but unimplemented. Fall through rather than treating a
          // recoverable blip as a failed call.
        }
      }

      // Implementations without a working restartIce: force it by hand.
      void (async () => {
        const offer = await this.connection.createOffer({ iceRestart: true });
        await this.connection.setLocalDescription(offer);
        this.sendDescription(this.connection.localDescription ?? offer);
      })();
    } catch (error) {
      this.fail(error);
    }
  }

  private setState(state: PeerState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onState?.(state);
  }

  private fail(error: unknown): void {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    this.events.onError?.(wrapped);
    this.setState("failed");
  }

  private clearTimer(which: "ice" | "disconnect" | "recovery"): void {
    if (which === "ice" && this.iceFlushTimer !== null) {
      clearTimeout(this.iceFlushTimer);
      this.iceFlushTimer = null;
    }
    if (which === "disconnect" && this.disconnectTimer !== null) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    if (which === "recovery" && this.recoveryTimer !== null) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }
}

export { DEFAULT_MEDIA_STATE };
