/**
 * One video sender, whatever is feeding it.
 *
 * A participant sends at most one video stream, and its source changes during a
 * call: nothing, then a screen, then a camera, then a screen again. The rule
 * that makes those switches free is that they all travel on the SAME sender.
 *
 * ── Why that matters ─────────────────────────────────────────────────────────
 *
 * `addTrack` creates a media line and fires `negotiationneeded`. Doing it on
 * every switch means renegotiating the session every time somebody shares a
 * screen or turns a camera on — an offer, an answer, and a gap of black frames
 * on the far end while it settles.
 *
 * `replaceTrack` swaps the source in place. No SDP, no negotiation, no gap. It
 * works because the transceiver stays where it is; only what feeds it changes.
 *
 * So: `addTrack` exactly once, the first time there is any video at all, and
 * `replaceTrack` forever after — including `replaceTrack(null)` to stop, which
 * keeps the sender for next time.
 *
 * ── One consequence worth knowing ────────────────────────────────────────────
 *
 * `replaceTrack(null)` does not end the track on the receiving side. The remote
 * track stays alive and goes MUTED. A receiver watching for `ended` to know a
 * share stopped will wait forever and keep a frozen last frame on screen; the
 * events to watch are `mute` and `unmute`. `useHasVideoTrack` in the call
 * overlay does exactly that.
 */

/** The part of a peer connection this needs. Narrow, so a test can supply it. */
export interface VideoSink {
  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender;
  replaceTrack(sender: RTCRtpSender, track: MediaStreamTrack | null): Promise<void>;
}

export type PublishOutcome =
  /** First video of the call. A media line was created; expect renegotiation. */
  | "added"
  /** Source swapped in place. No negotiation. */
  | "replaced"
  /** Sender kept, sending nothing. The far end's track goes muted. */
  | "cleared"
  /** Nothing to do — asked to stop when nothing was ever sent. */
  | "noop";

export class VideoPublisher {
  private sender: RTCRtpSender | null = null;
  // An explicit field rather than a constructor parameter property: Node's
  // type-stripping cannot erase those, and this class is driven directly by the
  // test suite.
  private readonly sink: VideoSink;

  constructor(sink: VideoSink) {
    this.sink = sink;
  }

  /**
   * Sends `track`, or stops sending when it is null.
   *
   * `stream` is only used to group the video with the audio already being sent,
   * so the far end receives one `MediaStream` carrying both rather than two it
   * has to correlate. It is ignored once a sender exists.
   */
  async publish(track: MediaStreamTrack | null, stream: MediaStream): Promise<PublishOutcome> {
    if (this.sender) {
      await this.sink.replaceTrack(this.sender, track);
      return track ? "replaced" : "cleared";
    }

    // Nothing has ever been sent, and nothing is being asked for. Creating a
    // media line to immediately send nothing down would renegotiate for no
    // reason.
    if (!track) return "noop";

    this.sender = this.sink.addTrack(track, stream);
    return "added";
  }

  hasSender(): boolean {
    return this.sender !== null;
  }

  /** Called when the peer connection goes away and the sender with it. */
  reset(): void {
    this.sender = null;
  }
}
