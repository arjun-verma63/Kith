/**
 * Settings.
 *
 * ── The rule this file exists to enforce ─────────────────────────────────────
 *
 * EVERY CONTROL DOES SOMETHING. A settings page whose switches are decorative is
 * worse than no settings page, because it makes a promise the app does not keep.
 *
 * `user_settings` had nine columns and four of them were read by anything.
 * `notification_prefs` was `{}` for everybody and consulted by nobody; `theme`
 * lived in localStorage instead; `motion` was a comment in `tokens.css` saying
 * the setting was coming in a later phase. So most of this suite is the same
 * question asked of each group: set it, then check the thing it claims to
 * control actually changed.
 *
 * §2 is the invariant that generalises it — every entry in `PRIVACY_CONTROLS`
 * names the function that honours it, and each name is looked up in `pg_proc`.
 * A control cannot ship pointing at a function that does not exist.
 *
 *     npm run settings:test
 */

import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { asService, asUser, createUser, freshDatabase } from "./harness.mjs";

register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

const {
  appearanceSchema,
  MOTION_OPTIONS,
  MOTION_PREFERENCES,
  NOTIFICATION_KINDS,
  NOTIFICATION_LABELS,
  notificationSchema,
  PRIVACY_CONTROLS,
  privacySchema,
  readNotificationPrefs,
  resolveTheme,
  THEME_OPTIONS,
  THEME_PREFERENCES,
} = await import("../../src/features/settings/preferences.ts");

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
const falsy = (n, v, d = "expected a falsy value") => (v ? bad(n, d) : ok(n));
const section = (t) => console.log(`\n${t}`);

async function denied(name, promise) {
  try {
    const result = await promise;
    if (result?.rows?.length === 0 || result?.affectedRows === 0) {
      ok(`${name} (no rows)`);
      return;
    }
    bad(name, `expected a refusal, got ${JSON.stringify(result?.rows ?? result)}`);
  } catch (error) {
    ok(`${name} (${error.message.split("\n")[0].slice(0, 55)})`);
  }
}

console.log("KITH — settings\n");

/* ==========================================================================
 * 1 · The vocabularies
 * ========================================================================== */

section("Shapes");

{
  truthy(
    "a full privacy submission parses",
    privacySchema.safeParse({
      discoverable: true,
      whoCanMessage: "friends",
      whoCanCall: "nobody",
      whoCanPropose: "everyone",
      showBirthday: "friends",
      typingIndicators: false,
    }).success,
  );
  falsy(
    "a scope it does not know is refused",
    privacySchema.safeParse({
      discoverable: true,
      whoCanMessage: "anyone",
      whoCanCall: "friends",
      whoCanPropose: "friends",
      showBirthday: "friends",
      typingIndicators: true,
    }).success,
  );

  truthy(
    "appearance parses",
    appearanceSchema.safeParse({ theme: "system", motion: "reduced" }).success,
  );
  falsy(
    "and refuses a theme that is not one of the three",
    appearanceSchema.safeParse({ theme: "midnight", motion: "full" }).success,
  );

  eq("three themes", [...THEME_PREFERENCES], ["dusk", "daylight", "system"]);
  eq("three motion tiers", [...MOTION_PREFERENCES], ["full", "reduced", "off"]);
  eq(
    "every theme has copy",
    THEME_OPTIONS.map((o) => o.key),
    [...THEME_PREFERENCES],
  );
  eq(
    "and every motion tier",
    MOTION_OPTIONS.map((o) => o.key),
    [...MOTION_PREFERENCES],
  );

  /*
   * The one line of copy that is a promise about behaviour: `full` does not
   * override a system-level reduced-motion preference. If the option said
   * otherwise it would be lying, because the CSS gives the media query the last
   * word on purpose.
   */
  const full = MOTION_OPTIONS.find((o) => o.key === "full");
  truthy("and 'full' admits the system preference wins", /device|system/i.test(full.help));
}

