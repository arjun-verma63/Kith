/**
 * Couple mode.
 *
 * Two claims to prove, and they pull in different directions.
 *
 * PRIVACY. Only the two people involved may reach any of it, and within the
 * couple there is a second boundary: neither can read the other's answer to the
 * daily question until they have written their own. That one is enforced by an
 * RLS policy rather than by the interface, which means it can be tested by
 * asking the database directly — and if it ever stops holding, the feature has
 * quietly become a decoration.
 *
 * NOT A DATING APP. The brief is explicit, so the constraints that keep it true
 * are asserted rather than assumed: you can only ask a friend, no setting can
 * widen that, and a couple is invisible by default.
 *
 *     npm run couple:test
 */

import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { asService, asUser, createUser, freshDatabase } from "./harness.mjs";

register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

const { promptFor, PROMPTS } = await import("../../src/features/couple/prompts.ts");

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

async function allowed(name, promise) {
  try {
    await promise;
    ok(name);
  } catch (error) {
    bad(name, error.message.split("\n")[0]);
  }
}

console.log("KITH — couple mode\n");

const db = await freshDatabase();

const ada = await createUser(db, "ada");
const rafa = await createUser(db, "rafa");
const nour = await createUser(db, "nour");
const wren = await createUser(db, "wren");

const befriend = async (a, b) =>
  asService(db, "insert into public.friendships (user_low, user_high) values ($1, $2)", [
    a < b ? a : b,
    a < b ? b : a,
  ]);

// Ada and Rafa are friends. Nour is a friend of Ada but not Rafa. Wren knows
// nobody.
await befriend(ada, rafa);
await befriend(ada, nour);

/* ==========================================================================
 * 1 · The questions
 * ========================================================================== */

section("Daily questions");

{
  const couple = "11111111-1111-4111-8111-111111111111";
  const day = new Date("2026-03-14T09:00:00Z");

  eq("both partners compute the same question", promptFor(couple, day), promptFor(couple, day));
  truthy(
    "a different day is a different question",
    promptFor(couple, day) !== promptFor(couple, new Date("2026-03-15T09:00:00Z")),
  );
  truthy(
    "and a different couple gets their own",
    promptFor(couple, day) !== promptFor("22222222-2222-4222-8222-222222222222", day),
  );

  // The time of day must not matter, or two partners in different time zones
  // would compute different questions for the same date.
  eq(
    "the hour does not change it",
    promptFor(couple, new Date("2026-03-14T23:59:00Z")),
    promptFor(couple, new Date("2026-03-14T00:01:00Z")),
  );

  truthy("there are enough questions", PROMPTS.length >= 20);
  eq("all distinct", new Set(PROMPTS).size, PROMPTS.length);
  eq(
    "and all actually questions",
    PROMPTS.every((p) => p.trim().endsWith("?")),
    true,
  );
}

/* ==========================================================================
 * 2 · Who may ask
 *
 * The line between this and a dating app, in three assertions.
 * ========================================================================== */

section("Who may be asked");

