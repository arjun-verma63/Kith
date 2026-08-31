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

/** A getUserMedia failure the UI can actually say something about. */
export class MediaError extends Error {
  readonly kind: "denied" | "missing" | "in_use" | "unsupported" | "unknown";

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

/** Screen share. Separate call, separate permission, separate prompt. */
export async function acquireDisplayStream(): Promise<MediaStream> {
  try {
    return await mediaDevices().getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      // Tab audio when the browser offers it. Chromium does, Firefox mostly
      // does not, and neither case is an error.
      audio: true,
    });
  } catch (error) {
    throw classify(error);
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
  private state: MediaState = { ...DEFAULT_MEDIA_STATE };
  private preferences: DevicePreferences = {};

  /**
   * Called when the video track is replaced, so the peer connection can
   * `replaceTrack` on the existing sender instead of renegotiating.
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
      await this.onVideoTrack?.(null);
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
    await this.onVideoTrack?.(track);
  }

  /** Mid-call device switch, without renegotiating. */
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
    await this.onVideoTrack?.(track);
  }

  stop(): void {
    stopStream(this.stream);
    this.stream = null;
    this.state = { ...DEFAULT_MEDIA_STATE, micEnabled: false };
    this.emit();
  }

  private emit(): void {
    this.onStateChange?.(this.getState());
  }
}
