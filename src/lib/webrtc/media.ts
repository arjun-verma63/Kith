/**
 * Local capture: microphone, camera, and the difference between "muted" and
 * "off".
 *
 * This module owns the `MediaStream` that belongs to *this* browser. It never
 * touches a peer connection — `peer.ts` publishes whatever tracks it is handed.
 * Keeping the two apart means a device can be swapped mid-call without the
 * negotiation code knowing, and the negotiation can be tested without a camera.
 *
 * ── Muted is not off ─────────────────────────────────────────────────────────
 *
 * `track.enabled = false` keeps the hardware open and sends silence/black. It is
 * instant, reversible with no permission prompt, and correct for the microphone:
 * unmuting has to be immediate, because people start talking before they finish
 * pressing the button.
 *
 * `track.stop()` releases the hardware. The camera light goes out. That is the
 * only honest way to turn a camera off — a user who presses "camera off" and
 * watches the light stay on has been lied to, and no amount of "the track is
 * disabled, we promise" fixes that. The cost is that turning it back on
 * re-acquires the device (a few hundred milliseconds), which is a fair trade for
 * a control people actually trust.
 *
 * So: microphone toggles `enabled`, camera stops and re-acquires. Deliberately
 * asymmetric.
 */

import { DEFAULT_MEDIA_STATE, type MediaState } from "@/lib/webrtc/signaling";

export type MediaKind = "audio" | "video";

export interface DeviceInfo {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
}

export interface DevicePreferences {
  microphoneId?: string | undefined;
  cameraId?: string | undefined;
}

/**
 * What we ask for.
 *
 * Echo cancellation, noise suppression and auto gain are on because KITH calls
 * happen on laptop speakers in shared rooms. 720p rather than 1080p: at five
 * people on home upload, the extra pixels cost more than they show.
 */
export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
  facingMode: "user",
};

/**
 * What we ask for when sharing a screen.
 *
 * The opposite trade to the camera. A shared screen is mostly text that has to
 * stay legible, and mostly still — so resolution is worth more than frame rate,
 * and 15fps of sharp text beats 30fps of mush at the same bitrate. `contentHint`
 * (applied to the track after capture) tells the encoder the same thing in the
 * language it understands.
 *
 * No `audio`. Chromium offers a "share tab audio" checkbox when you ask for it,
 * and publishing that would need a second audio sender alongside the microphone
 * — mixing them into one track would mean the far end could not mute you without
 * also muting the video. Offering a checkbox that silently does nothing is worse
 * than not offering it, so the request is video-only until that sender exists.
 */
export const DISPLAY_CONSTRAINTS: MediaTrackConstraints = {
  frameRate: { ideal: 15, max: 30 },
  width: { ideal: 1920, max: 1920 },
  height: { ideal: 1080, max: 1080 },
};

/**
 * Whether this browser can share a screen at all.
 *
 * `getDisplayMedia` is missing on insecure origins, in most embedded webviews,
 * and — the case that actually matters — on iOS, where no browser supports it
 * because WebKit does not. The button is hidden rather than disabled there:
 * a control that can never work is not a control.
 */
export function isDisplayMediaSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}

/** A capture failure the UI can actually say something about. */
export class MediaError extends Error {
  readonly kind: "denied" | "cancelled" | "missing" | "in_use" | "unsupported" | "unknown";

  constructor(kind: MediaError["kind"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MediaError";
    this.kind = kind;
  }
}

/**
 * Browsers report the same few problems under several different names.
 * Normalised here so the UI has one small set of cases to render.
 */
function classify(error: unknown): MediaError {
  const name = error instanceof Error ? error.name : "";

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new MediaError(
        "denied",
        "KITH needs permission to use your microphone or camera. Check the address bar.",
        { cause: error },
      );
    case "NotFoundError":
    case "OverconstrainedError":
      return new MediaError("missing", "No microphone or camera was found.", { cause: error });
    case "NotReadableError":
    case "AbortError":
      return new MediaError("in_use", "Another app is using your microphone or camera.", {
        cause: error,
      });
    default:
      return new MediaError("unknown", "Could not start your microphone or camera.", {
        cause: error,
      });
  }
}

