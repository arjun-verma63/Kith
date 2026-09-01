-- =============================================================================
-- KITH — 0021 · Couple lifecycle and privacy
--
-- Migration 0006 built the tables and the policies, including the one that
-- carries the daily prompt: neither partner can read the other's answer until
-- they have written their own, enforced in the database rather than hidden by
-- the interface. This adds the lifecycle around it — proposing, answering,
-- ending — and the privacy controls that were never built.
--
-- ── The rule that shapes all of it ───────────────────────────────────────────
--
-- KITH is not a dating app and must not start feeling like one. Couple mode is a
-- quiet, optional thing between two people who are ALREADY friends here, and
-- three decisions enforce that rather than merely hoping for it:
--
--   1. You may only propose to a friend. Not a stranger, not somebody
--      discoverable, not somebody you found. `can_propose_to` requires an
--      existing friendship, full stop, and there is no way to widen it — the
--      permission setting can only make it stricter.
--
--   2. A couple is PRIVATE by default. Nothing appears on a profile, in a
--      directory, or anywhere else unless both people opt in.
--
--   3. There is no discovery of any kind. No suggestions, no browsing, no "who
--      is single". The only way to reach this feature is from the profile of
--      somebody you already know.
--
-- ── One thing deliberately NOT done through an RPC ───────────────────────────
--
-- Reading prompt answers. `list_couple_prompts` is a SECURITY INVOKER function,
-- so Row Level Security applies to the caller and the reveal gate holds. Making
-- it DEFINER would have been tidier and would have quietly disabled the single
-- most interesting policy in the schema.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Privacy controls.
-- -----------------------------------------------------------------------------

/*
 * Whether a couple is visible to anybody but the two of them.
 *
 * Private is the default and the expected state. `friends` puts a small marker
 * on both profiles and nothing else — no feed, no announcement, no badge on a
 * message. It is shared rather than per-person because a couple half-announced
 * is worse than either option: one profile saying it and the other not is a
 * statement in itself.
 */
create type public.couple_visibility as enum ('private', 'friends');

alter table public.couples
  add column if not exists visibility public.couple_visibility not null default 'private';

comment on column public.couples.visibility is
  'Private by default. `friends` shows a quiet marker on both profiles and nothing more.';

/*
 * Who may ask.
 *
 * `friends` is the default and the maximum: `everyone` is accepted by the enum
 * but treated exactly as `friends`, because a proposal from a stranger is the
 * dating-app behaviour this feature is defined against. `nobody` is a real
 * setting for somebody who does not want to be asked at all.
 */
alter table public.user_settings
  add column if not exists who_can_propose public.permission_scope not null default 'friends';

comment on column public.user_settings.who_can_propose is
  'friends (default) or nobody. `everyone` is treated as friends — proposals require a friendship.';

