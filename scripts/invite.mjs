#!/usr/bin/env node
/**
 * Mints an invitation code.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * KITH is invitation-only. `consume_invite` lets the very first signup through
 * with no code — the room is empty, so there is nobody to have invited them —
 * and requires a valid code from everybody after that.
 *
 * Which left no way to invite the second person. The `invite_codes` table, its
 * policies, the five-live ceiling and the redemption ledger all existed; nothing
 * wrote to them. The app has no button for it and this script did not exist, so
 * a freshly deployed KITH could hold exactly one account.
 *
 * ── Why a script rather than a button ────────────────────────────────────────
 *
 * A button is the better answer eventually, and this is not a stand-in for one.
 * But an invitation is the only thing that adds a person to a private room, it
 * happens roughly five times in the app's life, and the terminal is a reasonable
 * place for an action that rare and that consequential — it needs the
 * service-role key, and it leaves a shell history.
 *
 * ── The code is shown once ───────────────────────────────────────────────────
 *
 * Only the SHA-256 digest is stored, which is why `consume_invite` takes a hash:
 * the database has never seen a code in plaintext and cannot show you one later.
 * Lose it and mint another.
 *
 *   npm run invite -- ada                        # one use, expires in 14 days
 *   npm run invite -- ada --uses 3 --days 30
 *   npm run invite -- ada --note "for rafa"
 *   npm run invite -- ada --list                 # what is outstanding
 *
 * The username is whoever the invitation is FROM — it has to belong to somebody,
 * because "who let this person in" is worth being able to answer.
 */

import { createHash, randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const username = argv.find((arg) => !arg.startsWith("--"));

function flag(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
}

const listOnly = argv.includes("--list");
const uses = Number(flag("uses", 1));
const days = Number(flag("days", 14));
const note = flag("note", null);

if (!username) {
  console.error(
    'Usage: npm run invite -- <username> [--uses N] [--days N] [--note "..."] [--list]',
  );
  console.error("\n  <username> is the member the invitation comes FROM.");
  process.exit(1);
}

if (!Number.isInteger(uses) || uses < 1 || uses > 20) {
  console.error("--uses must be a whole number between 1 and 20 (the table's own limit).");
  process.exit(1);
}

if (!Number.isInteger(days) || days < 1 || days > 90) {
  console.error("--days must be a whole number between 1 and 90.");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.");
  console.error(
    "Locally they come from .env.local; against production, export them for one command.",
  );
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/* -------------------------------------------------------------------------- */

const { data: profile, error: profileError } = await admin
  .from("profiles")
  .select("id, username, display_name")
  .eq("username", username)
  .maybeSingle();

if (profileError) {
  console.error(`Could not look up "${username}": ${profileError.message}`);
  process.exit(1);
}

if (!profile) {
  console.error(`No member with the username "${username}".`);
  console.error("If nobody has signed up yet, the FIRST signup needs no code at all — just leave");
  console.error("the invite field blank. This script is for everybody after that.");
  process.exit(1);
}

if (listOnly) {
  const { data: live } = await admin
    .from("invite_codes")
    .select("note, uses, max_uses, expires_at, created_at")
    .eq("created_by", profile.id)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });

  const outstanding = (live ?? []).filter(
    (code) => code.uses < code.max_uses && new Date(code.expires_at) > new Date(),
  );

  console.log(
    `\n  ${profile.display_name} (@${profile.username}) — ${outstanding.length} live invitation(s)\n`,
  );

  for (const code of outstanding) {
    const label = code.note ? `"${code.note}"` : "(no note)";
    console.log(
      `    ${label}  ${code.uses}/${code.max_uses} used  expires ${new Date(code.expires_at).toDateString()}`,
    );
  }

  // The codes themselves are not here and cannot be: only the digest is stored.
  if (outstanding.length > 0) console.log("\n  Codes are stored hashed and cannot be shown again.");
  console.log("");
  process.exit(0);
}

/*
 * 24 hex characters from the CSPRNG.
 *
 * Not a word list: a memorable code is a guessable one, and this is the single
 * credential that turns a stranger into a member of a private room. It is
 * pasted, not typed, so being unpretty costs nothing.
 */
const code = randomBytes(12).toString("hex");
const codeHash = createHash("sha256").update(code).digest("hex");

const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const { error } = await admin.from("invite_codes").insert({
  code_hash: codeHash,
  created_by: profile.id,
  max_uses: uses,
  expires_at: expiresAt,
  ...(note ? { note } : {}),
});

if (error) {
  // The ceiling from migration 0028: five live invitations per member, so one
  // compromised account cannot mint its way to a room full of strangers.
  if (error.message.includes("too_many_invites")) {
    console.error(`\n  ${profile.display_name} already has 5 live invitations.\n`);
    console.error("  That ceiling is deliberate — see migration 0028. Wait for one to be used or");
    console.error("  expire, or revoke one in the Supabase dashboard.\n");
    process.exit(1);
  }

  console.error(`Could not create the invitation: ${error.message}`);
  process.exit(1);
}

console.log(`
  Invitation from ${profile.display_name} (@${profile.username})

      ${code}

  ${uses === 1 ? "One use" : `${uses} uses`}, expires ${new Date(expiresAt).toDateString()}${note ? `, noted "${note}"` : ""}.

  Shown once — only the hash is stored, so this cannot be recovered.
  Send it the way you would a door key, and paste it into the invite field
  on the signup page.
`);