{
  eq("seven notification kinds are offered", NOTIFICATION_KINDS.length, 7);
  eq(
    "each with copy",
    NOTIFICATION_LABELS.map((n) => n.key).sort(),
    [...NOTIFICATION_KINDS].sort(),
  );

  // `system` is in the database enum and must never be offered — it is how the
  // app says something that is not about another person.
  falsy("system is not switchable", NOTIFICATION_KINDS.includes("system"));

  truthy(
    "all seven parse",
    notificationSchema.safeParse(Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, true])))
      .success,
  );
}

{
  /*
   * Absent means on. The column is `{}` for everybody who has never opened the
   * page, so a missing key that meant "off" would have shipped this feature by
   * silently muting every notification in the app.
   */
  const empty = readNotificationPrefs({});
  eq("an empty object is everything on", Object.values(empty).filter(Boolean).length, 7);
  eq("null too", readNotificationPrefs(null).message, true);
  eq("and nonsense", readNotificationPrefs("what").message, true);

  eq("an explicit false is off", readNotificationPrefs({ message: false }).message, false);
  eq("and does not touch the others", readNotificationPrefs({ message: false }).game_invite, true);
  eq("an explicit true is on", readNotificationPrefs({ message: true }).message, true);
  // Only the boolean false suppresses; a stray value is not an instruction.
  eq("a string 'false' is not a false", readNotificationPrefs({ message: "false" }).message, true);
}

{
  eq("dusk resolves to dusk", resolveTheme("dusk", true), "dusk");
  eq("daylight to daylight", resolveTheme("daylight", true), "daylight");
  eq("system follows a dark device", resolveTheme("system", true), "dusk");
  eq("and a light one", resolveTheme("system", false), "daylight");
}

/* ==========================================================================
 * 2 · Every privacy control names something that exists
 * ========================================================================== */

section("Controls are real");

const db = await freshDatabase();

{
  const missing = [];

  for (const control of PRIVACY_CONTROLS) {
    const { rows } = await asService(
      db,
      `select 1 from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`,
      [control.enforcedBy],
    );
    if (rows.length === 0) missing.push(`${control.key} -> ${control.enforcedBy}()`);
  }

  eq("every privacy control names a function that exists", missing, []);
  eq("and there are five of them", PRIVACY_CONTROLS.length, 5);
}

const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");
const nour = await createUser(db, "nour");

const pair = (a, b) => [a < b ? a : b, a < b ? b : a];
await asService(
  db,
  "insert into public.friendships (user_low, user_high) values ($1,$2)",
  pair(ada, rafa),
);

await asService(db, "update public.profiles set birthday = '1994-03-11' where id = $1", [ada]);

/* ==========================================================================
 * 3 · Birthday visibility
 * ========================================================================== */

section("Birthday visibility");

const birthdaySeenBy = async (viewer) => {
  const { rows } = await asUser(db, viewer, "select birthday from public.get_profile('ada')");
  return rows[0]?.birthday ?? null;
};

{
  // Default is 'friends'.
  truthy("a friend sees it by default", (await birthdaySeenBy(rafa)) !== null);
  eq("a stranger does not", await birthdaySeenBy(nour), null);
  truthy("and you always see your own", (await birthdaySeenBy(ada)) !== null);

  await asService(
    db,
    "update public.user_settings set show_birthday = 'nobody' where user_id = $1",
    [ada],
  );
  eq("'nobody' hides it from a friend", await birthdaySeenBy(rafa), null);
  truthy("but not from yourself", (await birthdaySeenBy(ada)) !== null);

  await asService(
    db,
    "update public.user_settings set show_birthday = 'everyone' where user_id = $1",
    [ada],
  );
  truthy("'everyone' shows it to a stranger", (await birthdaySeenBy(nour)) !== null);

  await asService(
    db,
    "update public.user_settings set show_birthday = 'friends' where user_id = $1",
    [ada],
  );

  /*
   * The redaction has to be in SQL, not in the page. This is the assertion that
   * says so: the row still exists with a birthday on it, and the function is
   * what refuses to hand it over.
   */
  const { rows: raw } = await asService(db, "select birthday from public.profiles where id = $1", [
    ada,
  ]);
  truthy("the column still holds the date", raw[0].birthday !== null);
  eq("the function is what withholds it", await birthdaySeenBy(nour), null);
}

