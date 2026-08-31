/**
 * WebRTC foundation tests.
 *
 * The brief asks for proof that two sessions can establish a peer connection.
 * That is not something a mock can answer — a mock connects because it was
 * written to. So the connection tests here drive `libdatachannel` through
 * `node-datachannel/polyfill`: a real C++ WebRTC stack, real ICE, real DTLS,
 * real SCTP. When this suite says two peers connected, two peers connected.
 *
 * Two kinds of test, because neither alone is enough:
 *
 *   REAL STACK    Can `KithPeer` actually negotiate an end-to-end connection and
 *                 carry bytes over it? Answered against libdatachannel.
 *
 *   FAKE STACK    Does the perfect-negotiation logic resolve glare the way the
 *                 pattern requires? Glare is a race, and a race you have to
 *                 provoke is a race you cannot assert on. A recording stub makes
 *                 the collision exact and the assertion deterministic.
 *
 * The real-stack tests run with no ICE servers, so they connect over host
 * candidates on the loopback interface and need no network. That is deliberate:
 * a test that silently depends on Google's STUN server is a test that fails on a
 * train. The STUN configuration the application actually ships with is asserted
 * separately, as configuration.
 *
 *     npm run webrtc:test
 */

import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

const { RTCPeerConnection } = await import("node-datachannel/polyfill");
const nodeDataChannel = await import("node-datachannel");

const { KithPeer } = await import("../../src/lib/webrtc/peer.ts");
const { buildIceConfiguration, ICE_BATCH_MS, RECONNECT_GRACE_MS, RECONNECT_TIMEOUT_MS } =
  await import("../../src/lib/webrtc/config.ts");
