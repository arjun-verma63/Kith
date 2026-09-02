/**
 * Microphone and camera: permissions, absence, and the two toggles.
 *
 * `screen-share.test.mjs` already drives `LocalMedia`, but only through
 * `getDisplayMedia` — every one of its permission assertions is about the screen
 * picker. The camera and microphone half was untested, which is the half every
 * call goes through and the half where a refused permission is a normal Tuesday
 * rather than an edge case.
 *
 * Three things are worth testing here and are easy to get wrong:
 *
 *   CLASSIFICATION  Browsers report the same few problems under half a dozen
 *                   names, and they do not agree with each other. "Permission
 *                   denied", "no camera plugged in" and "Zoom has the camera"
 *                   need three different sentences, because the fix is
 *                   different in each case and a wrong one sends somebody to
 *                   the wrong settings page.
 *
 *   THE RETRY       A remembered device that has since been unplugged must not
 *                   fail the whole call. Somebody whose preferred microphone is
 *                   gone should get the default one, not a message saying they
 *                   have no microphone.
 *
 *   MUTED vs OFF    The microphone toggles `enabled` and stays open; the camera
 *                   is stopped and re-acquired, because a person who presses
 *                   "camera off" and watches the light stay on has been lied to.
 *                   The asymmetry is deliberate and only a test keeps it.
 *
 * The fake browser below is the same shape as the screen-share suite's, so the
 * two read alike. What is NOT covered: whether a real browser raises the errors
 * these names describe. That is in the manual checklist.
 *
 *     npm run call-media:test
 */

import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register(pathToFileURL(join(process.cwd(), "supabase/tests/alias-loader.mjs")).href);

let passed = 0;
let failed = 0;
const failures = [];

const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const bad = (name, detail) => {
  failed += 1;
  failures.push(`${name} — ${detail}`);
  console.log(`  ✗ ${name}\n      ${detail}`);
};