{
  // Everything else get_profile carries over from the policy it replaced.
  await asUser(db, nour, "select public.block_user($1)", [ada]);
  const { rows } = await asUser(db, nour, "select * from public.get_profile('ada')");
  eq("a blocked profile does not resolve at all", rows.length, 0);

  const { rows: reverse } = await asUser(db, ada, "select * from public.get_profile('nour')");
  eq("symmetrically", reverse.length, 0);
  await asUser(db, nour, "select public.unblock_user($1)", [ada]);

  const { rows: found } = await asUser(db, rafa, "select username from public.get_profile('ADA')");
  eq("the lookup is case-insensitive", found[0].username, "ada");

  const { rows: missing } = await asUser(db, rafa, "select * from public.get_profile('nobody')");
  eq("an unknown name is nothing, not an error", missing.length, 0);

  await denied("and it needs a session", asService(db, "select * from public.get_profile('ada')"));
}

{
  // A deleted account resolves by id — old messages still render a name — but
  // must not be browsable by username.
  const gone = await createUser(db, "temp");
  await asService(db, "select public.anonymise_account($1)", [gone]);

  const { rows: byName } = await asUser(db, rafa, "select * from public.get_profile('temp')");
  eq("a deleted account does not resolve by name", byName.length, 0);

  const { rows: byId } = await asService(
    db,
    "select display_name from public.profiles where id = $1",
    [gone],
  );
  eq(
    "but the row is still there for a message to point at",
    byId[0].display_name,
    "Deleted account",
  );
}

/* ==========================================================================
 * 4 · Notification preferences actually suppress
 * ========================================================================== */

section("Notifications");

const notificationsFor = async (userId) => {
  const { rows } = await asService(
    db,
    "select kind from public.notifications where user_id = $1 order by created_at",
    [userId],
  );
  return rows.map((r) => r.kind);
};

{
  const { rows } = await asService(db, "select public.notification_enabled($1, 'message') as yes", [
    ada,
  ]);
  eq("everything is on by default", rows[0].yes, true);

  await asService(
    db,
    `update public.user_settings set notification_prefs = '{"message": false}'::jsonb where user_id = $1`,
    [ada],
  );

  const { rows: off } = await asService(
    db,
    "select public.notification_enabled($1, 'message') as yes",
    [ada],
  );
  eq("an explicit false is off", off[0].yes, false);

  const { rows: other } = await asService(
    db,
    "select public.notification_enabled($1, 'game_invite') as yes",
    [ada],
  );
  eq("and does not touch the others", other[0].yes, true);

  /*
   * `system` is never suppressible, whatever is stored. It is how the app says
   * something that is not about another person, and a preference that can
   * silence it is one that hides the message somebody needs to see.
   */
  await asService(
    db,
    `update public.user_settings set notification_prefs = '{"system": false}'::jsonb where user_id = $1`,
    [ada],
  );
  const { rows: system } = await asService(
    db,
    "select public.notification_enabled($1, 'system') as yes",
    [ada],
  );
  eq("system cannot be switched off even when stored as false", system[0].yes, true);
}