{
  const canPropose = async (who, other) => {
    const { rows } = await asUser(db, who, "select public.can_propose_to($1) as yes", [other]);
    return rows[0].yes;
  };

  eq("a friend may be asked", await canPropose(ada, rafa), true);
  eq("A STRANGER MAY NOT", await canPropose(ada, wren), false);
  eq("nor may somebody who is only a friend of a friend", await canPropose(rafa, nour), false);
  eq("and nobody may ask themselves", await canPropose(ada, ada), false);

  await denied(
    "and the write is refused too, not just the button hidden",
    asUser(db, ada, "select public.propose_couple($1)", [wren]),
  );

  // The setting can only ever make it stricter.
  await asService(
    db,
    "update public.user_settings set who_can_propose = 'nobody' where user_id = $1",
    [rafa],
  );
  eq("somebody who has opted out cannot be asked", await canPropose(ada, rafa), false);

  await asService(
    db,
    "update public.user_settings set who_can_propose = 'everyone' where user_id = $1",
    [wren],
  );
  eq(
    "and `everyone` does NOT open it to strangers — friendship is still required",
    await canPropose(ada, wren),
    false,
  );

  await asService(
    db,
    "update public.user_settings set who_can_propose = 'friends' where user_id = $1",
    [rafa],
  );

  // Blocking. Through the function, so this is a real block rather than a row —
  // which means it also severs the friendship, and unblocking does not put it
  // back. That is the documented behaviour (migration 0026), so the fixture has
  // to restore it the way a person would: by becoming friends again.
  await asUser(db, nour, "select public.block_user($1)", [ada]);
  eq("somebody who blocked you cannot be asked", await canPropose(ada, nour), false);

  const { rows: severed } = await asService(
    db,
    "select count(*)::int n from public.friendships where user_low = $1 and user_high = $2",
    [ada < nour ? ada : nour, ada < nour ? nour : ada],
  );
  eq("  and the block took the friendship with it", severed[0].n, 0);

  await asUser(db, nour, "select public.unblock_user($1)", [ada]);
  eq("  unblocking does not restore it", await canPropose(ada, nour), false);

  await asService(db, "insert into public.friendships (user_low, user_high) values ($1, $2)", [
    ada < nour ? ada : nour,
    ada < nour ? nour : ada,
  ]);
  eq("  becoming friends again does", await canPropose(ada, nour), true);
}

/* ==========================================================================
 * 3 · Proposing and answering
 * ========================================================================== */

section("Proposing");

let couple;
{
  const { rows } = await asUser(db, ada, "select public.propose_couple($1) as id", [rafa]);
  couple = rows[0].id;
  truthy("a proposal is made", Boolean(couple));

  const { rows: state } = await asService(
    db,
    "select status, proposed_by, visibility, anniversary from public.couples where id = $1",
    [couple],
  );
  eq("it starts pending", state[0].status, "pending");
  eq("attributed to whoever asked", state[0].proposed_by, ada);
  eq("PRIVATE BY DEFAULT", state[0].visibility, "private");
  eq("with no date assumed", state[0].anniversary, null);

  await denied(
    "asking twice is refused",
    asUser(db, ada, "select public.propose_couple($1)", [rafa]),
  );
  await denied(
    "and so is asking back while one is pending",
    asUser(db, rafa, "select public.propose_couple($1)", [ada]),
  );

  const { rows: notified } = await asService(
    db,
    "select user_id, actor_id from public.notifications where kind = 'couple_request'",
  );
  eq("the other person is told", notified.length, 1);
  eq("and it is them, not the asker", notified[0].user_id, rafa);

  await denied(
    "the asker cannot answer their own question",
    asUser(db, ada, "select public.respond_to_couple($1, true)", [couple]),
  );
  await denied(
    "and neither can a bystander",
    asUser(db, nour, "select public.respond_to_couple($1, true)", [couple]),
  );

  const { rows: invitations } = await asUser(
    db,
    rafa,
    "select * from public.list_couple_invitations()",
  );
  eq("it shows up as something to answer", invitations.length, 1);
  eq("marked incoming", invitations[0].direction, "incoming");

  const { rows: mine } = await asUser(db, ada, "select * from public.list_couple_invitations()");
  eq("and outgoing on the other side", mine[0].direction, "outgoing");

  const { rows: outsider } = await asUser(
    db,
    nour,
    "select * from public.list_couple_invitations()",
  );
  eq("a bystander sees nothing", outsider.length, 0);
}

{
  await allowed(
    "the other person accepts",
    asUser(db, rafa, "select public.respond_to_couple($1, true)", [couple]),
  );

  const { rows } = await asService(db, "select status from public.couples where id = $1", [couple]);
  eq("and it is active", rows[0].status, "active");

  const { rows: told } = await asService(
    db,
    "select user_id from public.notifications where kind = 'couple_request' and payload->>'accepted' = 'true'",
  );
  eq("the person who asked is told", told.length, 1);
  eq("and it is them", told[0].user_id, ada);
}

/* ==========================================================================
 * 4 · One at a time
 * ========================================================================== */

section("One at a time");