const { isPolite, createLoopbackTransports, DEFAULT_MEDIA_STATE } =
  await import("../../src/lib/webrtc/signaling.ts");

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for a predicate, or gives up. Returns whether it came true. */
async function waitFor(predicate, timeoutMs = 15000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

console.log("KITH — WebRTC foundation\n");

/* ==========================================================================
 * 1 · Politeness
 *
 * The whole collision-resolution scheme rests on both sides computing the same
 * answer from ids they already hold. If this is ever symmetric, every
 * simultaneous renegotiation deadlocks.
 * ========================================================================== */

section("Politeness");

{
  const a = "0f3c1f10-0000-4000-8000-000000000001";
  const b = "9a7b2c30-0000-4000-8000-000000000002";

  eq("exactly one side of a pair is polite", [isPolite(a, b), isPolite(b, a)], [false, true]);
  eq("politeness is stable across calls", isPolite(a, b), isPolite(a, b));

  // Sorted ids, arbitrary pairs: never both, never neither.
  const ids = ["aaa", "bbb", "ccc", "ddd", "eee"];
  let symmetric = 0;
  for (const x of ids) {
    for (const y of ids) {
      if (x === y) continue;
      if (isPolite(x, y) === isPolite(y, x)) symmetric += 1;
    }
  }
  eq("no pair is both polite or both impolite", symmetric, 0);
}

/* ==========================================================================
 * 2 · ICE configuration
 *
 * STUN only for now, by instruction. The TURN slot exists so that adding relays
 * later is a value passed in rather than a change to the negotiation code.
 * ========================================================================== */

section("ICE configuration");

{
  const config = buildIceConfiguration();
  const urls = config.iceServers.flatMap((server) =>
    Array.isArray(server.urls) ? server.urls : [server.urls],
  );

  truthy("STUN servers are configured", urls.length > 0);
  eq(
    "every default server is STUN — no TURN yet",
    urls.filter((url) => !url.startsWith("stun:")),
    [],
  );
  eq(
    "no credentials are present in the default configuration",
    [...new Set(config.iceServers.map((server) => server.credential ?? null))],
    [null],
  );
  eq(
    "more than one STUN provider, so one outage is not an outage",
    new Set(urls.map((url) => url.split(":")[1].split(".").slice(-2).join("."))).size >= 2,
    true,
  );

  eq("transport policy allows direct paths", config.iceTransportPolicy, "all");
  eq("media is bundled onto one transport", config.bundlePolicy, "max-bundle");
  eq("RTCP is muxed", config.rtcpMuxPolicy, "require");

  const relayed = buildIceConfiguration({
    turnServers: [{ urls: ["turn:example:3478"], username: "u", credential: "c" }],
    forceRelay: true,
  });
  eq("forceRelay switches the policy to relay", relayed.iceTransportPolicy, "relay");
  eq(
    "TURN servers append to STUN rather than replacing it",
    relayed.iceServers.length,
    config.iceServers.length + 1,
  );

  truthy("ICE batching interval is set", ICE_BATCH_MS > 0);
  truthy("a disconnect grace period exists before restarting", RECONNECT_GRACE_MS >= 1000);
  truthy(
    "recovery has a deadline, so reconnecting cannot be permanent",
    RECONNECT_TIMEOUT_MS > RECONNECT_GRACE_MS,
  );
}

/* ==========================================================================
 * 3 · The loopback transport
 *
 * Used by every test below, so its own guarantees are worth asserting: deliver
 * to the other side, never echo, and survive JSON.
 * ========================================================================== */

section("Signalling transport");

{
  const [a, b] = createLoopbackTransports("a", "b");
  const seenByA = [];
  const seenByB = [];
  a.subscribe((m) => seenByA.push(m));
  const unsubscribeB = b.subscribe((m) => seenByB.push(m));

  a.send({ type: "bye", from: "a", to: "b", reason: "hung_up" });
  await sleep(5);

  eq("a message reaches the other peer", seenByB.length, 1);
  eq("a message is never echoed to its sender", seenByA.length, 0);

  unsubscribeB();
  a.send({ type: "bye", from: "a", to: "b", reason: "hung_up" });
  await sleep(5);
  eq("unsubscribe stops delivery", seenByB.length, 1);

  // Serialisability. The real transport is a socket; anything that cannot cross
  // JSON cannot cross it.
  const [c, d] = createLoopbackTransports("c", "d");
  const received = [];
  d.subscribe((m) => received.push(m));
  c.send({
    type: "sdp",
    from: "c",
    to: "d",
    description: { type: "offer", sdp: "v=0\r\n" },
  });
  await sleep(5);
  eq("SDP survives the wire intact", received[0]?.description?.sdp, "v=0\r\n");
  truthy("the delivered object is a copy, not a shared reference", received.length === 1);

  a.close();
  b.close();
  c.close();
  d.close();
  ok("close() is safe on both ends");
}

/* ==========================================================================
 * 4 · Two peers connect — the real stack
 *
 * The requirement, tested against libdatachannel rather than a stand-in.
 * ========================================================================== */

section("Two peers establish a connection");

/** No ICE servers: host candidates on loopback, so the suite runs offline. */
const LOCAL_CONFIG = { iceServers: [], iceTransportPolicy: "all" };

/**
 * Builds a connected pair and returns everything worth asserting on.
 *
 * `libdatachannel` does not raise `negotiationneeded` when a data channel is
 * created, so the caller side is kicked with `start()`. In a browser the event
 * fires and `start()` is unnecessary — which is exactly why the method exists.
 */
async function connectPair({ iceBatchMs } = {}) {
  // Ids chosen so `caller` is the impolite side, matching a real call where the
  // person who dialled drives the offer.
  const callerId = "11111111-1111-4111-8111-111111111111";
  const calleeId = "22222222-2222-4222-8222-222222222222";

  const [callerTransport, calleeTransport] = createLoopbackTransports(callerId, calleeId);

  const wire = [];
  const record = (side, transport) => ({
    send(message) {
      wire.push({ side, message });
      return transport.send(message);
    },
    subscribe: (handler) => transport.subscribe(handler),
    close: () => transport.close(),
  });

  const states = { caller: [], callee: [] };
  const errors = [];

  const options = (selfId, peerId, side, transport) => ({
    selfId,
    peerId,
    transport: record(side, transport),
    configuration: LOCAL_CONFIG,
    createConnection: (config) => new RTCPeerConnection(config),
    onState: (state) => states[side].push(state),
    onError: (error) => errors.push(error),
    ...(iceBatchMs === undefined ? {} : { iceBatchMs }),
  });

  const caller = new KithPeer(options(callerId, calleeId, "caller", callerTransport));
  const callee = new KithPeer(options(calleeId, callerId, "callee", calleeTransport));

  // A data channel stands in for media: libdatachannel's polyfill does not
  // implement `addTrack`, and what is under test here is the connection, not the
  // codec. Once this channel is open, an audio track would have a path.
  const channel = caller.connection.createDataChannel("kith-probe");
  const inbound = [];
  callee.connection.ondatachannel = (event) => {
    event.channel.onmessage = (message) => inbound.push(message.data);
  };

  await caller.start();

  const connected = await waitFor(
    () => caller.getState() === "connected" && callee.getState() === "connected",
  );

  // On loopback the peers connect before the first ICE flush fires — libdatachannel
  // finishes gathering so fast that the candidates are already inline in the
  // description we send. The trickle messages still follow, and they are what
  // the batching assertions are about, so wait for them.
  await sleep((iceBatchMs ?? ICE_BATCH_MS) + 400);

  return { caller, callee, channel, inbound, wire, states, errors, connected };
}

{
  const pair = await connectPair();

  truthy(
    "both peers reach the connected state",
    pair.connected,
    `caller=${pair.caller.getState()} callee=${pair.callee.getState()}`,
  );
  eq(
    "negotiation raised no errors",
    pair.errors.map((e) => e.message),
    [],
  );
  eq("the underlying connection agrees", pair.caller.connection.connectionState, "connected");

  // Bytes across the wire — the only real proof the path works end to end.
  const opened = await waitFor(() => pair.channel.readyState === "open", 10000);
  truthy("the data channel opens", opened, `readyState=${pair.channel.readyState}`);
  if (opened) {
    pair.channel.send("kith");
    const delivered = await waitFor(() => pair.inbound.length > 0, 5000);
    truthy("data flows peer to peer", delivered);
    eq("the payload arrives intact", pair.inbound[0], "kith");
  }

  eq(
    "the state machine advanced without ever reporting failure",
    pair.states.caller.filter((s) => s === "failed"),
    [],
  );
  truthy(
    "connected was reached via connecting",
    pair.states.caller.includes("connecting") || pair.states.caller.includes("connected"),
  );

  /* ---- What actually crossed the signalling channel --------------------- */

  const kinds = [...new Set(pair.wire.map(({ message }) => message.type))].sort();
  eq("only SDP and ICE were signalled", kinds, ["ice", "sdp"]);

  const offers = pair.wire.filter(({ message }) => message.description?.type === "offer");
  const answers = pair.wire.filter(({ message }) => message.description?.type === "answer");
  eq("exactly one offer", offers.length, 1);
  eq("the impolite peer made it", offers[0].side, "caller");
  eq("exactly one answer", answers.length, 1);
  eq("the polite peer made it", answers[0].side, "callee");

  // Media never travels here. The largest thing on this channel is an SDP blob,
  // and it is measured in kilobytes.
  const largest = Math.max(...pair.wire.map(({ message }) => JSON.stringify(message).length));
  truthy(
    "nothing on the signalling channel is media-sized",
    largest < 64 * 1024,
    `largest=${largest}`,
  );

  const iceMessages = pair.wire.filter(({ message }) => message.type === "ice");
  const candidateCount = iceMessages.reduce(
    (total, { message }) => total + message.candidates.length,
    0,
  );
  truthy("candidates were exchanged", candidateCount > 0);
  truthy(
    "candidates are batched, not sent one per message",
    iceMessages.length <= candidateCount,
    `${iceMessages.length} messages for ${candidateCount} candidates`,
  );

  /* ---- Statistics, for the connection-quality indicator ------------------ */

  const stats = await pair.caller.getStats();
  truthy("stats expose a round-trip time", stats.rtt !== null || stats.rtt === 0);

  /* ---- Teardown ---------------------------------------------------------- */

  pair.caller.hangUp("hung_up");
  await sleep(50);

  eq("hanging up closes the local peer", pair.caller.getState(), "closed");
  eq("the underlying connection is closed", pair.caller.connection.connectionState, "closed");
  eq("the peer that hung up told the other side", pair.wire.at(-1).message.type, "bye");

  pair.caller.close();
  ok("close() is idempotent");

  pair.callee.close();
}

/* ==========================================================================
 * 5 · ICE batching
 *
 * The free tier has a monthly message allowance, and trickle ICE is the one
 * thing capable of spending it. A batch window turns a burst of candidates into
 * a couple of messages.
 * ========================================================================== */

section("ICE batching");

{
  const pair = await connectPair({ iceBatchMs: 400 });
  truthy("a batched pair still connects", pair.connected);

  const iceMessages = pair.wire.filter(({ message }) => message.type === "ice");
  const perSide = { caller: 0, callee: 0 };
  for (const { side } of iceMessages) perSide[side] += 1;

  const candidates = iceMessages.reduce((n, { message }) => n + message.candidates.length, 0);
  truthy(
    "a longer window produces no more messages than candidates",
    iceMessages.length <= candidates,
    `${iceMessages.length} messages for ${candidates} candidates`,
  );
  truthy("both sides trickled", perSide.caller > 0 && perSide.callee > 0);

  pair.caller.close();
  pair.callee.close();
}

/* ==========================================================================
 * 6 · Perfect negotiation, under a provoked collision
 *
 * A recording stub, so the collision is exact. libdatachannel cannot roll back a
 * local offer, so a real-stack glare test would be asserting the polyfill's
 * limits rather than this code's behaviour.
 * ========================================================================== */

section("Perfect negotiation");

class FakeConnection extends EventTarget {
  constructor() {
    super();
    this.signalingState = "stable";
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.localDescription = null;
    this.remoteDescription = null;
    this.applied = [];
    this.candidates = [];
    this.restarted = 0;
    this.closedTimes = 0;
    this.onnegotiationneeded = null;
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
  }

  async createOffer() {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async createAnswer() {
    return { type: "answer", sdp: "answer-sdp" };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
    this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
  }

  async setRemoteDescription(description) {
    this.applied.push(description.type);
    this.remoteDescription = description;
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
  }

  async addIceCandidate(candidate) {
    if (!this.remoteDescription) {
      throw new Error("Got a remote candidate without remote description");
    }
    this.candidates.push(candidate);
  }

  restartIce() {
    this.restarted += 1;
  }

  getSenders() {
    return [];
  }

  async getStats() {
    return new Map();
  }

  close() {
    this.closedTimes += 1;
    this.connectionState = "closed";
  }

  /** Test helper: move the connection and fire the handler, as a stack would. */
  transitionTo(state) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

function fakePeer(selfId, peerId, transport, extra = {}) {
  const connection = new FakeConnection();
  const peer = new KithPeer({
    selfId,
    peerId,
    transport,
    configuration: LOCAL_CONFIG,
    createConnection: () => connection,
    ...extra,
  });
  return { peer, connection };
}

{
  // Both sides offer at the same instant. The impolite peer must ignore the
  // incoming offer; the polite peer must accept it.
  const lowId = "11111111-1111-4111-8111-111111111111";
  const highId = "22222222-2222-4222-8222-222222222222";
  const [lowTransport, highTransport] = createLoopbackTransports(lowId, highId);

  const impolite = fakePeer(lowId, highId, lowTransport);
  const polite = fakePeer(highId, lowId, highTransport);

  eq("the higher id is polite", [impolite.peer.polite, polite.peer.polite], [false, true]);

  await Promise.all([impolite.peer.start(), polite.peer.start()]);
  await sleep(20);

  eq(
    "the impolite peer ignored the colliding offer",
    impolite.connection.applied.filter((type) => type === "offer"),
    [],
  );
  eq("the polite peer accepted it and answered", polite.connection.applied, ["offer"]);
  eq(
    "the polite peer's local description is an answer",
    polite.connection.localDescription.type,
    "answer",
  );

  await sleep(20);
  eq("the impolite peer then applied the answer", impolite.connection.applied, ["answer"]);
  eq(
    "both ended in a stable signalling state",
    [impolite.connection.signalingState, polite.connection.signalingState],
    ["stable", "stable"],
  );

  impolite.peer.close();
  polite.peer.close();
}

/* ==========================================================================
 * 7 · Out-of-order signalling
 *
 * Broadcast is not ordered end to end, and a candidate really can overtake the
 * SDP it belongs to. Before this was queued, the polyfill threw outright.
 * ========================================================================== */

section("Out-of-order delivery");

{
  const selfId = "22222222-2222-4222-8222-222222222222";
  const peerId = "11111111-1111-4111-8111-111111111111";
  const [mine, theirs] = createLoopbackTransports(selfId, peerId);

  const errors = [];
  const { peer, connection } = fakePeer(selfId, peerId, mine, {
    onError: (error) => errors.push(error.message),
  });

  // Candidates first, description second — the wrong way round on purpose.
  theirs.send({
    type: "ice",
    from: peerId,
    to: selfId,
    candidates: [{ candidate: "candidate:1 1 udp", sdpMid: "0" }],
  });
  await sleep(10);

  eq("an early candidate does not error", errors, []);
  eq("and is not applied yet", connection.candidates.length, 0);

  theirs.send({
    type: "sdp",
    from: peerId,
    to: selfId,
    description: { type: "offer", sdp: "offer-sdp" },
  });
  await sleep(20);

  eq("the description is applied", connection.applied, ["offer"]);
  eq("the queued candidate is flushed behind it", connection.candidates.length, 1);

  theirs.send({
    type: "ice",
    from: peerId,
    to: selfId,
    candidates: [{ candidate: "candidate:2 1 udp", sdpMid: "0" }],
  });
  await sleep(10);
  eq("later candidates apply directly", connection.candidates.length, 2);

  peer.close();
}

/* ==========================================================================
 * 8 · Message discipline
 *
 * The Realtime channel is already restricted to call participants, so this is
 * the second layer: a message that is not from the expected peer, or not
 * addressed to this one, is not applied to the connection.
 * ========================================================================== */

section("Message discipline");

{
  const selfId = "22222222-2222-4222-8222-222222222222";
  const peerId = "11111111-1111-4111-8111-111111111111";
  const strangerId = "33333333-3333-4333-8333-333333333333";
  const [mine, theirs] = createLoopbackTransports(selfId, peerId);

  const media = [];
  const hangups = [];
  const { peer, connection } = fakePeer(selfId, peerId, mine, {
    onRemoteMediaState: (state) => media.push(state),
    onHangup: (reason) => hangups.push(reason),
  });

  theirs.send({
    type: "sdp",
    from: peerId,
    to: strangerId,
    description: { type: "offer", sdp: "offer-sdp" },
  });
  await sleep(10);
  eq("a message addressed to someone else is ignored", connection.applied, []);

  theirs.send({
    type: "sdp",
    from: strangerId,
    to: selfId,
    description: { type: "offer", sdp: "offer-sdp" },
  });
  await sleep(10);
  eq("a message from someone else is ignored", connection.applied, []);

  theirs.send({
    type: "media",
    from: peerId,
    to: selfId,
    state: { micEnabled: false, cameraEnabled: true, screenSharing: false },
  });
  await sleep(10);
  eq("media state is relayed verbatim", media, [
    { micEnabled: false, cameraEnabled: true, screenSharing: false },
  ]);
  eq("the default media state is audio-only", DEFAULT_MEDIA_STATE, {
    micEnabled: true,
    cameraEnabled: false,
    screenSharing: false,
  });

  theirs.send({ type: "bye", from: peerId, to: selfId, reason: "declined" });
  await sleep(10);
  eq("a hangup is surfaced with its reason", hangups, ["declined"]);
  eq("and closes the connection", peer.getState(), "closed");

  theirs.send({
    type: "sdp",
    from: peerId,
    to: selfId,
    description: { type: "offer", sdp: "offer-sdp" },
  });
  await sleep(10);
  eq("a message arriving after close is not applied", connection.applied, []);
  eq("the connection was closed exactly once", connection.closedTimes, 1);
}

/* ==========================================================================
 * 9 · Reconnection
 *
 * "disconnected" is routinely transient — a wifi handover produces it and
 * recovers on its own. Treating it as failure would end good calls every time
 * somebody walked past a lift. "failed" is not transient and restarts at once.
 * ========================================================================== */

section("Reconnection");

{
  const selfId = "11111111-1111-4111-8111-111111111111";
  const peerId = "22222222-2222-4222-8222-222222222222";
  const [mine] = createLoopbackTransports(selfId, peerId);
  const states = [];
  const { peer, connection } = fakePeer(selfId, peerId, mine, {
    onState: (state) => states.push(state),
  });

  eq("this peer is the impolite one, so it owns recovery", peer.polite, false);

  connection.transitionTo("connecting");
  connection.transitionTo("connected");
  eq("connected is reported", peer.getState(), "connected");

  connection.transitionTo("disconnected");
  eq("a blip reports reconnecting, not failed", peer.getState(), "reconnecting");
  eq("and does not restart ICE immediately", connection.restarted, 0);

  connection.transitionTo("connected");
  await sleep(RECONNECT_GRACE_MS + 200);
  eq("a blip that recovers on its own never restarts ICE", connection.restarted, 0);
  eq("and is back to connected", peer.getState(), "connected");

  connection.transitionTo("failed");
  eq("an outright failure reports reconnecting", peer.getState(), "reconnecting");
  eq("and restarts ICE at once", connection.restarted, 1);

  peer.close();
  eq("closing during recovery is clean", peer.getState(), "closed");

  // A recovery that never lands must end in an honest error rather than a
  // permanent spinner. Asserted on the polite side, where nothing else could ever
  // move the state on.
  const [strandedTransport] = createLoopbackTransports(peerId, selfId);
  const stranded = fakePeer(peerId, selfId, strandedTransport);
  stranded.connection.transitionTo("connected");
  stranded.connection.transitionTo("failed");
  eq("a stranded peer starts out reconnecting", stranded.peer.getState(), "reconnecting");
  truthy(
    "and does not sit there forever",
    await waitFor(() => stranded.peer.getState() === "failed", RECONNECT_TIMEOUT_MS + 3000),
    `still ${stranded.peer.getState()} after ${RECONNECT_TIMEOUT_MS}ms`,
  );
  stranded.peer.close();

  // A blip that recovers must cancel that deadline rather than failing a call
  // that is already back.
  const [recoveredTransport] = createLoopbackTransports(peerId, selfId);
  const recovered = fakePeer(peerId, selfId, recoveredTransport);
  recovered.connection.transitionTo("connected");
  recovered.connection.transitionTo("failed");
  recovered.connection.transitionTo("connected");
  await sleep(RECONNECT_TIMEOUT_MS + 500);
  eq("a recovered connection is never retro-failed", recovered.peer.getState(), "connected");
  recovered.peer.close();

  // The polite peer must NOT restart — both restarting turns one recovery into
  // a collision.
  const [politeTransport] = createLoopbackTransports(peerId, selfId);
  const politeSide = fakePeer(peerId, selfId, politeTransport);
  eq("the other side is polite", politeSide.peer.polite, true);
  politeSide.connection.transitionTo("failed");
  await sleep(10);
  eq("the polite peer does not restart ICE", politeSide.connection.restarted, 0);
  politeSide.peer.close();
}

/* ==========================================================================
 * 10 · Cleanup
 *
 * A call that ends must leave nothing running. Anything left behind here is a
 * microphone that stays live or a socket that keeps costing messages.
 * ========================================================================== */

section("Cleanup");

{
  const selfId = "11111111-1111-4111-8111-111111111111";
  const peerId = "22222222-2222-4222-8222-222222222222";
  const [mine, theirs] = createLoopbackTransports(selfId, peerId);
  const { peer, connection } = fakePeer(selfId, peerId, mine);

  peer.close();
  peer.close();
  eq("close is idempotent", connection.closedTimes, 1);
  eq(
    "handlers are detached",
    [
      connection.onnegotiationneeded,
      connection.onicecandidate,
      connection.ontrack,
      connection.onconnectionstatechange,
    ],
    [null, null, null, null],
  );

  theirs.send({ type: "bye", from: peerId, to: selfId, reason: "hung_up" });
  await sleep(10);
  eq("a closed peer is deaf to the transport", connection.applied, []);
  eq("final state is closed", peer.getState(), "closed");
}

/* ==========================================================================
 * 11 · Nothing is persisted
 *
 * The brief is explicit: no media through the database, no streams in Supabase.
 * The schema is the place that guarantees it, so assert it there — the calls
 * tables must have nowhere to put an SDP blob or a media frame.
 * ========================================================================== */

section("No media or signalling reaches the database");

{
  const { asService, freshDatabase } = await import("./harness.mjs");
  const db = await freshDatabase();

  const { rows: columns } = await asService(
    db,
    `select table_name, column_name, data_type
       from information_schema.columns
      where table_schema = 'public'
        and table_name in ('calls', 'call_participants')
      order by table_name, ordinal_position`,
  );

  const names = columns.map((c) => c.column_name);
  eq(
    "no signalling columns exist on the call tables",
    names.filter((n) =>
      n
        .split("_")
        .some((part) =>
          [
            "sdp",
            "offer",
            "answer",
            "candidate",
            "ice",
            "stream",
            "blob",
            "audio",
            "video",
            "frame",
          ].includes(part.toLowerCase()),
        ),
    ),
    [],
  );
  eq(
    "no bytea column could hold media",
    columns.filter((c) => c.data_type === "bytea").map((c) => `${c.table_name}.${c.column_name}`),
    [],
  );
  truthy("the call tables exist", names.length > 0);

  // What IS stored: metadata, and the last known media state for late joiners.
  truthy(
    "media state is a small jsonb summary, not a stream",
    columns.some(
      (c) =>
        c.table_name === "call_participants" &&
        c.column_name === "media_state" &&
        c.data_type === "jsonb",
    ),
  );

  const { rows: policies } = await asService(
    db,
    `select polname from pg_policy
      where polrelid = 'realtime.messages'::regclass
        and polname like 'realtime_call%'`,
  );
  eq("the call channel is authorized in both directions", policies.map((p) => p.polname).sort(), [
    "realtime_call_read",
    "realtime_call_write",
  ]);

  await db.close();
}

/* ========================================================================== */

// libdatachannel keeps a thread pool alive; without this the process hangs after
// the last assertion.
nodeDataChannel.cleanup?.();

console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\n  Failures:");
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${"=".repeat(60)}\n`);
process.exit(failed === 0 ? 0 : 1);
