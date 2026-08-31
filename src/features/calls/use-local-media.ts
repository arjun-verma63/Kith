"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  LocalMedia,
  MediaError,
  isDisplayMediaSupported,
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
  /**
   * The live media state, readable immediately after an await.
   *
   * `media` is React state and lags by a render, so a callback that awaits a
   * toggle and then reads it publishes what was true before. This reads the
   * controller, which is the authority.
   */
  getState: () => MediaState;
  /** The screen being shared, for the local preview. Null when not sharing. */
  displayStream: MediaStream | null;
  /**
   * False where `getDisplayMedia` does not exist — iOS, embedded webviews, any
   * insecure origin. The control is hidden rather than disabled: a button that
   * can never work is not a button.
   */
  screenShareSupported: boolean;
  error: MediaError | null;
  /** True while the camera is being acquired — the toggle should show it. */
  busy: boolean;
  devices: DeviceInfo[];
  start: (options?: { video?: boolean }) => Promise<void>;
  stop: () => void;
  toggleMic: () => void;
  toggleCamera: () => Promise<void>;
  /**
   * Must be called straight out of a click handler.
   *
   * `getDisplayMedia` needs transient activation, and awaiting anything first
   * spends it — so this does no server work before the picker opens.
   */
  toggleScreenShare: () => Promise<void>;
  switchDevice: (kind: MediaKind, deviceId: string) => Promise<void>;
  refreshDevices: () => Promise<void>;
}

/** Support cannot change during a session, so there is nothing to subscribe to. */
const subscribeToNothing = () => () => {};
const returnFalse = () => false;

export function useLocalMedia(options: UseLocalMediaOptions = {}): LocalMediaApi {
  const { autoStart = false, video = false, onVideoTrack } = options;

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [media, setMedia] = useState<MediaState>({ ...DEFAULT_MEDIA_STATE, micEnabled: false });
  const [error, setError] = useState<MediaError | null>(null);
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [displayStream, setDisplayStream] = useState<MediaStream | null>(null);

  /**
   * Feature detection that survives hydration.
   *
   * A plain `isDisplayMediaSupported()` call would answer false on the server and
   * true in the browser, and the overlay IS server-rendered — somebody who
   * refreshes mid-call gets it from the server. `useSyncExternalStore` is the
   * mechanism for exactly this: a server snapshot, a client snapshot, and React
   * reconciling them without a mismatch warning.
   */
  const screenShareSupported = useSyncExternalStore(
    subscribeToNothing,
    isDisplayMediaSupported,
    returnFalse,
  );

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

    local.onStateChange = (next) => {
      setMedia(next);
      // Covers the share ending from outside this component — the browser's own
      // stop bar, or the window being closed. The controller is the authority on
      // whether a screen is still being captured.
      setDisplayStream(next.screenSharing ? local.getDisplayStream() : null);
    };
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

  const getState = useCallback(
    () => controller.current?.getState() ?? { ...DEFAULT_MEDIA_STATE, micEnabled: false },
    [],
  );

  const stop = useCallback(() => {
    controller.current?.stop();
    setStream(null);
    setDisplayStream(null);
  }, []);

  const toggleMic = useCallback(() => {
    const local = controller.current;
    if (!local) return;
    local.setMicEnabled(!local.getState().micEnabled);
  }, []);

  /**
   * Start or stop sharing.
   *
   * The state is read from the controller rather than from React state, because
   * the browser's own "Stop sharing" bar can end a share without this component
   * doing anything — and a toggle that reads a stale render would then try to
   * stop a share that had already stopped.
   */
  const toggleScreenShare = useCallback(async () => {
    const local = controller.current;
    if (!local) return;

    if (local.isScreenSharing()) {
      await local.stopScreenShare();
      setDisplayStream(null);
      return;
    }

    setError(null);
    try {
      // No await before this line: the picker needs the click's activation.
      await local.startScreenShare();
      setDisplayStream(local.getDisplayStream());
    } catch (thrown) {
      const failure = toError(thrown);
      // Changing your mind in the picker is not an error and gets no banner.
      if (failure.kind !== "cancelled") setError(failure);
      setDisplayStream(null);
    }
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
    getState,
    displayStream,
    screenShareSupported,
    error,
    busy,
    devices,
    start,
    stop,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    switchDevice,
    refreshDevices,
  };
}
