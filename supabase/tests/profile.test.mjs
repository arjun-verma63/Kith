/**
 * Profile tests.
 *
 * The triggers added in migration 0011 are where this phase's subtle failures
 * live: three BEFORE UPDATE triggers on one table, whose correctness depends on
 * their alphabetical firing order, plus a SECURITY DEFINER function that has to
 * get past one of them. None of that is visible by reading a single file.
 *
 *     npm run profile:test
 */

import { asService, asUser, createUser, freshDatabase } from "./harness.mjs";

const { formatBirthday } = await import("../../src/features/profile/presence.ts");
const { isOwnAvatarPath, parseBirthdayFields } =
  await import("../../src/features/profile/schema.ts");

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
const section = (t) => console.log(`\n${t}`);

console.log("KITH — profiles\n");

/* ========================================================================== */
section("profile formatting");

// Presence derivation moved to lib/presence.ts and is covered by
// supabase/tests/presence.test.mjs. What remains here is profile-specific.

eq("birthday renders day and month, never the year", formatBirthday("1994-03-12"), "12 March");
eq("no birthday renders nothing", formatBirthday(null), null);

/* ========================================================================== */
section("input validation");

eq("all three blank means 'not given'", parseBirthdayFields("", "", ""), { ok: true, value: null });
eq("a partial date is refused", parseBirthdayFields("12", "", "1994"), { ok: false });
eq("31 February is refused", parseBirthdayFields("31", "2", "1994"), { ok: false });
eq("a real date parses", parseBirthdayFields("12", "3", "1994"), {
  ok: true,
  value: { day: 12, month: 3, year: 1994 },
});
eq(
  "a future birthday is refused",
  parseBirthdayFields("1", "1", String(new Date().getUTCFullYear() + 1)),
  { ok: false },
);

const ME = "11111111-1111-1111-1111-111111111111";
const THEM = "22222222-2222-2222-2222-222222222222";
eq("own path accepted", isOwnAvatarPath(`${ME}/a.webp`, ME), true);
eq("another user's folder refused", isOwnAvatarPath(`${THEM}/a.webp`, ME), false);
eq("traversal refused", isOwnAvatarPath(`${ME}/../${THEM}/a.webp`, ME), false);
eq("nested path refused", isOwnAvatarPath(`${ME}/x/a.webp`, ME), false);
eq("absolute path refused", isOwnAvatarPath(`/${ME}/a.webp`, ME), false);
eq("bare filename refused", isOwnAvatarPath("a.webp", ME), false);

/* ========================================================================== */
section("profile triggers (real Postgres)");

const db = await freshDatabase();
const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");

// last_seen_at must be observed, not declared.
const { rows: before } = await asService(
  db,
  "select last_seen_at from public.profiles where id=$1",
  [ada],
);
await asUser(
  db,
  ada,
  "update public.profiles set last_seen_at = now() + interval '10 years' where id = $1",
  [ada],
);
const { rows: after } = await asService(
  db,
  "select last_seen_at from public.profiles where id=$1",
  [ada],
);
eq(
  "a client cannot write its own last_seen_at",
  after[0].last_seen_at.getTime(),
  before[0].last_seen_at.getTime(),
);

await asService(
  db,
  "update public.profiles set last_seen_at = now() - interval '5 minutes' where id=$1",
  [ada],
);
await asUser(db, ada, "select public.touch_last_seen()");
const { rows: touched } = await asService(
  db,
  "select last_seen_at from public.profiles where id=$1",
  [ada],
);
if (Date.now() - touched[0].last_seen_at.getTime() < 5000) {
  ok("touch_last_seen() CAN move it (the bypass flag works)");
} else {
  bad(
    "touch_last_seen() CAN move it (the bypass flag works)",
    touched[0].last_seen_at.toISOString(),
  );
}

const { rows: stale } = await asService(
  db,
  "select last_seen_at from public.profiles where id=$1",
  [ada],
);
await asUser(db, ada, "select public.touch_last_seen()");
const { rows: throttled } = await asService(
  db,
  "select last_seen_at from public.profiles where id=$1",
  [ada],
);
eq(
  "touch_last_seen() throttles: an immediate second call is a no-op",
  throttled[0].last_seen_at.getTime(),
  stale[0].last_seen_at.getTime(),
);

await asUser(db, ada, "update public.profiles set created_at = '2000-01-01' where id=$1", [ada]);
const { rows: created } = await asService(
  db,
  "select created_at from public.profiles where id=$1",
  [ada],
);
if (created[0].created_at.getUTCFullYear() > 2020) ok("created_at cannot be rewritten");
else bad("created_at cannot be rewritten", created[0].created_at.toISOString());

/* --- username cooldown --- */

await asUser(db, ada, "update public.profiles set username = 'adao' where id=$1", [ada]);
const { rows: renamed } = await asService(
  db,
  "select username, username_changed_at from public.profiles where id=$1",
  [ada],
);
eq("first username change is allowed", renamed[0].username, "adao");
if (renamed[0].username_changed_at) ok("the change is stamped");
else bad("the change is stamped", "username_changed_at is null");

