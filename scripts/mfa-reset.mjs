#!/usr/bin/env node
/**
 * Removes an account's two-factor authenticators, from the terminal.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * TOTP has no "forgot my phone" link and cannot have one. The server would need
 * to be able to produce a code on the account holder's behalf, which is exactly
 * the property the scheme is built to lack. Recovery codes are the usual answer;
 * Supabase Auth does not issue them.
 *
 * So when somebody loses every authenticator they enrolled, there are two
 * honest options: they lose the account, or a human with the service-role key
 * removes the factor after satisfying themselves that the person asking is the
 * person who owns it. KITH is six friends who know each other, which makes the
 * second one both possible and correct.
 *
 * ── This is a real skeleton key ──────────────────────────────────────────────
 *
 * It needs SUPABASE_SERVICE_ROLE_KEY and it turns two-factor off for whoever is
 * named. It cannot read a password and it cannot sign in as anybody, but it can
 * undo the protection — so it lives in the terminal, on purpose, where running
 * it requires the key and leaves a shell history rather than being a button.
 *
 *   node scripts/mfa-reset.mjs someone@example.com          # show what they have
 *   node scripts/mfa-reset.mjs someone@example.com --remove # remove all of it
 *
 * Verify the person out of band FIRST — a voice call, in person, something an
 * attacker with their inbox cannot fake. An email asking for this is exactly
 * what the attack looks like.
 */

import { createClient } from "@supabase/supabase-js";

import { loadEnvLocal } from "./load-env.mjs";

// Next reads .env.local for `npm run dev`; a plain Node script has to ask.
loadEnvLocal();

const [email, ...flags] = process.argv.slice(2);
const remove = flags.includes("--remove");

if (!email) {
  console.error("Usage: node scripts/mfa-reset.mjs <email> [--remove]");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Load them from .env.local before running this.",
  );
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/*
 * There is no "get user by email" in the admin API, so the page is walked. Fine
 * for a room of six; if KITH ever has thousands of accounts this becomes a
 * lookup against public.profiles instead.
 */
const { data: page, error: listError } = await admin.auth.admin.listUsers({ perPage: 200 });

if (listError) {
  console.error(`Could not list users: ${listError.message}`);
  process.exit(1);
}

const user = page.users.find((candidate) => candidate.email?.toLowerCase() === email.toLowerCase());

if (!user) {
  console.error(`No account with the address ${email}.`);
  process.exit(1);
}

const { data: factors, error: factorError } = await admin.auth.admin.mfa.listFactors({
  userId: user.id,
});

if (factorError) {
  console.error(`Could not read factors: ${factorError.message}`);
  process.exit(1);
}

const all = factors?.factors ?? [];
const verified = all.filter((factor) => factor.status === "verified");

console.log(`\n  ${email}`);
console.log(`  ${user.id}`);
console.log(`  ${all.length} factor(s), ${verified.length} verified\n`);

for (const factor of all) {
  console.log(
    `    ${factor.status.padEnd(10)} ${factor.factor_type.padEnd(6)} ${
      factor.friendly_name ?? "(unnamed)"
    }  ${factor.id}`,
  );
}

if (all.length === 0) {
  console.log("    (nothing enrolled)\n");
  process.exit(0);
}

if (!remove) {
  console.log("\n  Pass --remove to delete these. Verify the person out of band first.\n");
  process.exit(0);
}

let removed = 0;

for (const factor of all) {
  const { error } = await admin.auth.admin.mfa.deleteFactor({
    userId: user.id,
    id: factor.id,
  });

  if (error) {
    console.error(`  ! could not remove ${factor.id}: ${error.message}`);
    continue;
  }

  removed += 1;
}

/*
 * Written to the audit log the account holder can see.
 *
 * If this was done by an attacker who talked their way past a human, the person
 * whose account it was should find out from their own settings page rather than
 * from the consequences.
 */
const { error: logError } = await admin.from("security_events").insert({
  user_id: user.id,
  event: "mfa.disabled",
  metadata: { by: "admin", tool: "scripts/mfa-reset.mjs", removed },
});

if (logError) {
  console.error(`  ! the removal was NOT recorded in security_events: ${logError.message}`);
}

console.log(`\n  Removed ${removed} factor(s). Tell them to enrol again straight away.\n`);