const eq = (name, actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected)
    ? ok(name)
    : bad(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const truthy = (name, value, detail = "expected a truthy value") =>
  value ? ok(name) : bad(name, detail);

const section = (title) => console.log(`\n${title}`);

console.log("KITH — microphone and camera\n");

/* ==========================================================================
 * The fake browser
 * ========================================================================== */

class FakeTrack {
  constructor(kind, label) {
    this.kind = kind;
    this.label = label;
    this.enabled = true;
    this.readyState = "live";
    this.contentHint = "";
    this.stopped = 0;
  }
  stop() {
    this.stopped += 1;
    this.readyState = "ended";
  }
}

class FakeStream {
  constructor(tracks = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(track) {
    if (!this.tracks.includes(track)) this.tracks.push(track);
  }
  removeTrack(track) {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}

/** Requests seen, so the retry can be observed rather than inferred. */
let requests = [];
/** A queue of behaviours; each request shifts one. "grant" once empty. */
let behaviours = [];
let deviceList = [];

function named(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

const mediaDevices = {
  async getUserMedia(constraints) {
    requests.push(constraints);
    const behaviour = behaviours.shift() ?? "grant";

    if (behaviour !== "grant") throw named(behaviour);

    const tracks = [];
    if (constraints.audio) tracks.push(new FakeTrack("audio", "Microphone"));
    if (constraints.video) tracks.push(new FakeTrack("video", "Camera"));
    return new FakeStream(tracks);
  },

  async getDisplayMedia() {
    throw named("NotAllowedError");
  },

  async enumerateDevices() {
    return deviceList;
  },
};

// Node 24 defines `navigator` as a getter-only global, so it has to be replaced
// rather than assigned — the same dance `screen-share.test.mjs` does.
function installNavigator(value) {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
}

installNavigator({ mediaDevices });

function reset(nextBehaviours = [], devices = []) {
  requests = [];
  behaviours = [...nextBehaviours];
  deviceList = devices;
}

const { acquireStream, listDevices, stopStream, LocalMedia, MediaError } =
  await import("../../src/lib/webrtc/media.ts");

async function failureOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

/* ==========================================================================
 * 1 · What the browser is asked for
 * ========================================================================== */

section("The request");

{
  /*
   * Audio-first. A KITH call is a voice call that may grow a camera, so asking
   * for both up front would put a camera light on during an audio call and
   * prompt for a permission nobody needs yet.
   */
  reset();
  await acquireStream();

  truthy("a plain call asks for a microphone", requests[0]?.audio !== false);
  eq("and explicitly not a camera", requests[0]?.video, false);
}

{
  reset();
  await acquireStream({ video: true });
  truthy(
    "a video call asks for both",
    requests[0]?.audio !== false && requests[0]?.video !== false,
  );
}

{
  reset();
  const error = await failureOf(acquireStream({ audio: false, video: false }));
  eq("asking for nothing is refused rather than returning an empty stream", error?.kind, "missing");
  eq("and the browser is never troubled", requests.length, 0);
}

{
  /*
   * Echo cancellation matters more here than it looks. KITH calls happen on
   * laptop speakers in shared rooms, and without it the far end hears itself.
   */
  reset();
  await acquireStream();
  const audio = requests[0]?.audio;
  truthy("echo cancellation is asked for", audio?.echoCancellation === true);
  truthy("as is noise suppression", audio?.noiseSuppression === true);
  truthy("and automatic gain", audio?.autoGainControl === true);
}

/* ==========================================================================
 * 2 · When permission is refused
 * ========================================================================== */

section("Permissions");

{
  /*
   * The case that actually happens. Every one of these needs a different
   * sentence, because the fix is different: unblock a permission, plug
   * something in, or quit the app holding the device.
   */
  const cases = [
    ["NotAllowedError", "denied", /permission/i],
    ["SecurityError", "denied", /permission/i],
    ["NotFoundError", "missing", /no microphone or camera/i],
    ["OverconstrainedError", "missing", /no microphone or camera/i],
    ["NotReadableError", "in_use", /another app/i],
    ["AbortError", "in_use", /another app/i],
    ["TypeError", "unknown", /could not start/i],
  ];

  for (const [name, kind, wording] of cases) {
    reset([name]);
    const error = await failureOf(acquireStream());

    truthy(`${name} becomes a MediaError`, error instanceof MediaError, `got ${error?.name}`);
    eq(`  classified as ${kind}`, error?.kind, kind);
    truthy(
      `  and says something a person can act on`,
      wording.test(error?.message ?? ""),
      error?.message,
    );
  }
}

{
  /*
   * A denial must not accuse the browser of being broken, and a missing device
   * must not tell somebody to check a permission they never refused. Getting
   * these two the wrong way round is the most common version of this bug.
   */
  reset(["NotAllowedError"]);
  const denied = await failureOf(acquireStream());
  reset(["NotFoundError"]);
  const missing = await failureOf(acquireStream());

  truthy(
    "a denial mentions the address bar, where the fix is",
    /address bar/i.test(denied?.message ?? ""),
    denied?.message,
  );
  truthy(
    "and a missing device does not send somebody to a permission dialog",
    !/permission|address bar/i.test(missing?.message ?? ""),
    missing?.message,
  );
}

{
  // The original is kept, so a bug report can still say what the browser said.
  reset(["NotAllowedError"]);
  const error = await failureOf(acquireStream());
  eq("the browser's own error is kept as the cause", error?.cause?.name, "NotAllowedError");
}

/* ==========================================================================
 * 3 · A remembered device that is no longer there
 * ========================================================================== */

section("Device preferences");

{
  reset();
  await acquireStream({ microphoneId: "usb-mic" });

  eq(
    "a remembered microphone is asked for as a preference, not a requirement",
    requests[0]?.audio?.deviceId,
    { ideal: "usb-mic" },
  );
}

{
  /*
   * THE case this retry exists for: somebody's headset is unplugged between
   * calls. `ideal` should already degrade to the default, but browsers disagree
   * about that, and a call that fails because a remembered device is gone is a
   * call that fails for no reason the person can see.
   */
  reset(["NotFoundError"]);
  const stream = await acquireStream({ microphoneId: "unplugged-headset" });

  eq("an unplugged preference is retried", requests.length, 2);
  truthy(
    "with no device preference the second time",
    requests[1]?.audio?.deviceId === undefined,
    JSON.stringify(requests[1]),
  );
  truthy("and the call gets a microphone after all", stream.getAudioTracks().length === 1);
}

{
  // But a genuine refusal must not be retried into a second permission prompt.
  reset(["NotAllowedError", "NotAllowedError"]);
  const error = await failureOf(acquireStream({ microphoneId: "usb-mic" }));
  eq("a denial that survives the retry is still a denial", error?.kind, "denied");
}

{
  reset(["NotFoundError", "NotFoundError"]);
  const error = await failureOf(acquireStream({ microphoneId: "ghost" }));
  eq("and a device that is genuinely absent is reported after the retry", error?.kind, "missing");
  eq("having tried exactly twice, not in a loop", requests.length, 2);
}

{
  // No preference means no retry — one prompt, one answer.
  reset(["NotFoundError"]);
  await failureOf(acquireStream());
  eq("without a remembered device there is nothing to retry", requests.length, 1);
}

/* ==========================================================================
 * 4 · Muted is not off
 * ========================================================================== */

section("The microphone");

{
  reset();
  const media = new LocalMedia();
  await media.start();

  const track = media.getStream().getAudioTracks()[0];

  eq("a call starts unmuted", media.getState().micEnabled, true);

  media.setMicEnabled(false);
  eq("muting is reflected in the state", media.getState().micEnabled, false);
  eq("  and on the track", track.enabled, false);
  eq("  but the hardware stays open, so unmuting is instant", track.stopped, 0);
  eq("  and the track is still live", track.readyState, "live");

  media.setMicEnabled(true);
  eq("unmuting needs no new permission prompt", requests.length, 1);
  eq("  and reuses the same track", media.getStream().getAudioTracks()[0], track);
}

section("The camera");

{
  reset();
  const media = new LocalMedia();
  await media.start({ video: true });

  const original = media.getStream().getVideoTracks()[0];
  const handed = [];
  media.onVideoTrack = (track) => {
    handed.push(track);
  };

  await media.setCameraEnabled(false);

  eq("turning the camera off reports it off", media.getState().cameraEnabled, false);
  eq("  and STOPS the track, so the hardware light goes out", original.stopped, 1);
  eq("  the track leaves the stream", media.getStream().getVideoTracks().length, 0);
  eq("  and the sender is told there is nothing to send", handed, [null]);

  await media.setCameraEnabled(true);

  eq("turning it back on re-acquires the device", requests.length, 2);
  eq("  asking only for video, so the microphone is not disturbed", requests[1]?.audio, false);
  eq("  and reports it on", media.getState().cameraEnabled, true);
  truthy(
    "  the fresh track is handed to the sender rather than renegotiated",
    handed[1] instanceof FakeTrack && handed[1] !== original,
  );
}

{
  /*
   * A camera that is refused when it is turned back on mid-call must not leave
   * the state saying it is on. The person would see their own preview black and
   * a control claiming otherwise.
   */
  reset();
  const media = new LocalMedia();
  await media.start({ video: true });
  await media.setCameraEnabled(false);

  behaviours = ["NotReadableError"];
  const error = await failureOf(media.setCameraEnabled(true));

  eq("a camera grabbed by another app is reported", error?.kind, "in_use");
  eq("and the state does not claim the camera is on", media.getState().cameraEnabled, false);
}

{
  reset();
  const media = new LocalMedia();
  await media.start();

  // No stream means nothing to do — not a crash, and not a permission prompt.
  const before = requests.length;
  const audioOnly = new LocalMedia();
  await audioOnly.setCameraEnabled(true);
  eq("toggling a camera before a call starts does nothing", requests.length, before);
  eq("and asks for no permission", audioOnly.getState().cameraEnabled, false);
}

/* ==========================================================================
 * 5 · Letting go
 * ========================================================================== */

section("Release");

{
  reset();
  const media = new LocalMedia();
  await media.start({ video: true });
  const tracks = media.getStream().getTracks();

  stopStream(media.getStream());

  truthy(
    "every track is stopped, so both indicators go out",
    tracks.every((t) => t.stopped === 1),
    tracks.map((t) => `${t.kind}:${t.stopped}`).join(" "),
  );
}

{
  eq("stopping nothing is not an error", stopStream(null), undefined);
}

/* ==========================================================================
 * 6 · The device picker
 * ========================================================================== */

section("Devices");

{
  /*
   * Labels are empty until permission has been granted once. That is the spec,
   * not a bug — but a picker showing three blank rows is unusable, so the
   * fallback name has to exist.
   */
  reset(
    [],
    [
      { deviceId: "a", kind: "audioinput", label: "" },
      { deviceId: "b", kind: "videoinput", label: "" },
      { deviceId: "c", kind: "audiooutput", label: "Speakers" },
    ],
  );

  const devices = await listDevices();

  eq("outputs are not offered as inputs", devices.length, 2);
  eq("an unlabelled microphone still has a name", devices[0]?.label, "Microphone 1");
  eq("and so does an unlabelled camera", devices[1]?.label, "Camera 2");
}

{
  reset([], [{ deviceId: "a", kind: "audioinput", label: "Blue Yeti" }]);
  const devices = await listDevices();
  eq("a real label is used as-is", devices[0]?.label, "Blue Yeti");
}

/* ==========================================================================
 * 7 · No media device at all
 * ========================================================================== */

section("Insecure or unsupported");

{
  /*
   * `navigator.mediaDevices` is undefined on an http:// origin other than
   * localhost. "Your camera is broken" and "this page is not secure" are very
   * different problems and must not share a message — the second one is fixed by
   * the operator, not by the person on the call.
   */
  installNavigator({});

  const error = await failureOf(acquireStream());
  eq("a page with no media devices says so", error?.kind, "unsupported");
  truthy(
    "and blames the connection rather than the hardware",
    /https|secure/i.test(error?.message ?? ""),
    error?.message,
  );

  installNavigator({ mediaDevices });
}

/* ========================================================================== */

console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\n  Failures:");
  for (const failure of failures) console.log(`    - ${failure}`);
}
console.log("=".repeat(60));

process.exit(failed > 0 ? 1 : 0);