function mediaDevices(): MediaDevices {
  // Undefined on http:// origins other than localhost, and in any non-browser
  // context. Worth its own message: "camera is broken" and "this page is not
  // secure" are very different problems.
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    throw new MediaError(
      "unsupported",
      "Calls need a secure connection (https). This browser is not exposing media devices.",
    );
  }
  return navigator.mediaDevices;
}

/**
 * Acquires the local stream.
 *
 * Audio-first by design: a KITH call is a voice call that may grow a camera. The
 * caller asks for video explicitly.
 */
export async function acquireStream(
  options: { audio?: boolean; video?: boolean } & DevicePreferences = {},
): Promise<MediaStream> {
  const { audio = true, video = false, microphoneId, cameraId } = options;

  if (!audio && !video) {
    throw new MediaError("missing", "Nothing to capture.");
  }

  const constraints: MediaStreamConstraints = {
    audio: audio ? withDevice(AUDIO_CONSTRAINTS, microphoneId) : false,
    video: video ? withDevice(VIDEO_CONSTRAINTS, cameraId) : false,
  };

  try {
    return await mediaDevices().getUserMedia(constraints);
  } catch (error) {
    if (error instanceof MediaError) throw error;

    // A specific device that has since been unplugged fails the whole call.
    // Retry once with the default device rather than telling somebody their
    // microphone is missing when it is only their *preferred* one that is.
    if ((microphoneId ?? cameraId) !== undefined) {
      try {
        return await mediaDevices().getUserMedia({
          audio: audio ? AUDIO_CONSTRAINTS : false,
          video: video ? VIDEO_CONSTRAINTS : false,
        });
      } catch (retryError) {
        throw classify(retryError);
      }
    }

    throw classify(error);
  }
}

function withDevice(base: MediaTrackConstraints, deviceId?: string): MediaTrackConstraints {
  // `ideal`, not `exact`: a remembered device that is no longer plugged in
  // should degrade to the default, not fail the call.
  return deviceId ? { ...base, deviceId: { ideal: deviceId } } : base;
}

/**
 * Classifies a `getDisplayMedia` failure.
 *
 * Separate from `classify` because the same error name means something
 * completely different here. `NotAllowedError` from `getUserMedia` means the
 * browser blocked the microphone and the user needs to go and fix a permission.
 * From `getDisplayMedia` it overwhelmingly means the user opened the picker and
 * changed their mind — which is not a failure, and must not raise a banner
 * saying permission was denied.
 *
 * The two cases genuinely cannot be told apart: a policy block and a dismissed
 * picker throw the same error with the same name, and the messages differ by
 * browser and version. Treating both as "cancelled" means somebody blocked by
 * enterprise policy gets no explanation, which is the cheaper mistake — they
 * press the button again, nothing happens, and they look at their settings.
 * The alternative accuses every person who changes their mind.
 */
function classifyDisplay(error: unknown): MediaError {
  const name = error instanceof Error ? error.name : "";

  switch (name) {
    case "NotAllowedError":
      return new MediaError("cancelled", "Screen sharing was not started.", { cause: error });
    case "NotFoundError":
      return new MediaError("missing", "There was no screen available to share.", { cause: error });
    case "NotReadableError":
    case "AbortError":
      return new MediaError("in_use", "That screen could not be captured.", { cause: error });
    case "InvalidStateError":
      return new MediaError("unsupported", "Bring this window to the front and try again.", {
        cause: error,
      });
    default:
      return new MediaError("unknown", "Screen sharing could not be started.", { cause: error });
  }
}

/**
 * Opens the screen picker.
 *
 * MUST be called synchronously from a user gesture. Browsers require transient
 * activation for this, and awaiting anything first — a server round trip, a
 * confirmation — spends it and the call rejects. That is why nothing in the
 * screen-share path talks to the server before this resolves.
 */
export async function acquireDisplayStream(): Promise<MediaStream> {
  if (!isDisplayMediaSupported()) {
    throw new MediaError("unsupported", "This browser cannot share a screen.");
  }

  try {
    return await mediaDevices().getDisplayMedia({
      video: DISPLAY_CONSTRAINTS,
      audio: false,
    });
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw classifyDisplay(error);
  }
}

/**
 * Available devices.
 *
 * Labels are empty until permission has been granted at least once — that is the
 * spec, not a bug, and it is why the device picker only becomes useful after the
 * first successful capture.
 */
