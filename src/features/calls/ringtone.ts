"use client";

/**
 * The ring.
 *
 * Synthesised rather than shipped as a file: two sine tones through a soft
 * envelope is a few lines and no bytes, and an asset would have to be designed,
 * licensed and downloaded before anybody could hear a call.
 *
 * A rising two-note figure for an incoming call, a slow single tone for the
 * outgoing ringback — the same distinction a telephone makes, and one people
 * already know without being told.
 *
 * ── This is allowed to fail ──────────────────────────────────────────────────
 *
 * Browsers refuse to start audio until the page has been interacted with. A
 * person sitting on a freshly restored tab may genuinely get no sound, and there
 * is no way around that from script. So every call here is best-effort and the
 * visual ring never depends on it: `resume()` is attempted, failures are
 * swallowed, and the incoming UI is loud enough on its own.
 */

const INCOMING_PATTERN = [
  { frequency: 587.33, at: 0, duration: 0.28 }, // D5
  { frequency: 783.99, at: 0.3, duration: 0.42 }, // G5
];

const OUTGOING_PATTERN = [{ frequency: 440, at: 0, duration: 0.7 }];

/** Seconds between repeats. Roughly the cadence of a UK ringing tone. */
const INCOMING_INTERVAL = 2.4;
const OUTGOING_INTERVAL = 3.6;

type Mode = "incoming" | "outgoing";

let context: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;

  try {
    context ??= new AudioContext();
    return context;
  } catch {
    return null;
  }
}

function tone(ctx: AudioContext, frequency: number, at: number, duration: number, gain: number) {
  const oscillator = ctx.createOscillator();
  const envelope = ctx.createGain();

  oscillator.type = "sine";
  oscillator.frequency.value = frequency;

  const start = ctx.currentTime + at;

  // A short fade at each end. A square-edged tone clicks, and a click on a
  // ringtone sounds like a fault rather than a phone.
  envelope.gain.setValueAtTime(0, start);
  envelope.gain.linearRampToValueAtTime(gain, start + 0.02);
  envelope.gain.setValueAtTime(gain, start + duration - 0.06);
  envelope.gain.linearRampToValueAtTime(0, start + duration);

  oscillator.connect(envelope);
  envelope.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function ringOnce(mode: Mode) {
  const ctx = audioContext();
  if (!ctx) return;

  // Best-effort. A context blocked by autoplay policy simply stays suspended.
  void ctx.resume().catch(() => {});
  if (ctx.state !== "running") return;

  const pattern = mode === "incoming" ? INCOMING_PATTERN : OUTGOING_PATTERN;
  // The outgoing ringback is quieter: it is feedback for something you chose to
  // do, not a demand for attention.
  const gain = mode === "incoming" ? 0.12 : 0.05;

  for (const note of pattern) tone(ctx, note.frequency, note.at, note.duration, gain);
}

/** Starts ringing, and keeps ringing until stopped. Safe to call twice. */
export function startRinging(mode: Mode): void {
  stopRinging();

  ringOnce(mode);
  const interval = (mode === "incoming" ? INCOMING_INTERVAL : OUTGOING_INTERVAL) * 1000;
  timer = setInterval(() => ringOnce(mode), interval);
}

export function stopRinging(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