try {
  await asUser(db, ada, "update public.profiles set username = 'adao2' where id=$1", [ada]);
  bad("a second change within 30 days is refused", "it was allowed");
} catch (error) {
  if (/username_cooldown/.test(error.message)) ok("a second change within 30 days is refused");
  else bad("a second change within 30 days is refused", error.message);
}

// The bypass a naive implementation would allow, and the reason the pin trigger
// has to run before the cooldown trigger.
try {
  await asUser(
    db,
    ada,
    "update public.profiles set username = 'adao3', username_changed_at = null where id=$1",
    [ada],
  );
  bad("nulling username_changed_at cannot bypass the cooldown", "the bypass worked");
} catch (error) {
  if (/username_cooldown/.test(error.message)) {
    ok("nulling username_changed_at cannot bypass the cooldown");
  } else {
    bad("nulling username_changed_at cannot bypass the cooldown", error.message);
  }
}

try {
  await asUser(db, ada, "update public.profiles set bio = 'hello', accent = 'moss' where id=$1", [
    ada,
  ]);
  ok("other fields remain editable during the cooldown");
} catch (error) {
  bad("other fields remain editable during the cooldown", error.message);
}

try {
  await asUser(db, rafa, "update public.profiles set username = 'ADAO' where id=$1", [rafa]);
  bad("username uniqueness is case-insensitive", "the clash was accepted");
} catch (error) {
  if (/profiles_username_lower_key/.test(error.message))
    ok("username uniqueness is case-insensitive");
  else bad("username uniqueness is case-insensitive", error.message);
}

try {
  await asUser(db, rafa, "update public.profiles set birthday = current_date + 1 where id=$1", [
    rafa,
  ]);
  bad("a future birthday is refused by the database", "it was accepted");
} catch (error) {
  if (/profiles_birthday_plausible/.test(error.message)) {
    ok("a future birthday is refused by the database");
  } else {
    bad("a future birthday is refused by the database", error.message);
  }
}

const upd = await asUser(db, rafa, "update public.profiles set display_name='hacked' where id=$1", [
  ada,
]);
eq("still cannot edit another person's profile", upd.affectedRows ?? 0, 0);

/* ========================================================================== */
section("avatar storage policies");

const { rows: bucket } = await asService(
  db,
  "select public, file_size_limit from storage.buckets where id='avatars'",
);
eq("the avatars bucket exists and is PRIVATE", bucket[0]?.public, false);
eq("a size limit is enforced by Storage itself", Number(bucket[0]?.file_size_limit), 2097152);

// pg_policy.polcmd: r=select, a=insert, w=update, d=delete.
const { rows: policies } = await asService(
  db,
  `select polcmd from pg_policy p
     join pg_class c on c.oid = p.polrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='storage' and c.relname='objects'`,
);
eq(
  "one policy per operation (select, insert, update, delete)",
  policies
    .map((p) => p.polcmd)
    .sort()
    .join(""),
  "adrw",
);

await asService(db, "insert into storage.objects (bucket_id, name) values ('avatars', $1)", [
  `${ada}/pic.webp`,
]);

const mine = await asUser(db, ada, "select name from storage.objects where bucket_id='avatars'");
eq("the owner can read their avatar object", mine.rows.length, 1);

const theirs = await asUser(db, rafa, "select name from storage.objects where bucket_id='avatars'");
eq("another member can read it too", theirs.rows.length, 1);

await asUser(db, rafa, "select public.block_user($1)", [ada]);
const blocked = await asUser(
  db,
  rafa,
  "select name from storage.objects where bucket_id='avatars'",
);
eq("a blocked person's avatar is NOT readable", blocked.rows.length, 0);
await asUser(db, rafa, "select public.unblock_user($1)", [ada]);

try {
  await asUser(db, rafa, "insert into storage.objects (bucket_id, name) values ('avatars', $1)", [
    `${ada}/evil.webp`,
  ]);
  bad("cannot upload into another user's folder", "the write succeeded");
} catch (error) {
  if (/row-level security/i.test(error.message)) ok("cannot upload into another user's folder");
  else bad("cannot upload into another user's folder", error.message);
}

try {
  await asUser(db, rafa, "insert into storage.objects (bucket_id, name) values ('avatars', $1)", [
    `${rafa}/mine.webp`,
  ]);
  ok("can upload into your own folder");
} catch (error) {
  bad("can upload into your own folder", error.message);
}

const del = await asUser(db, rafa, "delete from storage.objects where name = $1", [
  `${ada}/pic.webp`,
]);
eq("cannot delete another user's avatar", del.affectedRows ?? 0, 0);

await db.close();

console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\n  Failures:");
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${"=".repeat(60)}\n`);
process.exit(failed === 0 ? 0 : 1);