{
  const { rows } = await asUser(db, ada, "select public.can_propose_to($1) as yes", [nour]);
  eq("somebody already paired cannot ask anybody else", rows[0].yes, false);

  await denied(
    "and cannot be forced into a second",
    asService(
      db,
      `insert into public.couples (user_low, user_high, proposed_by, status)
       values ($1, $2, $1, 'active')`,
      [ada < nour ? ada : nour, ada < nour ? nour : ada],
    ),
  );

  const { rows: nourAsks } = await asUser(db, nour, "select public.can_propose_to($1) as yes", [
    ada,
  ]);
  eq("nor asked by somebody else", nourAsks[0].yes, false);
}

/* ==========================================================================
 * 5 · Only the two of them
 * ========================================================================== */

section("Privacy");

{
  const { rows: theirs } = await asUser(db, ada, "select * from public.get_my_couple()");
  eq("each partner sees the couple", theirs.length, 1);
  eq("and who they are with", theirs[0].partner_id, rafa);

  const { rows: outsider } = await asUser(db, nour, "select * from public.get_my_couple()");
  eq("somebody else sees nothing of their own", outsider.length, 0);

  await denied(
    "and cannot read the row directly",
    asUser(db, nour, "select id from public.couples where id = $1", [couple]),
  );
  await denied(
    "nor a friend of one of them",
    asUser(db, wren, "select id from public.couples where id = $1", [couple]),
  );

  // The profile marker: nothing, because private is the default.
  const { rows: marker } = await asUser(db, nour, "select * from public.couple_marker($1)", [ada]);
  eq("a private couple leaves no trace on a profile", marker.length, 0);

  const { rows: own } = await asUser(db, ada, "select * from public.couple_marker($1)", [ada]);
  eq("though the two of them always see it", own.length, 1);

  // Opt in, and it becomes visible to friends only.
  await asUser(db, ada, "select public.set_couple_details($1, null, 'friends')", [couple]);

  const { rows: friendSees } = await asUser(db, nour, "select * from public.couple_marker($1)", [
    ada,
  ]);
  eq("a friend sees it once they choose to show it", friendSees.length, 1);
  eq("and who the partner is", friendSees[0].partner_id, rafa);

  const { rows: strangerSees } = await asUser(db, wren, "select * from public.couple_marker($1)", [
    ada,
  ]);
  eq("but a stranger still does not", strangerSees.length, 0);

  await asUser(db, ada, "select public.set_couple_details($1, null, 'private')", [couple]);
  const { rows: hiddenAgain } = await asUser(db, nour, "select * from public.couple_marker($1)", [
    ada,
  ]);
  eq("and turning it back off works", hiddenAgain.length, 0);
}

{
  // Either partner may change the shared settings.
  await allowed(
    "either partner can set the anniversary",
    asUser(db, rafa, "select public.set_couple_details($1, '2024-06-01'::date, null)", [couple]),
  );

  const { rows } = await asService(db, "select anniversary from public.couples where id = $1", [
    couple,
  ]);
  eq("and it is stored", rows[0].anniversary.toISOString().slice(0, 10), "2024-06-01");

  await denied(
    "a date in the future is refused",
    asUser(db, ada, "select public.set_couple_details($1, '2099-01-01'::date, null)", [couple]),
  );

  await denied(
    "and an outsider cannot touch any of it",
    asUser(db, nour, "select public.set_couple_details($1, null, 'friends')", [couple]),
  );
}

/* ==========================================================================
 * 6 · The daily question
 *
 * The one genuinely enforced mechanic in the schema.
 * ========================================================================== */

section("The daily question");

let prompt;
{
  const { rows } = await asUser(db, ada, "select public.open_couple_prompt($1, $2) as id", [
    couple,
    "What would a perfect ordinary Tuesday look like?",
  ]);
  prompt = rows[0].id;
  truthy("a question is opened", Boolean(prompt));

  const { rows: again } = await asUser(db, rafa, "select public.open_couple_prompt($1, $2) as id", [
    couple,
    "A completely different question",
  ]);
  eq("the other partner gets the same one, not a second", again[0].id, prompt);

  const { rows: count } = await asService(
    db,
    "select count(*)::int as n from public.couple_prompts where couple_id = $1",
    [couple],
  );
  eq("one question per couple per day", count[0].n, 1);

  await denied(
    "an outsider cannot open one",
    asUser(db, nour, "select public.open_couple_prompt($1, $2)", [couple, "Nosy"]),
  );
}