export async function listDevices(): Promise<DeviceInfo[]> {
  const devices = await mediaDevices().enumerateDevices();

  return devices
    .filter((device) => device.kind === "audioinput" || device.kind === "videoinput")
    .map((device, index) => ({
      deviceId: device.deviceId,
      label:
        device.label || `${device.kind === "audioinput" ? "Microphone" : "Camera"} ${index + 1}`,
      kind: device.kind,
    }));
}

/** Stops every track. The hardware indicators go out. */
export function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

/**
 * The local media state machine.
 *
 * Wraps one stream and the two controls over it. Everything is synchronous
 * except enabling the camera, which has to go back to the hardware.
 *
 * Not a React class — `useLocalMedia` wraps it. Keeping the logic outside React
 * means the tricky part (stop the track, re-acquire it, hand the new one to the
 * sender) is not tangled up with effect ordering.
 */
export class LocalMedia {
  private stream: MediaStream | null = null;
  /**
   * The screen, kept apart from the microphone stream on purpose.
   *
   * They have different lifetimes: a share starts and stops several times during
   * one call, while the microphone is acquired once and released at the end. Held
   * in one stream, stopping a share would mean picking tracks out of a shared
   * object, and `stop()` at the end of a call would be the only thing keeping
   * them in step. Two streams, two lifetimes, no bookkeeping.
   */
  private displayStream: MediaStream | null = null;
  private state: MediaState = { ...DEFAULT_MEDIA_STATE };
  private preferences: DevicePreferences = {};

  /**
   * Called when the video track is replaced, so the peer connection can
   * `replaceTrack` on the existing sender instead of renegotiating.
   *
   * One sender carries whatever video this person is sending — camera or screen.
   * That is what makes switching between them free: the source changes, the
   * media line does not, and the far end sees new frames rather than a
   * renegotiation and a black gap.
   */
  onVideoTrack: ((track: MediaStreamTrack | null) => void | Promise<void>) | null = null;
  onStateChange: ((state: MediaState) => void) | null = null;

