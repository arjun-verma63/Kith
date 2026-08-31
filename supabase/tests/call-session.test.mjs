/**
 * Two sessions, one call, end to end.
 *
 * The brief asks for a test with two browser sessions. There is no browser here,
 * so this is the closest honest equivalent, and in two respects it is stricter:
 *
 *   TWO REAL SESSIONS.  Ada and Rafa are separate authenticated Postgres roles
 *   running against the real migrations. Nothing is stubbed: `start_call`,
 *   `answer_call` and `end_call` are the same functions the app calls, and Row
 *   Level Security applies to both users exactly as it would in a browser.
 *
 *   TWO REAL PEERS.  The audio path is `libdatachannel` — real ICE, real DTLS,
 *   real SCTP — driven by the same `KithPeer` the browser uses. When this says
 *   the call connected, two peer connections really connected and really carried
 *   bytes between them.
 *
 * What it cannot cover is the browser itself: `getUserMedia`, autoplay policy,
 * and whether the ring is audible. Those need hands and a pair of speakers, and
 * docs/CALLS.md says how to check them.
 *
 * It also covers the thing no earlier suite did: whether the `call:{id}` channel
 * policies actually work. Every previous test asserted those policies existed.
 * Existence is not behaviour — a policy naming the wrong helper still exists —
 * and this is the channel a call's signalling travels on.
 *
 *     npm run call-session:test
 */

import { asService, asUser, asUserOnTopic, createUser, freshDatabase } from "./harness.mjs";

const { RTCPeerConnection } = await import("node-datachannel/polyfill");
const nodeDataChannel = await import("node-datachannel");

const { KithPeer } = await import("../../src/lib/webrtc/peer.ts");
const { createLoopbackTransports } = await import("../../src/lib/webrtc/signaling.ts");
const { RING_TIMEOUT_MS } = await import("../../src/features/calls/constants.ts");

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