{
  // Before anybody answers.
  const { rows } = await asUser(db, ada, "select * from public.list_couple_prompts($1)", [couple]);
  eq("the question is visible to both", rows.length, 1);
  eq("with no answer of your own", rows[0].my_answer, null);
  eq("nor theirs", rows[0].partner_answer, null);
  eq("and nobody waiting", rows[0].partner_has_answered, false);
}

{
  // Rafa answers first. Ada has not.
  await allowed(
    "a partner writes an answer",
    asUser(
      db,
      rafa,
      "insert into public.couple_answers (prompt_id, user_id, body) values ($1, $2, $3)",
      [prompt, rafa, "Nothing planned and nowhere to be."],
    ),
  );

  const { rows: adaSees } = await asUser(db, ada, "select * from public.list_couple_prompts($1)", [
    couple,
  ]);

  /* --- the assertion this whole feature rests on ------------------------ */
  eq("THE OTHER PARTNER CANNOT READ IT YET", adaSees[0].partner_answer, null);
  eq("but is told somebody is waiting on them", adaSees[0].partner_has_answered, true);

  // Not filtered by the query — genuinely not readable.
  await denied(
    "and cannot read it by asking the table directly",
    asUser(db, ada, "select body from public.couple_answers where prompt_id = $1", [prompt]),
  );

  const { rows: rafaSees } = await asUser(
    db,
    rafa,
    "select * from public.list_couple_prompts($1)",
    [couple],
  );
  eq(
    "the writer can always read their own",
    rafaSees[0].my_answer,
    "Nothing planned and nowhere to be.",
  );
  eq("and knows the other has not answered", rafaSees[0].partner_has_answered, false);
}

{
  // Ada answers. Now both are readable, to both.
  await asUser(
    db,
    ada,
    "insert into public.couple_answers (prompt_id, user_id, body) values ($1, $2, $3)",
    [prompt, ada, "A long walk and no phone."],
  );

  const { rows: adaSees } = await asUser(db, ada, "select * from public.list_couple_prompts($1)", [
    couple,
  ]);
  eq(
    "writing yours unlocks theirs",
    adaSees[0].partner_answer,
    "Nothing planned and nowhere to be.",
  );
  eq("and your own is still there", adaSees[0].my_answer, "A long walk and no phone.");

  const { rows: rafaSees } = await asUser(
    db,
    rafa,
    "select * from public.list_couple_prompts($1)",
    [couple],
  );
  eq("and it works both ways", rafaSees[0].partner_answer, "A long walk and no phone.");
}

{
  // Nobody else, at any point.
  await denied(
    "an outsider cannot read the questions",
    asUser(db, nour, "select * from public.list_couple_prompts($1)", [couple]),
  );
  await denied(
    "nor the answers",
    asUser(db, nour, "select body from public.couple_answers where prompt_id = $1", [prompt]),
  );
  await denied(
    "nor write one",
    asUser(
      db,
      nour,
      "insert into public.couple_answers (prompt_id, user_id, body) values ($1, $2, 'hello')",
      [prompt, nour],
    ),
  );
  await denied(
    "nor answer on somebody else's behalf",
    asUser(
      db,
      ada,
      "insert into public.couple_answers (prompt_id, user_id, body) values ($1, $2, 'not me')",
      [prompt, rafa],
    ),
  );
}

/* ==========================================================================
 * 7 · Ending
 * ========================================================================== */

section("Ending");