  async start(options: { video?: boolean } & DevicePreferences = {}): Promise<MediaStream> {
    const { video = false, ...preferences } = options;
    this.preferences = preferences;

    this.stream = await acquireStream({ audio: true, video, ...preferences });
    this.state = { micEnabled: true, cameraEnabled: video, screenSharing: false };
    this.emit();
    return this.stream;
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  getState(): MediaState {
    return { ...this.state };
  }

  /** Instant, both ways. The track stays open. */
  setMicEnabled(enabled: boolean): void {
    for (const track of this.stream?.getAudioTracks() ?? []) {
      track.enabled = enabled;
    }
    this.state = { ...this.state, micEnabled: enabled };
    this.emit();
  }

  /**
   * Off releases the camera; on re-acquires it.
   *
   * The re-acquired track is handed to `onVideoTrack` so the sender can be
   * updated in place. If it were added to the connection instead, every camera
   * toggle would renegotiate.
   */
  async setCameraEnabled(enabled: boolean): Promise<void> {
    if (!this.stream) return;

    if (!enabled) {
      for (const track of this.stream.getVideoTracks()) {
        track.stop();
        this.stream.removeTrack(track);
      }
      this.state = { ...this.state, cameraEnabled: false };
      this.emit();
      // While a screen share owns the sender, the camera is not what is being
      // sent — so turning it off releases the hardware and nothing else. Handing
      // null to the sender here would kill the share instead.
      if (!this.state.screenSharing) await this.onVideoTrack?.(null);
      return;
    }

    const fresh = await acquireStream({
      audio: false,
      video: true,
      ...(this.preferences.cameraId !== undefined ? { cameraId: this.preferences.cameraId } : {}),
    });
    const track = fresh.getVideoTracks()[0];
    if (!track) throw new MediaError("missing", "No camera was found.");

    this.stream.addTrack(track);
    this.state = { ...this.state, cameraEnabled: true };
    this.emit();
    // Same rule in the other direction: the camera comes back on, but the screen
    // keeps the sender until the share ends. `stopScreenShare` hands it over.
    if (!this.state.screenSharing) await this.onVideoTrack?.(track);
  }

  /* ------------------------------------------------------------ screen share */

  /**
   * Starts sharing a screen, window or tab.
   *
   * Call this straight out of a click handler — see `acquireDisplayStream`.
   *
   * The microphone is not touched: no re-acquisition, no mute reset, not even a
   * read. Somebody who is muted stays muted through a share, which is the
   * behaviour people assume and the one that matters if they are wrong about it.
   */
  async startScreenShare(): Promise<MediaStreamTrack> {
    const display = await acquireDisplayStream();

    const track = display.getVideoTracks()[0];
    if (!track) {
      stopStream(display);
      throw new MediaError("missing", "That screen produced no video.");
    }

    // Anything else the picker handed back — a stray audio track from a browser
    // that ignores `audio: false` — is released rather than left running.
    for (const extra of display.getTracks()) {
      if (extra !== track) {
        extra.stop();
        display.removeTrack(extra);
      }
    }

    // Replacing one share with another: release the old screen first, but keep
    // `screenSharing` true throughout so the UI never blinks off and on.
    this.releaseDisplay();
    this.displayStream = display;

    // Sharpness over smoothness. A shared screen is mostly still text.
    track.contentHint = "detail";

    // The browser's own "Stop sharing" bar ends the track without telling the
    // page anything else. Without this listener the UI would go on claiming to
    // share a screen that stopped — the single most common screen-sharing bug,
    // and a privacy one rather than a cosmetic one.
    track.addEventListener("ended", this.handleDisplayEnded);

    this.state = { ...this.state, screenSharing: true };
    this.emit();
    await this.onVideoTrack?.(track);
    return track;
  }

  /**
   * Stops sharing, and gives the sender back to the camera if it is on.
   *
   * Idempotent — the user's Stop button and the browser's own both land here.
   */
  async stopScreenShare(): Promise<void> {
    if (!this.displayStream) return;

    this.releaseDisplay();
    this.state = { ...this.state, screenSharing: false };
    this.emit();

    // Whatever the camera was doing before the share, it is still doing. This is
    // where it goes back on the wire.
    const camera = this.state.cameraEnabled ? (this.stream?.getVideoTracks()[0] ?? null) : null;
    await this.onVideoTrack?.(camera);
  }

  isScreenSharing(): boolean {
    return this.displayStream !== null;
  }

  /** The screen as it is being sent, for the local preview. */
  getDisplayStream(): MediaStream | null {
    return this.displayStream;
  }

  private readonly handleDisplayEnded = () => {
    void this.stopScreenShare();
  };

  private releaseDisplay(): void {
    if (!this.displayStream) return;
    for (const track of this.displayStream.getTracks()) {
      track.removeEventListener("ended", this.handleDisplayEnded);
      track.stop();
    }
    this.displayStream = null;
  }

  /** Mid-device switch, without renegotiating. */
  async switchDevice(kind: MediaKind, deviceId: string): Promise<void> {
    if (!this.stream) return;

    if (kind === "audio") {
      this.preferences = { ...this.preferences, microphoneId: deviceId };
      const fresh = await acquireStream({ audio: true, video: false, microphoneId: deviceId });
      const track = fresh.getAudioTracks()[0];
      if (!track) return;

      // Carry the mute across: switching device must not silently unmute
      // somebody who thought they were muted.
      track.enabled = this.state.micEnabled;
      for (const old of this.stream.getAudioTracks()) {
        old.stop();
        this.stream.removeTrack(old);
      }
      this.stream.addTrack(track);
      this.emit();
      return;
    }

    this.preferences = { ...this.preferences, cameraId: deviceId };
    if (!this.state.cameraEnabled) return;

    const fresh = await acquireStream({ audio: false, video: true, cameraId: deviceId });
    const track = fresh.getVideoTracks()[0];
    if (!track) return;

    for (const old of this.stream.getVideoTracks()) {
      old.stop();
      this.stream.removeTrack(old);
    }
    this.stream.addTrack(track);
    this.emit();
    if (!this.state.screenSharing) await this.onVideoTrack?.(track);
  }

  stop(): void {
    // Both streams. A share left running after the call ends is a browser still
    // recording somebody's screen.
    this.releaseDisplay();
    stopStream(this.stream);
    this.stream = null;
    this.state = { ...DEFAULT_MEDIA_STATE, micEnabled: false, screenSharing: false };
    this.emit();
  }

  private emit(): void {
    this.onStateChange?.(this.getState());
  }
}
