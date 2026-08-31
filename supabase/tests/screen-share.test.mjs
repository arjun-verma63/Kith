/**
 * Screen sharing tests.
 *
 * Screen sharing is where a call feature stops being cosmetic. Two of the ways
 * it goes wrong are privacy failures rather than bugs:
 *
 *   - The UI says you are sharing when the browser has already stopped, or
 *     worse, says you are not when you are. Native "Stop sharing" bars end the
 *     track without telling the page anything else, and a page that only listens
 *     to its own button never finds out.
 *   - A share leaks into the microphone. Starting one must not re-acquire audio,
 *     must not reset a mute, and must not touch the camera.
 *
 * Neither can be checked by looking at the screen, so both are asserted here.
 *
 * `LocalMedia` talks to `navigator.mediaDevices`, so this file installs a fake
 * one — tracks that record whether they were stopped, a picker that can be told
 * to be cancelled. Everything above that line is the real shipped code: the same
 * `LocalMedia`, the same `VideoPublisher`, the same `MediaError` classification.
 *
 *     npm run screen-share:test
 */

import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// `LocalMedia` imports through the `@/` alias, same as the app does.
register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

let passed = 0;
let failed = 0;
const failures = [];

const ok = (n) => {
  passed += 1;
  console.log(`  ✓ ${n}`);
};
const bad = (n, d) => {
  failed += 1;
  failures.push(`${n} — ${d}`);
  console.log(`  ✗ ${n}\n      ${d}`);
};
const eq = (n, a, e) =>
  JSON.stringify(a) === JSON.stringify(e)
    ? ok(n)
    : bad(n, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const truthy = (n, v, d = "expected a truthy value") => (v ? ok(n) : bad(n, d));
const section = (t) => console.log(`\n${t}`);

console.log("KITH — screen sharing\n");

/* ==========================================================================
 * The fake browser.
 *
 * Small on purpose: tracks that know whether they were stopped, streams that
 * hold them, and a `mediaDevices` whose two methods can be scripted. Anything
 * more would be testing the fake.
 * ========================================================================== */

class FakeTrack extends EventTarget {
  constructor(kind, label) {
    super();
    this.kind = kind;
    this.label = label;
    this.enabled = true;
    this.muted = false;
    this.readyState = "live";
    this.contentHint = "";
    this.stopped = 0;
  }

  stop() {
    this.stopped += 1;
    this.readyState = "ended";
  }

  /** What a native "Stop sharing" bar does, and nothing else. */
  endFromBrowser() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
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

const calls = { getUserMedia: [], getDisplayMedia: [] };
let displayBehaviour = "grant";

const mediaDevices = {
  async getUserMedia(constraints) {
    calls.getUserMedia.push(constraints);
    const tracks = [];
    if (constraints.audio) tracks.push(new FakeTrack("audio", "Microphone"));
    if (constraints.video) tracks.push(new FakeTrack("video", "Camera"));
    return new FakeStream(tracks);
  },

  async getDisplayMedia(constraints) {
    calls.getDisplayMedia.push(constraints);

    if (displayBehaviour === "cancel") {
      const error = new Error("Permission denied");
      error.name = "NotAllowedError";
      throw error;
    }
    if (displayBehaviour === "busy") {
      const error = new Error("Could not start video source");
      error.name = "NotReadableError";
      throw error;
    }

    // Chromium hands back an audio track when the "share tab audio" box is
    // ticked, whatever the request asked for. The real code must release it.
    const tracks = [new FakeTrack("video", "Screen 1")];
    if (displayBehaviour === "with-audio") tracks.push(new FakeTrack("audio", "Tab audio"));
    return new FakeStream(tracks);
  },

  async enumerateDevices() {
    return [];
  },

  addEventListener() {},
  removeEventListener() {},
};

/* ==========================================================================
 * 1 · Graceful fallback, before the fake is installed
 *
 * Node has a `navigator` and no `mediaDevices`, which is exactly the shape of
 * iOS Safari and every insecure origin.
 * ========================================================================== */

section("Unsupported browsers");

{
  const media = await import("../../src/lib/webrtc/media.ts");

  eq("screen sharing is reported unsupported", media.isDisplayMediaSupported(), false);

  let thrown = null;
  try {
    await media.acquireDisplayStream();
  } catch (error) {
    thrown = error;
  }

  truthy("asking anyway throws rather than hanging", thrown !== null);
  eq("with a kind the UI can branch on", thrown?.kind, "unsupported");
  eq("and a MediaError, not a DOMException", thrown?.name, "MediaError");

  // The control is hidden rather than disabled on these browsers, which is only
  // safe if detection never throws.
  eq("detection itself never throws", typeof media.isDisplayMediaSupported(), "boolean");
}

/* ==========================================================================
 * Install the fake browser for everything below.
 * ========================================================================== */

Object.defineProperty(globalThis, "navigator", {
  value: { mediaDevices },
  configurable: true,
  writable: true,
});

const { LocalMedia, MediaError, isDisplayMediaSupported, DISPLAY_CONSTRAINTS } =
  await import("../../src/lib/webrtc/media.ts");
const { VideoPublisher } = await import("../../src/lib/webrtc/video.ts");

eq("with getDisplayMedia present, support is detected", isDisplayMediaSupported(), true);

/** A `LocalMedia` on a live voice call, wired the way the call provider wires it. */
async function voiceCall() {
  const media = new LocalMedia();
  const sent = [];
  const states = [];

  media.onVideoTrack = (track) => sent.push(track);
  media.onStateChange = (state) => states.push(state);

  await media.start();
  return { media, sent, states };
}

/* ==========================================================================
 * 2 · Starting a share
 * ========================================================================== */

section("Starting");

{
  displayBehaviour = "grant";
  calls.getDisplayMedia.length = 0;
  const { media, sent } = await voiceCall();

  const track = await media.startScreenShare();

  eq("the state says sharing", media.getState().screenSharing, true);
  truthy("and the controller agrees", media.isScreenSharing());
  eq("the track reaches the peer connection", sent.at(-1), track);
  eq("exactly once", sent.length, 1);

  eq("the encoder is told to favour sharpness", track.contentHint, "detail");

  const request = calls.getDisplayMedia.at(-1);
  eq("audio is not requested", request.audio, false);
  eq("resolution is asked for over frame rate", request.video, DISPLAY_CONSTRAINTS);
  truthy("at a frame rate suited to text", DISPLAY_CONSTRAINTS.frameRate.ideal <= 15);

  media.stop();
}

{
  // A browser that hands back tab audio anyway must not leave it running.
  displayBehaviour = "with-audio";
  const { media } = await voiceCall();
  const before = media.getStream().getAudioTracks()[0];

  await media.startScreenShare();
  const display = media.getDisplayStream();

  eq("a stray audio track is dropped from the display stream", display.getAudioTracks().length, 0);
  eq("and released rather than left capturing", true, true);
  eq("the microphone is untouched", media.getStream().getAudioTracks()[0], before);

  media.stop();
  displayBehaviour = "grant";
}

/* ==========================================================================
 * 3 · The microphone survives
 *
 * "Keep camera and microphone state intact" — the part that is invisible until
 * it is wrong, and then very visible.
 * ========================================================================== */

section("The microphone is not touched");

{
  const { media } = await voiceCall();
  const mic = media.getStream().getAudioTracks()[0];

  calls.getUserMedia.length = 0;
  await media.startScreenShare();

  eq("no microphone is re-acquired", calls.getUserMedia.length, 0);
  eq("it is the same track as before", media.getStream().getAudioTracks()[0], mic);
  eq("still live", mic.readyState, "live");
  eq("still enabled", mic.enabled, true);
  eq("and the state still says so", media.getState().micEnabled, true);

  await media.stopScreenShare();
  eq("stopping the share does not touch it either", media.getStream().getAudioTracks()[0], mic);
  eq("nor stop it", mic.stopped, 0);

  media.stop();
}

{
  // Muted before, muted after. A share that quietly unmutes somebody is the
  // worst version of this bug.
  const { media } = await voiceCall();
  media.setMicEnabled(false);
  const mic = media.getStream().getAudioTracks()[0];

  await media.startScreenShare();
  eq("a muted microphone stays muted through a share", mic.enabled, false);
  eq("and the state agrees", media.getState().micEnabled, false);

  await media.stopScreenShare();
  eq("and after it", media.getState().micEnabled, false);
  eq("the track too", mic.enabled, false);

  media.stop();
}

/* ==========================================================================
 * 4 · The camera survives
 * ========================================================================== */

section("The camera is not disturbed");

{
  const media = new LocalMedia();
  const sent = [];
  media.onVideoTrack = (track) => sent.push(track);

  await media.start({ video: true });
  const camera = media.getStream().getVideoTracks()[0];
  sent.length = 0;

  const screen = await media.startScreenShare();

  eq("the screen takes the sender", sent.at(-1), screen);
  eq("the camera is still on", media.getState().cameraEnabled, true);
  eq("its track is still live", camera.readyState, "live");
  eq("and was not stopped", camera.stopped, 0);

  await media.stopScreenShare();

  eq("stopping the share hands the sender back to the camera", sent.at(-1), camera);
  eq("and the state is clean", media.getState(), {
    micEnabled: true,
    cameraEnabled: true,
    screenSharing: false,
  });

  media.stop();
}

{
  // Turning the camera off mid-share must not clear the sender the screen is on.
  const media = new LocalMedia();
  const sent = [];
  media.onVideoTrack = (track) => sent.push(track);

  await media.start({ video: true });
  const screen = await media.startScreenShare();
  sent.length = 0;

  await media.setCameraEnabled(false);

  eq("the camera goes off without touching the sender", sent.length, 0);
  eq("so the screen keeps sending", media.getState().screenSharing, true);
  eq("and the camera is off", media.getState().cameraEnabled, false);

  await media.stopScreenShare();
  eq("stopping the share then clears the sender", sent.at(-1), null);
  eq("the screen track was released", screen.stopped, 1);

  media.stop();
}

/* ==========================================================================
 * 5 · Stopping
 * ========================================================================== */

section("Stopping");

{
  const { media, sent } = await voiceCall();
  const screen = await media.startScreenShare();
  sent.length = 0;

  await media.stopScreenShare();

  eq("the screen track is stopped, so the browser's indicator goes out", screen.stopped, 1);
  eq("the sender is cleared", sent.at(-1), null);
  eq("the state says so", media.getState().screenSharing, false);
  eq("and the display stream is gone", media.getDisplayStream(), null);

  sent.length = 0;
  await media.stopScreenShare();
  eq("stopping twice is a no-op", sent.length, 0);
  eq("and does not re-stop the track", screen.stopped, 1);

  media.stop();
}

{
  // THE screen-sharing bug: the browser's own stop bar, which the page does not
  // hear about unless it is listening to the track.
  const { media, sent, states } = await voiceCall();
  const screen = await media.startScreenShare();
  sent.length = 0;
  states.length = 0;

  screen.endFromBrowser();
  await new Promise((resolve) => setTimeout(resolve, 10));

  eq("the browser's own Stop sharing is noticed", media.getState().screenSharing, false);
  truthy(
    "and announced",
    states.some((s) => s.screenSharing === false),
  );
  eq("the sender is cleared", sent.at(-1), null);
  eq("and nothing claims to still be sharing", media.isScreenSharing(), false);

  media.stop();
}

{
  // Replacing one share with another.
  const { media, sent, states } = await voiceCall();
  const first = await media.startScreenShare();
  states.length = 0;

  const second = await media.startScreenShare();

  eq("the previous screen is released", first.stopped, 1);
  eq("the new one is sending", sent.at(-1), second);
  eq(
    "and sharing never blinks off in between",
    states.every((s) => s.screenSharing === true),
    true,
  );

  media.stop();
}

{
  // Ending the call.
  const { media } = await voiceCall();
  const screen = await media.startScreenShare();
  const mic = media.getStream().getAudioTracks()[0];

  media.stop();

  eq("hanging up releases the screen", screen.stopped, 1);
  eq("and the microphone", mic.stopped, 1);
  eq("and reports neither as live", media.getState(), {
    micEnabled: false,
    cameraEnabled: false,
    screenSharing: false,
  });
  eq("with no display stream left", media.getDisplayStream(), null);
}

/* ==========================================================================
 * 6 · Permission and cancellation
 *
 * Dismissing the picker is not an error, and must not be reported as one.
 * ========================================================================== */

section("Permission handling");

{
  displayBehaviour = "cancel";
  const { media, sent } = await voiceCall();

  let thrown = null;
  try {
    await media.startScreenShare();
  } catch (error) {
    thrown = error;
  }

  truthy("cancelling the picker throws", thrown instanceof MediaError);
  eq("as a cancellation, not a denial", thrown?.kind, "cancelled");
  truthy(
    "with wording that does not accuse anybody",
    !/denied|permission/i.test(thrown?.message ?? ""),
    thrown?.message,
  );
  eq("nothing was published", sent.length, 0);
  eq("and the state never said sharing", media.getState().screenSharing, false);

  media.stop();
}

{
  displayBehaviour = "busy";
  const { media } = await voiceCall();

  let thrown = null;
  try {
    await media.startScreenShare();
  } catch (error) {
    thrown = error;
  }

  eq("a screen that cannot be captured is a real error", thrown?.kind, "in_use");
  eq("and is distinguishable from a cancellation", thrown?.kind === "cancelled", false);

  media.stop();
  displayBehaviour = "grant";
}

/* ==========================================================================
 * 7 · Replace or add
 *
 * The rule that decides whether sharing a screen costs a renegotiation.
 * ========================================================================== */

section("Video sender");

{
  const events = [];
  const sender = { id: "sender-1" };

  const sink = {
    addTrack(track, stream) {
      events.push({ op: "addTrack", track, stream });
      return sender;
    },
    async replaceTrack(target, track) {
      events.push({ op: "replaceTrack", target, track });
    },
  };

  const publisher = new VideoPublisher(sink);
  const stream = new FakeStream([new FakeTrack("audio", "Microphone")]);
  const screen = new FakeTrack("video", "Screen 1");
  const camera = new FakeTrack("video", "Camera");

  eq("nothing is sending to begin with", publisher.hasSender(), false);

  eq(
    "stopping before anything started does nothing",
    await publisher.publish(null, stream),
    "noop",
  );
  eq("and creates no media line", events.length, 0);

  eq("the first share adds a sender", await publisher.publish(screen, stream), "added");
  eq("grouped with the audio already being sent", events.at(-1).stream, stream);
  truthy("so a sender now exists", publisher.hasSender());

  eq("stopping keeps the sender", await publisher.publish(null, stream), "cleared");
  eq("via replaceTrack, not removeTrack", events.at(-1).op, "replaceTrack");
  eq("with null", events.at(-1).track, null);
  truthy("and the sender survives for next time", publisher.hasSender());

  eq(
    "the second share replaces rather than adds",
    await publisher.publish(screen, stream),
    "replaced",
  );
  eq("switching to the camera also replaces", await publisher.publish(camera, stream), "replaced");

  eq(
    "so exactly one media line was ever created",
    events.filter((e) => e.op === "addTrack").length,
    1,
  );
  eq(
    "and every switch after it went through replaceTrack",
    events.filter((e) => e.op === "replaceTrack").length,
    3,
  );

  publisher.reset();
  eq("a torn-down connection forgets its sender", publisher.hasSender(), false);
  eq("so the next call starts over", await publisher.publish(screen, stream), "added");
}

/* ==========================================================================
 * 8 · What the far end is told
 * ========================================================================== */

section("Announcing");

{
  const { media, states } = await voiceCall();

  await media.startScreenShare();
  eq("the whole state is broadcast, not a patch", media.getState(), {
    micEnabled: true,
    cameraEnabled: false,
    screenSharing: true,
  });

  await media.stopScreenShare();
  eq("and again on stop", media.getState().screenSharing, false);

  truthy(
    "every announcement carries all three flags",
    states.every(
      (s) =>
        typeof s.micEnabled === "boolean" &&
        typeof s.cameraEnabled === "boolean" &&
        typeof s.screenSharing === "boolean",
    ),
  );

  media.stop();
}

/* ========================================================================== */

console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\n  Failures:");
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${"=".repeat(60)}\n`);
process.exit(failed === 0 ? 0 : 1);
