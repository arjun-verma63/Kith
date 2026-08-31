"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  LocalMedia,
  MediaError,
  listDevices,
  type DeviceInfo,
  type MediaKind,
} from "@/lib/webrtc/media";
import { DEFAULT_MEDIA_STATE, type MediaState } from "@/lib/webrtc/signaling";

/**
 * React's view of the local microphone and camera.
 *
 * The logic lives in `LocalMedia`; this only mirrors it into state and makes
 * sure the hardware is released when the component goes away. Deliberately thin
 * — a camera that keeps recording after a call ends is a bug that no amount of
 * careful effect ordering will fix if the release is tangled up in a render.
 */

export interface UseLocalMediaOptions {
  /** Start capture immediately. False keeps the hook idle until `start()`. */
  autoStart?: boolean;
  /** Ask for the camera at the start. Voice calls do not. */
  video?: boolean;
  /**
   * Fires when the video track is replaced — including with null when the camera
   * is switched off. Wired to the peer connection so a camera toggle is a
   * `replaceTrack`, not a renegotiation.
   */
  onVideoTrack?: (track: MediaStreamTrack | null) => void | Promise<void>;
}

export interface LocalMediaApi {
  stream: MediaStream | null;
  /**
   * Whether capture succeeded, readable immediately after `await start()`.
   *
   * `stream` is React state and does not update until the next render, so a
   * caller that awaits `start()` and then branches on it always sees the old
   * value. This reads the controller directly.
   */
  hasStream: () => boolean;
  media: MediaState;
  error: MediaError | null;
  /** True while the camera is being acquired — the toggle should show it. */
  busy: boolean;
  devices: DeviceInfo[];
  start: (options?: { video?: boolean }) => Promise<void>;
  stop: () => void;
  toggleMic: () => void;
  toggleCamera: () => Promise<void>;
  switchDevice: (kind: MediaKind, deviceId: string) => Promise<void>;
  refreshDevices: () => Promise<void>;
}

export function useLocalMedia(options: UseLocalMediaOptions = {}): LocalMediaApi {
  const { autoStart = false, video = false, onVideoTrack } = options;

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [media, setMedia] = useState<MediaState>({ ...DEFAULT_MEDIA_STATE, micEnabled: false });
  const [error, setError] = useState<MediaError | null>(null);
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);

  const controller = useRef<LocalMedia | null>(null);
  if (controller.current === null) controller.current = new LocalMedia();

  // Kept in a ref so a parent re-render does not have to re-wire the controller.
  const videoTrackHandler = useRef(onVideoTrack);
  useEffect(() => {
    videoTrackHandler.current = onVideoTrack;
  });

  useEffect(() => {
    const local = controller.current;
    if (!local) return;

    local.onStateChange = (next) => setMedia(next);
    local.onVideoTrack = (track) => videoTrackHandler.current?.(track);

    return () => {
      local.onStateChange = null;
      local.onVideoTrack = null;
    };
  }, []);

  const toError = (thrown: unknown): MediaError =>
    thrown instanceof MediaError
      ? thrown
      : new MediaError("unknown", "Could not start your microphone or camera.", { cause: thrown });

  const start = useCallback(async (startOptions: { video?: boolean } = {}) => {
    const local = controller.current;
    if (!local) return;

    setBusy(true);
    setError(null);
    try {
      const next = await local.start({ video: startOptions.video ?? false });
      setStream(next);
      // Labels are blank until permission has been granted, so the device list
      // is only worth reading after a successful capture.
      setDevices(await listDevices());
    } catch (thrown) {
      setError(toError(thrown));
    } finally {
      setBusy(false);
    }
  }, []);

  const hasStream = useCallback(() => controller.current?.getStream() !== null, []);

  const stop = useCallback(() => {
    controller.current?.stop();
    setStream(null);
  }, []);

  const toggleMic = useCallback(() => {
    const local = controller.current;
    if (!local) return;
    local.setMicEnabled(!local.getState().micEnabled);
  }, []);

  const toggleCamera = useCallback(async () => {
    const local = controller.current;
    if (!local) return;

    setBusy(true);
    setError(null);
    try {
      await local.setCameraEnabled(!local.getState().cameraEnabled);
    } catch (thrown) {
      setError(toError(thrown));
    } finally {
      setBusy(false);
    }
  }, []);

  const switchDevice = useCallback(async (kind: MediaKind, deviceId: string) => {
    try {
      await controller.current?.switchDevice(kind, deviceId);
    } catch (thrown) {
      setError(toError(thrown));
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await listDevices());
    } catch {
      // A device list that cannot be read is not worth an error banner; the
      // picker simply stays as it was.
    }
  }, []);

  // Autostart, and — much more importantly — release on unmount. This is the
  // single line that stops the camera light staying on after a call.
  useEffect(() => {
    if (autoStart) void start({ video });

    const local = controller.current;
    return () => {
      local?.stop();
    };
  }, [autoStart, video, start]);

  // Devices come and go mid-call: a headset is plugged in, a webcam is
  // unplugged. Without this the picker shows a device that is no longer there.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;

    const onChange = () => void refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
  }, [refreshDevices]);

  return {
    stream,
    hasStream,
    media,
    error,
    busy,
    devices,
    start,
    stop,
    toggleMic,
    toggleCamera,
    switchDevice,
    refreshDevices,
  };
}