async function waitFor(predicate, timeoutMs = 15000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

console.log("KITH — a call between two sessions\n");

const db = await freshDatabase();

const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");
const nour = await createUser(db, "nour");

await asService(db, "insert into public.friendships (user_low, user_high) values ($1, $2)", [
  ada < rafa ? ada : rafa,
  ada < rafa ? rafa : ada,
]);

const { rows: dmRows } = await asUser(db, ada, "select public.start_dm($1) as id", [rafa]);
const dm = dmRows[0].id;

/* ==========================================================================
 * 1 · Ada rings Rafa
 * ========================================================================== */

section("Ada calls Rafa");

const { rows: started } = await asUser(db, ada, "select public.start_call($1) as id", [dm]);
const callId = started[0].id;
truthy("the call is placed", Boolean(callId));

{
  // What Ada's own browser sees.
  const { rows } = await asUser(db, ada, "select * from public.get_active_call()");
  eq("Ada has an outgoing call", rows[0].is_initiator, true);
  eq("ringing", rows[0].status, "ringing");
  eq("to Rafa", rows[0].other_user_id, rafa);

  // What Rafa's browser is handed by the broadcast, before any fetch.
  const { rows: delivered } = await asService(
    db,
    `select payload from realtime.sent
      where event = 'call.incoming' and topic = $1
      order by id desc limit 1`,
    [`user:${rafa}`],
  );
  truthy("Rafa's personal channel receives the ring", delivered.length === 1);

  const payload = delivered[0].payload;
  eq("the payload names the call", payload.id, callId);
  eq("and who is calling", payload.initiator_id, ada);
  eq(
    "with a display name, so the ring is not anonymous while a fetch resolves",
    payload.initiator_display_name,
    "ada",
  );
  eq("and no signalling of any kind", Object.keys(payload).includes("sdp"), false);

  const { rows: toAda } = await asService(
    db,
    `select count(*)::int as n from realtime.sent
      where event = 'call.incoming' and topic = $1`,
    [`user:${ada}`],
  );
  eq("the caller is told too, so a second tab can follow along", toAda[0].n, 1);
}

/* ==========================================================================
 * 2 · The signalling channel is not open to bystanders
 *
 * The first test in this codebase to actually evaluate migration 0009's channel
 * policies rather than assert they exist.
 * ========================================================================== */

section("Channel authorization");

{
  const topic = `call:${callId}`;
  await asService(
    db,
    "insert into realtime.messages (topic, extension, payload) values ($1, 'broadcast', '{}'::jsonb)",
    [topic],
  );

  const seen = async (who) => {
    const { rows } = await asUserOnTopic(
      db,
      who,
      topic,
      "select count(*)::int as n from realtime.messages",
    );
    return rows[0].n;
  };

  eq("the caller may subscribe to the call channel", await seen(ada), 1);
  eq("so may the person being rung", await seen(rafa), 1);
  eq("a bystander may not — this is the signalling stream", await seen(nour), 0);

  const broadcast = async (who) => {
    try {
      await asUserOnTopic(
        db,
        who,
        topic,
        "insert into realtime.messages (topic, extension, payload) values ($1, 'broadcast', '{}'::jsonb)",
        [topic],
      );
      return true;
    } catch {
      return false;
    }
  };

  eq("a participant may broadcast into it", await broadcast(rafa), true);
  eq("a bystander may not", await broadcast(nour), false);

  // And the personal bus stays personal.
  const personal = async (who, owner) => {
    const { rows } = await asUserOnTopic(
      db,
      who,
      `user:${owner}`,
      "select count(*)::int as n from realtime.messages where topic = $1",
      [`user:${owner}`],
    );
    return rows[0].n;
  };

  await asService(
    db,
    "insert into realtime.messages (topic, extension, payload) values ($1, 'broadcast', '{}'::jsonb)",
    [`user:${rafa}`],
  );

  truthy("Rafa can read his own channel", (await personal(rafa, rafa)) === 1);
  eq("Ada cannot read Rafa's", await personal(ada, rafa), 0);
}

/* ==========================================================================
 * 3 · Rafa answers, and the two browsers connect
 * ========================================================================== */

section("Answering and connecting");

await asUser(db, rafa, "select public.answer_call($1)", [callId]);

{
  const { rows } = await asService(
    db,
    "select status, answered_at from public.calls where id = $1",
    [callId],
  );
  eq("the call is active", rows[0].status, "active");
  truthy("and stamped", rows[0].answered_at !== null);

  const { rows: sent } = await asService(
    db,
    `select topic from realtime.sent where event = 'call.updated' order by id desc limit 2`,
  );
  eq(
    "both sides are told, on their own channels",
    sent.map((s) => s.topic).sort(),
    [`user:${ada}`, `user:${rafa}`].sort(),
  );
}

/*
 * Now the part a database cannot answer.
 *
 * Two `KithPeer` instances, one per session, wired through a transport pair
 * standing in for the `call:{id}` broadcast channel that section 2 just proved is
 * private. No ICE servers, so this connects over host candidates on loopback and
 * needs no network.
 */
const [adaTransport, rafaTransport] = createLoopbackTransports(ada, rafa);
const LOCAL_CONFIG = { iceServers: [], iceTransportPolicy: "all" };

const wire = [];
const record = (side, transport) => ({
  send(message) {
    wire.push({ side, message });
    return transport.send(message);
  },
  subscribe: (handler) => transport.subscribe(handler),
  close: () => transport.close(),
});

const remoteMedia = { ada: null, rafa: null };
const errors = [];

const adaPeer = new KithPeer({
  selfId: ada,
  peerId: rafa,
  transport: record("ada", adaTransport),
  configuration: LOCAL_CONFIG,
  createConnection: (config) => new RTCPeerConnection(config),
  onRemoteMediaState: (state) => (remoteMedia.ada = state),
  onError: (error) => errors.push(`ada: ${error.message}`),
});

const rafaPeer = new KithPeer({
  selfId: rafa,
  peerId: ada,
  transport: record("rafa", rafaTransport),
  configuration: LOCAL_CONFIG,
  createConnection: (config) => new RTCPeerConnection(config),
  onRemoteMediaState: (state) => (remoteMedia.rafa = state),
  onError: (error) => errors.push(`rafa: ${error.message}`),
});

// A data channel stands in for the microphone track: libdatachannel's polyfill
// does not implement `addTrack`, and what is under test here is whether the two
// sessions establish a media path at all.
const probe = adaPeer.connection.createDataChannel("kith-audio");
const heard = [];
rafaPeer.connection.ondatachannel = (event) => {
  event.channel.onmessage = (message) => heard.push(message.data);
};

await adaPeer.start();

{
  const connected = await waitFor(
    () => adaPeer.getState() === "connected" && rafaPeer.getState() === "connected",
  );
  truthy(
    "both sessions reach a connected peer connection",
    connected,
    `ada=${adaPeer.getState()} rafa=${rafaPeer.getState()}`,
  );
  eq("with no negotiation errors", errors, []);

  const open = await waitFor(() => probe.readyState === "open", 10000);
  truthy("the media path opens", open, `readyState=${probe.readyState}`);

  if (open) {
    probe.send("hello");
    truthy(
      "and carries data between the two sessions",
      await waitFor(() => heard.length > 0, 5000),
    );
    eq("intact", heard[0], "hello");
  }
}

/* ==========================================================================
 * 4 · Mute
 * ========================================================================== */

section("Mute");

{
  adaPeer.sendMediaState({ micEnabled: false, cameraEnabled: false, screenSharing: false });
  await waitFor(() => remoteMedia.rafa !== null, 3000);

  eq("Rafa is told Ada muted", remoteMedia.rafa?.micEnabled, false);
  eq(
    "and that no camera is involved — this is a voice call",
    remoteMedia.rafa?.cameraEnabled,
    false,
  );

  await asUser(db, ada, "select public.set_call_media_state($1, $2::jsonb)", [
    callId,
    JSON.stringify({ micEnabled: false }),
  ]);

  const { rows } = await asService(
    db,
    "select media_state from public.call_participants where call_id = $1 and user_id = $2",
    [callId, ada],
  );
  eq("and it is recorded for anybody joining late", rows[0].media_state, { micEnabled: false });

  const { rows: theirs } = await asService(
    db,
    "select media_state from public.call_participants where call_id = $1 and user_id = $2",
    [callId, rafa],
  );
  eq("without touching the other participant's", theirs[0].media_state, {});
}

/* ==========================================================================
 * 4b · Screen sharing, between the two sessions
 *
 * The screen itself cannot be captured in Node, so what is checked here is the
 * half that has to be right for the far end to render anything: the announcement
 * travelling over real signalling, and the record kept for a late joiner.
 * `screen-share.test.mjs` drives the capture side against a fake browser.
 * ========================================================================== */

section("Screen sharing");

{
  adaPeer.sendMediaState({ micEnabled: false, cameraEnabled: false, screenSharing: true });
  await waitFor(() => remoteMedia.rafa?.screenSharing === true, 3000);

  eq("Rafa is told Ada started sharing", remoteMedia.rafa?.screenSharing, true);
  eq("without disturbing what he knows about her microphone", remoteMedia.rafa?.micEnabled, false);
  eq("and no camera is claimed", remoteMedia.rafa?.cameraEnabled, false);

  await asUser(db, ada, "select public.set_call_media_state($1, $2::jsonb)", [
    callId,
    JSON.stringify({ micEnabled: false, cameraEnabled: false, screenSharing: true }),
  ]);

  const { rows } = await asService(
    db,
    "select media_state from public.call_participants where call_id = $1 and user_id = $2",
    [callId, ada],
  );
  eq("the whole state is recorded, not a patch", rows[0].media_state, {
    micEnabled: false,
    cameraEnabled: false,
    screenSharing: true,
  });

  // The other direction, so the flag is not accidentally one-way.
  rafaPeer.sendMediaState({ micEnabled: true, cameraEnabled: false, screenSharing: true });
  await waitFor(() => remoteMedia.ada?.screenSharing === true, 3000);
  eq("and it travels the other way too", remoteMedia.ada?.screenSharing, true);

  adaPeer.sendMediaState({ micEnabled: false, cameraEnabled: false, screenSharing: false });
  await waitFor(() => remoteMedia.rafa?.screenSharing === false, 3000);
  eq("stopping is announced as well", remoteMedia.rafa?.screenSharing, false);

  const { rows: sent } = await asService(
    db,
    "select count(*)::int as n from realtime.sent where payload::text like '%screenSharing%'",
  );
  eq("and none of this touched the database's broadcast log", sent[0].n, 0);
}

/* ==========================================================================
 * 5 · Nothing about the audio is stored
 * ========================================================================== */

section("What reached the database");

{
  // Candidates flush on a 200ms batch timer, and on loopback the peers connect
  // before the first flush fires — libdatachannel finishes gathering fast enough
  // that they are already inline in the description. The trickle messages follow.
  await sleep(700);

  const kinds = [...new Set(wire.map(({ message }) => message.type))].sort();
  truthy("SDP and ICE crossed the signalling wire", kinds.includes("sdp") && kinds.includes("ice"));

  const { rows } = await asService(
    db,
    `select count(*)::int as n from realtime.sent
      where topic = $1 or payload::text like '%v=0%' or payload::text like '%candidate:%'`,
    [`call:${callId}`],
  );
  eq("and none of it was written to the database", rows[0].n, 0);

  const { rows: stored } = await asService(
    db,
    "select row_to_json(c)::text as json from public.calls c where c.id = $1",
    [callId],
  );
  eq(
    "the call row holds no session description",
    /v=0|candidate:|m=audio/.test(stored[0].json),
    false,
  );
}

/* ==========================================================================
 * 6 · Ada hangs up
 * ========================================================================== */

section("Hanging up");

{
  adaPeer.hangUp("hung_up");
  await asUser(db, ada, "select public.end_call($1, 'hung_up')", [callId]);

  eq("the caller's connection closes", adaPeer.getState(), "closed");
  truthy(
    "and the other session is told over the signalling channel",
    await waitFor(() => rafaPeer.getState() === "closed", 3000),
    `rafa=${rafaPeer.getState()}`,
  );

  const { rows } = await asService(
    db,
    "select status, end_reason, ended_at from public.calls where id = $1",
    [callId],
  );
  eq("the call is ended", rows[0].status, "ended");
  eq("with reason hung_up", rows[0].end_reason, "hung_up");

  const { rows: live } = await asUser(db, rafa, "select * from public.get_active_call()");
  eq("neither session is on a call any more", live.length, 0);

  const { rows: mine } = await asUser(db, ada, "select * from public.get_active_call()");
  eq("on either side", mine.length, 0);
}

/* ==========================================================================
 * 7 · It shows up in both histories
 * ========================================================================== */

section("History");

{
  const { rows: adaLog } = await asUser(db, ada, "select * from public.list_calls(10, null)");
  const { rows: rafaLog } = await asUser(db, rafa, "select * from public.list_calls(10, null)");

  eq("Ada has one call", adaLog.length, 1);
  eq("Rafa has the same call", rafaLog[0].id, adaLog[0].id);
  eq("outgoing for Ada", adaLog[0].is_initiator, true);
  eq("incoming for Rafa", rafaLog[0].is_initiator, false);
  eq("Ada's entry names Rafa", adaLog[0].other_user_id, rafa);
  eq("and Rafa's names Ada", rafaLog[0].other_user_id, ada);
  truthy("with a duration", adaLog[0].duration_seconds !== null);
  truthy("that both agree on", adaLog[0].duration_seconds === rafaLog[0].duration_seconds);

  const { rows: nourLog } = await asUser(db, nour, "select * from public.list_calls(10, null)");
  eq("and the bystander's history is empty", nourLog.length, 0);
}

/* ==========================================================================
 * 8 · The two ring timeouts agree
 *
 * The client counts down so a phone stops ringing when the caller gives up; the
 * database sweeps so a ring survives the caller's browser vanishing. Two clocks,
 * one number — and nothing but this test stops them drifting apart.
 * ========================================================================== */

section("Timeout agreement");

{
  const { rows } = await asService(
    db,
    "select extract(epoch from public.ring_timeout())::int as seconds",
  );
  eq("RING_TIMEOUT_MS matches public.ring_timeout()", RING_TIMEOUT_MS, rows[0].seconds * 1000);
}

await db.close();

/* ========================================================================== */

nodeDataChannel.cleanup?.();

console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\n  Failures:");
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${"=".repeat(60)}\n`);
process.exit(failed === 0 ? 0 : 1);