{
  // End to end, through the real trigger that fires on a real message.
  await asService(db, "delete from public.notifications");
  await asService(
    db,
    `update public.user_settings set notification_prefs = '{}'::jsonb where user_id = $1`,
    [ada],
  );

  const { rows: conv } = await asUser(db, rafa, "select public.start_dm($1) as id", [ada]);
  const dm = conv[0].id;

  await asService(
    db,
    "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'hello')",
    [dm, rafa],
  );
  eq("a message notifies by default", await notificationsFor(ada), ["message"]);

  await asService(db, "delete from public.notifications");
  await asService(
    db,
    `update public.user_settings set notification_prefs = '{"message": false}'::jsonb where user_id = $1`,
    [ada],
  );

  const { rows: sent } = await asService(
    db,
    "insert into public.messages (conversation_id, sender_id, body) values ($1,$2,'again') returning id",
    [dm, rafa],
  );

  eq("with the preference off, nothing is written", await notificationsFor(ada), []);

  // Dropped, not raised. The action that caused it must still succeed —
  // muting messages does not stop anybody sending one.
  truthy("and the message itself still landed", Boolean(sent[0].id));

  // The gate is per person, not per conversation.
  eq("the sender is unaffected", await notificationsFor(rafa), []);

  await asService(
    db,
    `update public.user_settings set notification_prefs = '{}'::jsonb where user_id = $1`,
    [ada],
  );
}

{
  /*
   * One gate rather than seven. The trigger is on `notifications` itself, so it
   * covers every kind — including any added later, which is the whole reason it
   * is not seven copies of an if statement.
   */
  const { rows } = await asService(
    db,
    `select tgname from pg_trigger
      where tgrelid = 'public.notifications'::regclass and not tgisinternal`,
  );
  truthy(
    "the gate is a trigger on notifications, not a check in each producer",
    rows.some((r) => r.tgname === "notifications_apply_prefs"),
  );

  await asService(db, "delete from public.notifications");
  await asService(
    db,
    `update public.user_settings set notification_prefs = '{"friend_request": false}'::jsonb where user_id = $1`,
    [ada],
  );
  await asUser(
    db,
    nour,
    "insert into public.friend_requests (requester_id, addressee_id) values ($1,$2)",
    [nour, ada],
  );
  eq("a friend request is suppressed by the same gate", await notificationsFor(ada), []);

  await asService(
    db,
    `update public.user_settings set notification_prefs = '{}'::jsonb where user_id = $1`,
    [ada],
  );
}

/* ==========================================================================
 * 5 · Persistence and ownership
 * ========================================================================== */

section("Persistence");

{
  await asUser(
    db,
    ada,
    "update public.user_settings set theme = 'daylight', motion = 'off' where user_id = $1",
    [ada],
  );

  const { rows } = await asUser(db, ada, "select theme, motion from public.user_settings");
  eq("appearance is stored on the account, not the browser", rows[0], {
    theme: "daylight",
    motion: "off",
  });

  // Which is the point of moving it out of localStorage: it is a fact about the
  // person, readable from any device they sign in on.
  const { rows: server } = await asService(
    db,
    "select theme from public.user_settings where user_id = $1",
    [ada],
  );
  eq("and the server can read it back", server[0].theme, "daylight");

  await asUser(db, ada, "update public.user_settings set theme = 'dusk', motion = 'full'");
}

{
  await denied(
    "you cannot read somebody else's settings",
    asUser(db, rafa, "select * from public.user_settings where user_id = $1", [ada]),
  );
  await denied(
    "nor write them",
    asUser(db, rafa, "update public.user_settings set theme = 'daylight' where user_id = $1", [
      ada,
    ]),
  );
  await denied(
    "nor their notification preferences",
    asUser(
      db,
      rafa,
      `update public.user_settings set notification_prefs = '{"message": false}'::jsonb where user_id = $1`,
      [ada],
    ),
  );

  // A settings row cannot be minted or destroyed through the API — it belongs to
  // the signup trigger and the cascade.
  await denied(
    "nor create one",
    asUser(db, rafa, "insert into public.user_settings (user_id) values ($1)", [nour]),
  );
  await denied(
    "nor delete one",
    asUser(db, rafa, "delete from public.user_settings where user_id = $1", [rafa]),
  );

  const { rows } = await asUser(db, rafa, "select user_id from public.user_settings");
  eq("you see exactly one settings row: yours", rows.length, 1);
  eq("and it is yours", rows[0].user_id, rafa);
}

await db.close();

/* ========================================================================== */

console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\n  Failures:");
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${"=".repeat(60)}\n`);
process.exit(failed === 0 ? 0 : 1);