-- -----------------------------------------------------------------------------
-- can_propose_to
--
-- The gate, in one place, so the button and the write agree. A UI that offers an
-- action the database then refuses is worse than no button at all.
-- -----------------------------------------------------------------------------
create or replace function public.can_propose_to(other_user uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select
    other_user <> (select auth.uid())
    -- Friendship is required and cannot be waived by any setting.
    and public.are_friends(other_user)
    and not public.is_blocked_either(other_user)
    and coalesce(
      (
        select s.who_can_propose <> 'nobody'
        from public.user_settings s
        where s.user_id = other_user
      ),
      true
    )
    -- Neither of you may already be in one.
    and not exists (
      select 1 from public.couples c
      where c.status = 'active'
        and ((select auth.uid()) in (c.user_low, c.user_high) or other_user in (c.user_low, c.user_high))
    )
    -- And there must be no proposal already sitting between you, in either
    -- direction. Two crossing proposals would be two rows for one question.
    and not exists (
      select 1 from public.couples c
      where c.status = 'pending'
        and c.user_low = least((select auth.uid()), other_user)
        and c.user_high = greatest((select auth.uid()), other_user)
    );
$$;

-- -----------------------------------------------------------------------------
-- propose_couple
-- -----------------------------------------------------------------------------
create or replace function public.propose_couple(other_user uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  new_couple uuid;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if not public.can_propose_to(other_user) then
    raise exception 'not_permitted' using errcode = '42501';
  end if;

  -- Serialised on the pair so two people proposing to each other in the same
  -- second produce one proposal rather than two that each look unanswered.
  perform pg_advisory_xact_lock(hashtextextended(least(me, other_user)::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(greatest(me, other_user)::text, 0));

  -- Re-checked inside the lock: the first caller through has changed the answer
  -- for the second.
  if not public.can_propose_to(other_user) then
    raise exception 'already_pending' using errcode = '55006';
  end if;

  insert into public.couples (user_low, user_high, proposed_by, status)
  values (least(me, other_user), greatest(me, other_user), me, 'pending')
  returning id into new_couple;

  return new_couple;
end;
$$;

-- -----------------------------------------------------------------------------
-- respond_to_couple
--
-- Accept or decline. Only the person who did NOT propose may answer, which is
-- the entire consent model and is checked here as well as by the policy.
--
-- A declined proposal becomes `ended` rather than being deleted. The row is the
-- record that it was asked and answered; deleting it would let somebody ask
-- again immediately, over and over, with nothing to show for it.
-- -----------------------------------------------------------------------------
create or replace function public.respond_to_couple(p_couple_id uuid, p_accept boolean)
returns public.couple_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  target public.couples;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select * into target from public.couples where id = p_couple_id for update;

  if target.id is null or me not in (target.user_low, target.user_high) then
    raise exception 'not_permitted' using errcode = '42501';
  end if;

  if target.proposed_by = me then
    raise exception 'cannot_answer_own_proposal' using errcode = '22023';
  end if;

  if target.status <> 'pending' then
    raise exception 'not_pending' using errcode = '55006';
  end if;

  if not p_accept then
    update public.couples
       set status = 'ended', ended_at = now()
     where id = p_couple_id;
    return 'ended';
  end if;

  -- `couples_single_active` runs here and refuses if either person has become
  -- attached since the proposal was made. Advisory locks inside that trigger are
  -- what make the check safe rather than merely likely.
  update public.couples set status = 'active' where id = p_couple_id;

  return 'active';
end;
$$;

-- -----------------------------------------------------------------------------
-- end_couple
--
-- Either partner, at any time, without the other's agreement. That asymmetry is
-- deliberate: a relationship one person has left is not a relationship, and
-- requiring consent to leave would be a way of trapping somebody.
--
-- The prompts and answers are NOT deleted. They belong to both people, the row
-- cascade would take them with it, and a breakup is not a reason to destroy what
-- somebody wrote. The couple simply stops being active.
-- -----------------------------------------------------------------------------
create or replace function public.end_couple(p_couple_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  target public.couples;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select * into target from public.couples where id = p_couple_id for update;

  if target.id is null or me not in (target.user_low, target.user_high) then
    raise exception 'not_permitted' using errcode = '42501';
  end if;

  if target.status = 'ended' then
    return;
  end if;

  update public.couples
     set status = 'ended', ended_at = now()
   where id = p_couple_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- set_couple_details
--
-- The anniversary and the visibility. Either partner may change either — this is
-- a shared thing, and a setting one of them cannot reach is a setting they have
-- to ask permission for.
-- -----------------------------------------------------------------------------
create or replace function public.set_couple_details(
  p_couple_id uuid,
  p_anniversary date default null,
  p_visibility public.couple_visibility default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if not public.is_couple_member(p_couple_id) then
    raise exception 'not_permitted' using errcode = '42501';
  end if;

  if p_anniversary is not null and p_anniversary > current_date then
    raise exception 'anniversary_in_future' using errcode = '22023';
  end if;

  update public.couples
     set anniversary = coalesce(p_anniversary, anniversary),
         visibility = coalesce(p_visibility, visibility)
   where id = p_couple_id
     and status = 'active';
end;
$$;

-- -----------------------------------------------------------------------------
-- open_couple_prompt
--
-- Today's question, created once per couple per day.
--
-- The question text is chosen by the application and passed in, because prompt
-- copy is content and belongs with the rest of the writing rather than in a
-- migration. Both partners compute the same one from the same seed, and the
-- unique constraint makes the race harmless anyway — whoever arrives first
-- decides, and the second gets what is already there.
-- -----------------------------------------------------------------------------
create or replace function public.open_couple_prompt(p_couple_id uuid, p_question text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  prompt uuid;
begin
  if not public.is_couple_member(p_couple_id) then
    raise exception 'not_permitted' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.couples c where c.id = p_couple_id and c.status = 'active'
  ) then
    raise exception 'not_active' using errcode = '55006';
  end if;

  select p.id into prompt
  from public.couple_prompts p
  where p.couple_id = p_couple_id and p.prompt_date = current_date;

  if prompt is not null then
    return prompt;
  end if;

  insert into public.couple_prompts (couple_id, question)
  values (p_couple_id, p_question)
  on conflict (couple_id, prompt_date) do nothing
  returning id into prompt;

  if prompt is null then
    select p.id into prompt
    from public.couple_prompts p
    where p.couple_id = p_couple_id and p.prompt_date = current_date;
  end if;

  return prompt;
end;
$$;

-- =============================================================================
-- Reads
-- =============================================================================

-- -----------------------------------------------------------------------------
-- get_my_couple
--
-- The active partnership, or nothing. One row at most, because one active couple
-- per person is enforced by trigger.
-- -----------------------------------------------------------------------------
create or replace function public.get_my_couple()
returns table (
  id uuid,
  partner_id uuid,
  partner_username text,
  partner_display_name text,
  partner_avatar_path text,
  partner_status public.presence_status,
  partner_last_seen_at timestamptz,
  status public.couple_status,
  visibility public.couple_visibility,
  anniversary date,
  started_at timestamptz,
  prompt_count integer
)
language sql
stable
set search_path = ''
as $$
  select
    c.id,
    partner.id,
    partner.username,
    partner.display_name,
    partner.avatar_path,
    partner.status,
    case when partner.status = 'invisible' then null else partner.last_seen_at end,
    c.status,
    c.visibility,
    c.anniversary,
    c.created_at,
    (select count(*)::integer from public.couple_prompts p where p.couple_id = c.id)
  from public.couples c
  join public.profiles partner
    on partner.id = case when c.user_low = (select auth.uid()) then c.user_high else c.user_low end
  where c.status = 'active'
    and (select auth.uid()) in (c.user_low, c.user_high)
  limit 1;
$$;

-- -----------------------------------------------------------------------------
-- list_couple_invitations
--
-- Proposals waiting on this person. Never proposals they sent — those are shown
-- from their own side, and conflating the two is how somebody accidentally
-- "accepts" their own.
-- -----------------------------------------------------------------------------
create or replace function public.list_couple_invitations()
returns table (
  id uuid,
  direction text,
  other_id uuid,
  other_username text,
  other_display_name text,
  other_avatar_path text,
  created_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    c.id,
    case when c.proposed_by = (select auth.uid()) then 'outgoing' else 'incoming' end,
    other.id,
    other.username,
    other.display_name,
    other.avatar_path,
    c.created_at
  from public.couples c
  join public.profiles other
    on other.id = case when c.user_low = (select auth.uid()) then c.user_high else c.user_low end
  where c.status = 'pending'
    and (select auth.uid()) in (c.user_low, c.user_high)
  order by c.created_at desc;
$$;

-- Whether the OTHER person has written something, without saying what.
--
-- SECURITY DEFINER on purpose: it answers a question about existence, never
-- about content, and it has to work before the caller has answered — which is
-- exactly when the reveal policy hides the row.
create or replace function public.partner_answered_prompt(target_prompt uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.couple_answers a
    join public.couple_prompts p on p.id = a.prompt_id
    join public.couples c on c.id = p.couple_id
    where a.prompt_id = target_prompt
      and a.user_id <> (select auth.uid())
      and (select auth.uid()) in (c.user_low, c.user_high)
  );
$$;

-- -----------------------------------------------------------------------------
-- list_couple_prompts
--
-- SECURITY INVOKER, and that is the whole point.
--
-- Row Level Security on `couple_answers` is what makes the daily question work:
-- you cannot read your partner's answer until you have written your own. A
-- SECURITY DEFINER function would run as the owner, bypass that policy, and
-- return both answers to whoever asked — turning the one genuinely enforced
-- mechanic in the schema into a decoration.
--
-- So this runs as the caller. `answered_by_me` and `answered_by_partner` are
-- computed from `couple_answers` too, but through a helper that does not depend
-- on being able to READ the row — otherwise "have they answered yet?" would be
-- unanswerable until you had answered, and the waiting state could not be drawn.
-- -----------------------------------------------------------------------------
create or replace function public.list_couple_prompts(
  p_couple_id uuid,
  p_limit integer default 30
)
returns table (
  id uuid,
  prompt_date date,
  question text,
  my_answer text,
  partner_answer text,
  partner_has_answered boolean,
  created_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    p.id,
    p.prompt_date,
    p.question,
    mine.body,
    theirs.body,
    -- Deliberately independent of whether the body is readable. Knowing somebody
    -- is waiting on you is not the same as knowing what they said.
    public.partner_answered_prompt(p.id),
    p.created_at
  from public.couple_prompts p
  left join public.couple_answers mine
    on mine.prompt_id = p.id and mine.user_id = (select auth.uid())
  left join public.couple_answers theirs
    on theirs.prompt_id = p.id and theirs.user_id <> (select auth.uid())
  where p.couple_id = p_couple_id
    and public.is_couple_member(p_couple_id)
  order by p.prompt_date desc
  limit least(greatest(coalesce(p_limit, 30), 1), 90);
$$;

-- -----------------------------------------------------------------------------
-- couple_marker
--
-- What somebody else may see on a profile: a partner, or nothing.
--
-- Returns a row only when the couple is active AND visible to friends AND the
-- viewer is a friend of the person being viewed. Private is the default, so for
-- most couples this returns nothing to everybody.
-- -----------------------------------------------------------------------------
create or replace function public.couple_marker(target_user uuid)
returns table (
  partner_id uuid,
  partner_username text,
  partner_display_name text,
  anniversary date
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    partner.id,
    partner.username,
    partner.display_name,
    c.anniversary
  from public.couples c
  join public.profiles partner
    on partner.id = case when c.user_low = target_user then c.user_high else c.user_low end
  where c.status = 'active'
    and target_user in (c.user_low, c.user_high)
    and (
      -- Always visible to the two of them, whatever the setting.
      (select auth.uid()) in (c.user_low, c.user_high)
      -- Otherwise only when they have chosen to show it, and only to a friend.
      or (c.visibility = 'friends' and public.are_friends(target_user))
    )
  limit 1;
$$;

-- =============================================================================
-- Privileges
--
-- The lifecycle goes through the functions above. The policies from migration
-- 0006 stay as the second line, but the privilege is the door.
--
-- `couple_answers` is the exception and stays directly writable: its policies
-- are the mechanic, and routing writes through a SECURITY DEFINER function would
-- mean re-implementing in PL/pgSQL what the policy already says exactly.
-- =============================================================================

revoke insert, update, delete on public.couples from authenticated;
revoke insert, update, delete on public.couple_prompts from authenticated;

revoke execute on function public.partner_answered_prompt(uuid) from public, anon;
revoke execute on function public.can_propose_to(uuid) from public, anon;
revoke execute on function public.propose_couple(uuid) from public, anon;
revoke execute on function public.respond_to_couple(uuid, boolean) from public, anon;
revoke execute on function public.end_couple(uuid) from public, anon;
revoke execute on function public.set_couple_details(uuid, date, public.couple_visibility) from public, anon;
revoke execute on function public.open_couple_prompt(uuid, text) from public, anon;
revoke execute on function public.get_my_couple() from public, anon;
revoke execute on function public.list_couple_invitations() from public, anon;
revoke execute on function public.list_couple_prompts(uuid, integer) from public, anon;
revoke execute on function public.couple_marker(uuid) from public, anon;

grant execute on function public.partner_answered_prompt(uuid) to authenticated;
grant execute on function public.can_propose_to(uuid) to authenticated;
grant execute on function public.propose_couple(uuid) to authenticated;
grant execute on function public.respond_to_couple(uuid, boolean) to authenticated;
grant execute on function public.end_couple(uuid) to authenticated;
grant execute on function public.set_couple_details(uuid, date, public.couple_visibility) to authenticated;
grant execute on function public.open_couple_prompt(uuid, text) to authenticated;
grant execute on function public.get_my_couple() to authenticated;
grant execute on function public.list_couple_invitations() to authenticated;
grant execute on function public.list_couple_prompts(uuid, integer) to authenticated;
grant execute on function public.couple_marker(uuid) to authenticated;

-- =============================================================================
-- Three foreign keys that were never actually covered
--
-- The schema-hygiene suite has asserted "every foreign key is covered by an
-- index" since migration 0002, and it was checking the wrong thing: `conkey <@
-- indkey` asks whether the columns appear ANYWHERE in an index, and a btree can
-- only serve a lookup that starts at its leading column. An index on
-- `(user_low, user_high)` therefore "covered" `user_high` while being useless
-- for it.
--
-- Deleting a profile takes a sequential scan of each of these, which for a room
-- of six is nothing and for a table that grows is the cascade that mysteriously
-- takes minutes. Cheap to fix, and the test is now strict enough to notice.
-- =============================================================================

create index if not exists couples_user_high_idx on public.couples (user_high);
create index if not exists couple_answers_user_idx on public.couple_answers (user_id);
create index if not exists message_reactions_user_idx on public.message_reactions (user_id);

-- -----------------------------------------------------------------------------
-- And the grants migration 0006 never made.
--
-- Its helpers and trigger functions were left executable by `anon`. Neither is
-- exploitable — they key off `auth.uid()`, which is null for an anonymous caller,
-- and a trigger function called directly fails — but every other module in KITH
-- revokes from `anon` as a matter of course, and an exception nobody decided on
-- is not an exception.
-- -----------------------------------------------------------------------------
revoke execute on function public.is_couple_member(uuid) from public, anon;
revoke execute on function public.is_couple_prompt_member(uuid) from public, anon;
revoke execute on function public.has_answered_prompt(uuid) from public, anon;
revoke execute on function public.enforce_single_active_couple() from public, anon, authenticated;
revoke execute on function public.notify_couple_request() from public, anon, authenticated;
revoke execute on function public.notify_couple_accepted() from public, anon, authenticated;

grant execute on function public.is_couple_member(uuid) to authenticated;
grant execute on function public.is_couple_prompt_member(uuid) to authenticated;
grant execute on function public.has_answered_prompt(uuid) to authenticated;
