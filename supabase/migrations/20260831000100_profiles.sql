-- =============================================================================
-- KITH — 0011 · Profiles
--
-- Birthday, and one rename that is a correctness fix rather than a preference.
--
-- `avatar_url` becomes `avatar_path`. Avatars live in a PRIVATE bucket and are
-- served through signed URLs, which expire. A column called `avatar_url`
-- invites somebody to store one — and a stored signed URL is a value that works
-- for ten minutes and then renders a broken image forever. The column holds the
-- storage path; the URL is minted per request from it.
-- =============================================================================

alter table public.profiles rename column avatar_url to avatar_path;

comment on column public.profiles.avatar_path is
  'Object path inside the private `avatars` bucket, e.g. "<uuid>/abc.webp". Never a URL — signed URLs expire and must be minted per request.';

-- -----------------------------------------------------------------------------
-- birthday
--
-- Optional, and deliberately a `date` rather than a timestamp: a birthday has no
-- time and no timezone. Storing it as a timestamptz is how "12 March" becomes
-- "11 March" for somebody three hours west.
--
-- The year is stored because it is the useful part later (milestone birthdays,
-- "turns 30 next week"), but the interface renders day and month only. Real
-- column-level privacy would need a view and a second grant path; at six trusted
-- people in one invited room that is machinery without a threat to defend
-- against, and the honest thing is to say so rather than build it and imply the
-- protection is stronger than it is.
-- -----------------------------------------------------------------------------

alter table public.profiles
  add column birthday date;

alter table public.profiles
  add constraint profiles_birthday_plausible check (
    birthday is null
    or (birthday > date '1900-01-01' and birthday <= current_date)
  );

comment on column public.profiles.birthday is
  'Optional. Day and month are shown in the interface; the year is stored but not rendered.';

-- -----------------------------------------------------------------------------
-- touch_last_seen
--
-- The heartbeat behind "last seen 20 minutes ago".
--
-- Writing a row on every heartbeat is what makes a presence table a bad idea, so
-- this one is rate-limited in the database: the update only fires if the stored
-- value is already stale. A client that calls it every second still causes one
-- write a minute, and a buggy client cannot turn presence into a write storm.
--
-- Live "who is online right now" is Realtime Presence, which needs no writes at
-- all. This column answers the question after they have gone.
-- -----------------------------------------------------------------------------

create or replace function public.touch_last_seen()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Transaction-scoped flag read by the column-pinning trigger below. This is
  -- the only sanctioned way last_seen_at moves.
  perform set_config('kith.presence_write', '1', true);

  update public.profiles
     set last_seen_at = now()
   where id = (select auth.uid())
     and last_seen_at < now() - interval '45 seconds';
end;
$$;

comment on function public.touch_last_seen() is
  'Throttled presence heartbeat. No-ops unless last_seen_at is already stale.';

revoke execute on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;

-- -----------------------------------------------------------------------------
-- Username changes
--
-- The unique index already stops two people holding the same name. This stops
-- one person cycling through names: a username is an identity other people
-- learn, and letting it change hourly makes "who am I talking to" unanswerable.
-- -----------------------------------------------------------------------------

alter table public.profiles
  add column username_changed_at timestamptz;

create or replace function public.enforce_username_cooldown()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.username is distinct from old.username then
    if old.username_changed_at is not null
       and old.username_changed_at > now() - interval '30 days' then
      raise exception 'username_cooldown: a username can only be changed once every 30 days'
        using errcode = '22023';
    end if;

    new.username_changed_at := now();
  end if;

  return new;
end;
$$;

-- Runs after profiles_pin_system_columns (alphabetical order), so
-- old.username_changed_at is authoritative by the time it is read.
create trigger profiles_username_cooldown
  before update on public.profiles
  for each row execute function public.enforce_username_cooldown();

-- -----------------------------------------------------------------------------
-- Column-level write protection
--
-- `profiles_update_own` lets a person write their own row, which is correct —
-- but "their own row" includes `last_seen_at` and `username_changed_at`. A
-- client that can set its own last-seen can write it on every keystroke, which
-- is exactly the write amplification the throttle exists to prevent; a client
-- that can null its own `username_changed_at` can walk straight through the
-- cooldown above.
--
-- RLS is row-level and cannot express "every column except these", so the guard
-- is a trigger. Note that SECURITY DEFINER does NOT exempt a function from
-- triggers — it changes the privilege context, not the execution path — so
-- `touch_last_seen()` would be pinned along with everyone else. The
-- transaction-scoped flag it sets is what distinguishes the sanctioned write.
--
-- Trigger order is alphabetical, so this runs BEFORE
-- `profiles_username_cooldown`: the old value is restored first, then the
-- cooldown check reads it and stamps a new one. Renaming either trigger without
-- keeping that order breaks the cooldown silently.
-- -----------------------------------------------------------------------------

create or replace function public.pin_profile_system_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.id := old.id;
  new.created_at := old.created_at;
  new.username_changed_at := old.username_changed_at;

  if coalesce(current_setting('kith.presence_write', true), '') <> '1' then
    new.last_seen_at := old.last_seen_at;
  end if;

  return new;
end;
$$;

create trigger profiles_pin_system_columns
  before update on public.profiles
  for each row execute function public.pin_profile_system_columns();
