/**
 * Test harness: runs the real migrations against real Postgres.
 *
 * PGlite is Postgres 17 compiled to WebAssembly — the actual engine, the actual
 * planner, the actual RLS implementation. It needs no Docker and no daemon,
 * which means the schema and its policies can be verified on any machine and in
 * CI, and `npm run db:test` has no prerequisites beyond `npm install`.
 *
 * What it stubs, and why that is honest:
 *
 *   auth.users / auth.uid() / auth.jwt()  — supplied by Supabase at runtime. The
 *     stubs here are faithful to the real contract: `auth.uid()` reads the `sub`
 *     claim out of the request-scoped GUC, exactly as Supabase's does. Policies
 *     therefore behave identically.
 *
 *   the `anon` / `authenticated` / `service_role` roles — created here with the
 *     same grants Supabase gives them, so `set role authenticated` in a test is
 *     the same thing the PostgREST connection does for a signed-in user.
 *
 *   the `realtime` schema — approximated, so migration 0009's policies can be
 *     parsed and created. Their runtime behaviour is Supabase's to provide; what
 *     is verified here is that they compile and reference real functions.
 *
 * The important consequence: tests below authenticate as a *role*, not as a
 * convenience wrapper. If a policy is wrong, the query fails or returns rows it
 * should not, exactly as it would in production.
 */

import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PGlite } from "@electric-sql/pglite";

// Teaches Node the `@/` alias so the suites can import the real application
// modules rather than a copy that drifts. Registered here because every suite
// imports this file first, and hooks must be installed before the dynamic
// imports that use them.
register(pathToFileURL(join(import.meta.dirname, "alias-loader.mjs")).href);

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/** Supabase supplies these at runtime; the schema depends on them existing. */
const SUPABASE_STUBS = /* sql */ `
  create schema if not exists auth;
  create schema if not exists realtime;

  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    raw_user_meta_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );

  -- Faithful to Supabase's implementation: the user id comes from the JWT claims
  -- placed in a request-scoped setting, never from anything the client sends as
  -- data. This is why "never trust a client-supplied user id" is structural.
  create or replace function auth.uid() returns uuid
  language sql stable as $fn$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $fn$;

  create or replace function auth.jwt() returns jsonb
  language sql stable as $fn$
    select coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  $fn$;

  create or replace function auth.role() returns text
  language sql stable as $fn$
    select nullif(current_setting('request.jwt.claim.role', true), '');
  $fn$;

  -- Approximation of realtime.messages, enough for migration 0009 to create its
  -- policies against.
  create table realtime.messages (
    id bigserial primary key,
    topic text not null,
    extension text not null,
    payload jsonb,
    inserted_at timestamptz not null default now()
  );

  create or replace function realtime.topic() returns text
  language sql stable as $fn$
    select nullif(current_setting('realtime.topic', true), '');
  $fn$;

  alter table realtime.messages enable row level security;

  -- Storage. Approximated closely enough that migration 0012's bucket insert and
  -- object policies are executed for real, including storage.foldername(), whose
  -- return shape (a text[] of path segments) is what every avatar policy indexes
  -- into. A stub that got that wrong would let a broken policy pass.
  create schema if not exists storage;

  create table storage.buckets (
    id text primary key,
    name text not null unique,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[],
    created_at timestamptz not null default now()
  );

  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text not null references storage.buckets (id) on delete cascade,
    name text not null,
    owner uuid,
    metadata jsonb,
    created_at timestamptz not null default now(),
    unique (bucket_id, name)
  );

  create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $fn$
    select string_to_array(name, '/');
  $fn$;

  alter table storage.objects enable row level security;
  alter table storage.objects force row level security;

  do $roles$
  begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon nologin noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      create role service_role nologin noinherit bypassrls;
    end if;
  end
  $roles$;

  grant usage on schema public, auth, realtime, storage to anon, authenticated, service_role;
`;

/**
 * Supabase's default privileges, set BEFORE the migrations run.
 *
 * This ordering is not cosmetic. Supabase grants privileges through ALTER
 * DEFAULT PRIVILEGES, so an object receives them at the moment it is created —
 * which means a migration that creates a function and then REVOKEs EXECUTE from
 * `authenticated` has the last word.
 *
 * An earlier version of this harness ran a blanket `grant all on all functions`
 * *after* the migrations instead, which silently re-granted everything migration
 * 0010 had revoked. The suite then reported the revoke as broken. The revoke was
 * fine; the harness was lying about production. Emulating the mechanism rather
 * than the end state is the difference.
 */
const DEFAULT_PRIVILEGES = /* sql */ `
  alter default privileges in schema public
    grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema realtime
    grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema storage
    grant all on tables to anon, authenticated, service_role;

  grant all on all tables in schema realtime to anon, authenticated, service_role;
  grant all on all tables in schema storage to anon, authenticated, service_role;
  grant all on all tables in schema auth to service_role;
  grant select on auth.users to authenticated;
`;

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Builds a fresh database and applies every migration in order.
 *
 * Nothing is cached between runs: a migration that only works when applied on
 * top of a database somebody already poked at is a migration that will not work
 * on production.
 */
export async function freshDatabase() {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  await db.exec(DEFAULT_PRIVILEGES);

  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`Migration ${file} failed:\n  ${error.message}`);
    }
  }

  return db;
}

/**
 * Runs a statement as a signed-in user, through the `authenticated` role.
 *
 * This is the whole point of the harness. It does not call a helper that
 * "pretends" to be a user — it sets the same JWT claim Supabase sets and assumes
 * the same role PostgREST assumes, inside a transaction, so RLS evaluates for
 * real. `set local` scopes both the role and the claims to the transaction, so
 * they unwind on commit or rollback — a role leaking into the next test would
 * make it pass for the wrong reason.
 */
export async function asUser(db, userId, sql, params = []) {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated", aal: "aal1" }),
    ]);
    await db.exec("set local role authenticated");
    const result = await db.query(sql, params);
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

/** Runs as the service role, which bypasses RLS — for fixtures and seeding. */
export async function asService(db, sql, params = []) {
  return db.query(sql, params);
}

/** Creates an account the way Supabase does, letting the signup trigger fire. */
export async function createUser(db, username) {
  const { rows } = await db.query(
    `insert into auth.users (email, raw_user_meta_data)
     values ($1, jsonb_build_object('username', $2::text))
     returning id`,
    [`${username}@example.test`, username],
  );
  return rows[0].id;
}