{
  await denied(
    "an outsider cannot end somebody's relationship",
    asUser(db, nour, "select public.end_couple($1)", [couple]),
  );

  await denied(
    "and nobody can write the row by hand",
    asUser(db, ada, "update public.couples set status = 'ended' where id = $1", [couple]),
  );

  // Either partner, without the other's agreement. That asymmetry is deliberate.
  await allowed(
    "either partner may end it",
    asUser(db, rafa, "select public.end_couple($1)", [couple]),
  );

  const { rows } = await asService(
    db,
    "select status, ended_at from public.couples where id = $1",
    [couple],
  );
  eq("it is ended", rows[0].status, "ended");
  truthy("and stamped", rows[0].ended_at !== null);

  const { rows: gone } = await asUser(db, ada, "select * from public.get_my_couple()");
  eq("neither is in a couple any more", gone.length, 0);

  // What was written stays written.
  const { rows: kept } = await asService(
    db,
    "select count(*)::int as n from public.couple_answers where prompt_id = $1",
    [prompt],
  );
  eq("but nothing either of them wrote is deleted", kept[0].n, 2);

  await allowed(
    "ending twice is not an error",
    asUser(db, ada, "select public.end_couple($1)", [couple]),
  );

  // And both are free again.
  const { rows: free } = await asUser(db, ada, "select public.can_propose_to($1) as yes", [nour]);
  eq("and both are free to ask somebody else", free[0].yes, true);
}

{
  // Declining, which is a different path to the same status.
  const { rows: proposed } = await asUser(db, ada, "select public.propose_couple($1) as id", [
    nour,
  ]);
  const declined = proposed[0].id;

  await allowed(
    "a proposal can be declined",
    asUser(db, nour, "select public.respond_to_couple($1, false)", [declined]),
  );

  const { rows } = await asService(db, "select status from public.couples where id = $1", [
    declined,
  ]);
  eq("which ends it", rows[0].status, "ended");

  const { rows: none } = await asUser(db, ada, "select * from public.get_my_couple()");
  eq("with nobody paired", none.length, 0);

  // The row survives so the same question cannot be asked on a loop.
  const { rows: retry } = await asUser(db, ada, "select public.can_propose_to($1) as yes", [nour]);
  eq("and asking again is possible, but it is a new proposal", retry[0].yes, true);
}

/* ==========================================================================
 * 8 · Schema hygiene
 * ========================================================================== */

section("Schema");

{
  const { rows } = await asService(
    db,
    `select c.conname
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
      where t.relname in ('couples', 'couple_prompts', 'couple_answers')
        and c.contype = 'f'
        and not exists (
          select 1 from pg_index i
           where i.indrelid = c.conrelid
             and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] operator(pg_catalog.=) c.conkey
        )`,
  );
  eq(
    "every couple foreign key has a covering index",
    rows.map((r) => r.conname),
    [],
  );

  const { rows: rls } = await asService(
    db,
    `select relname from pg_class
      where relname in ('couples','couple_prompts','couple_answers')
        and not (relrowsecurity and relforcerowsecurity)`,
  );
  eq(
    "RLS is enabled and forced on every couple table",
    rls.map((r) => r.relname),
    [],
  );

  const { rows: definers } = await asService(
    db,
    `select proname from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname like '%couple%'
        and prosecdef
        and (proconfig is null or not exists (
          select 1 from unnest(proconfig) cfg where cfg like 'search\\_path=%'
        ))
      order by proname`,
  );
  eq(
    "every SECURITY DEFINER couple function pins search_path",
    definers.map((r) => r.proname),
    [],
  );

  /*
   * The one function that must NOT be SECURITY DEFINER.
   *
   * `list_couple_prompts` reads `couple_answers`, and the policy on that table is
   * the entire mechanic. Marking it DEFINER would run it as the owner, bypass the
   * policy, and hand both answers to whoever asked — without any test failing
   * unless it is this one.
   */
  const { rows: invoker } = await asService(
    db,
    "select prosecdef from pg_proc where pronamespace = 'public'::regnamespace and proname = 'list_couple_prompts'",
  );
  eq(
    "list_couple_prompts runs as the caller, so the reveal gate holds",
    invoker[0].prosecdef,
    false,
  );

  const { rows: anonGrants } = await asService(
    db,
    `select p.proname from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname like '%couple%'
        and has_function_privilege('anon', p.oid, 'execute')`,
  );
  eq(
    "anon can execute none of it",
    anonGrants.map((r) => r.proname),
    [],
  );
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
