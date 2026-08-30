-- =============================================================================
-- KITH — 0006 · Couple
--
-- couples, couple_prompts, couple_answers.
--
-- There is no `couple_games` table. A couple game is a game whose audience is
-- 'couple' and whose session carries a `couple_id` — one catalogue, one session
-- table, one engine, one set of policies. A parallel table would duplicate every
-- column of `game_sessions` and every rule that governs it, and would guarantee
-- the two drift apart the first time a feature lands on only one of them.
--
-- The interesting thing in this migration is `couple_answers`. The product rule
-- is that neither partner can read the other's answer until they have written
-- their own — and that rule is enforced by an RLS policy, not by the interface.
-- Hiding text with CSS while shipping it in the response is not a mechanic, it is
-- a decoration. Here the row genuinely does not leave the database.
-- =============================================================================

create table public.couples (
  id uuid primary key default gen_random_uuid(),

  -- Same canonical ordering as friendships: one row per pair, single-probe
  -- lookups, and no possibility of a mirrored duplicate.
  user_low uuid not null references public.profiles (id) on delete cascade,
  user_high uuid not null references public.profiles (id) on delete cascade,

  status public.couple_status not null default 'pending',
  -- Who asked. Needed because acceptance must come from the *other* person.
  proposed_by uuid not null references public.profiles (id) on delete cascade,

  anniversary date,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz,

  constraint couples_canonical_order check (user_low < user_high),
  constraint couples_proposer_is_member check (proposed_by in (user_low, user_high)),
  constraint couples_ended_consistency check ((status = 'ended') = (ended_at is not null))
);

-- At most one live proposal or partnership between the same two people. This one
-- IS expressible as a unique index, because it is a property of the pair.
create unique index couples_live_pair_key
  on public.couples (user_low, user_high)
  where status in ('pending', 'active');

-- At most one ACTIVE couple per person is NOT expressible as a unique index.
--
-- The obvious attempt — a partial unique index on user_low and another on
-- user_high — looks right and silently fails: a person who is `user_low` in one
-- active row and `user_high` in another satisfies both indexes. Since the columns
-- are canonically ordered by uuid, which side you land on is arbitrary, so the
-- hole opens roughly half the time.
--
-- The constraint is "this id appears in either column of at most one active row",
-- which needs a check across rows. The advisory locks are what make that check
-- safe under concurrency: two simultaneous acceptances serialise on the people
-- involved instead of both reading "no active couple" and both writing one. They
-- are taken in canonical order, so they cannot deadlock against each other.
create or replace function public.enforce_single_active_couple()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'active' then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.user_low::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(new.user_high::text, 0));

  if exists (
    select 1
    from public.couples c
    where c.status = 'active'
      and c.id <> new.id
      and (
        c.user_low in (new.user_low, new.user_high)
        or c.user_high in (new.user_low, new.user_high)
      )
  ) then
    raise exception
      'couples_one_active_violation: one of these people is already in an active couple'
      using errcode = '23505';
  end if;

  return new;
end;
$$;

create trigger couples_single_active
  before insert or update on public.couples
  for each row execute function public.enforce_single_active_couple();

create index couples_proposed_by_idx on public.couples (proposed_by);

create trigger couples_set_updated_at
  before update on public.couples
  for each row execute function public.set_updated_at();

create or replace function public.is_couple_member(target_couple uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.couples c
    where c.id = target_couple
      and (select auth.uid()) in (c.user_low, c.user_high)
  );
$$;

-- -----------------------------------------------------------------------------
-- couple_prompts
-- -----------------------------------------------------------------------------

create table public.couple_prompts (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples (id) on delete cascade,
  prompt_date date not null default current_date,
  question text not null,
  created_at timestamptz not null default now(),

  -- One question per couple per day, enforced here rather than by whichever job
  -- generates them remembering to check first.
  unique (couple_id, prompt_date),
  constraint couple_prompts_question_length check (char_length(question) between 1 and 300)
);

create index couple_prompts_couple_date_idx
  on public.couple_prompts (couple_id, prompt_date desc);

-- -----------------------------------------------------------------------------
-- couple_answers
-- -----------------------------------------------------------------------------

create table public.couple_answers (
  prompt_id uuid not null references public.couple_prompts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (prompt_id, user_id),
  constraint couple_answers_body_length check (char_length(body) between 1 and 1000)
);

create trigger couple_answers_set_updated_at
  before update on public.couple_answers
  for each row execute function public.set_updated_at();

-- Is the caller in the couple this prompt belongs to?
create or replace function public.is_couple_prompt_member(target_prompt uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.couple_prompts p
    join public.couples c on c.id = p.couple_id
    where p.id = target_prompt
      and (select auth.uid()) in (c.user_low, c.user_high)
  );
$$;

-- Has the caller already answered this prompt? The gate on reading the other
-- person's answer.
create or replace function public.has_answered_prompt(target_prompt uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.couple_answers a
    where a.prompt_id = target_prompt
      and a.user_id = (select auth.uid())
  );
$$;

-- =============================================================================
-- Row Level Security
-- =============================================================================

alter table public.couples enable row level security;
alter table public.couple_prompts enable row level security;
alter table public.couple_answers enable row level security;

alter table public.couples force row level security;
alter table public.couple_prompts force row level security;
alter table public.couple_answers force row level security;

-- --- couples -----------------------------------------------------------------

create policy couples_select_member on public.couples
  for select to authenticated
  using ((select auth.uid()) in (user_low, user_high));

-- Proposing. You must be in the pair, you must be the proposer, the other person
-- must not have blocked you, and it starts pending — you cannot propose yourself
-- straight into an active partnership.
create policy couples_insert_member on public.couples
  for insert to authenticated
  with check (
    proposed_by = (select auth.uid())
    and (select auth.uid()) in (user_low, user_high)
    and status = 'pending'
    and not public.is_blocked_either(
      case when user_low = (select auth.uid()) then user_high else user_low end
    )
  );

-- Accepting requires being the person who did NOT propose. This is the whole
-- consent model, and it is one clause.
create policy couples_accept on public.couples
  for update to authenticated
  using (
    status = 'pending'
    and (select auth.uid()) in (user_low, user_high)
    and proposed_by <> (select auth.uid())
  )
  with check (status in ('active', 'ended'));

-- Either partner may end it, at any time, without the other's agreement.
create policy couples_end on public.couples
  for update to authenticated
  using (
    status = 'active'
    and (select auth.uid()) in (user_low, user_high)
  )
  with check (status = 'ended');

-- --- couple_prompts ----------------------------------------------------------

create policy couple_prompts_select_member on public.couple_prompts
  for select to authenticated
  using (public.is_couple_member(couple_id));

create policy couple_prompts_insert_member on public.couple_prompts
  for insert to authenticated
  with check (public.is_couple_member(couple_id));

-- --- couple_answers ----------------------------------------------------------

-- The mechanic, as a database rule.
--
-- You can always read your own answer. You can read your partner's only once you
-- have written yours. Until then the row is not filtered out of a payload by the
-- client — it is not in the payload. There is no request you can craft, no
-- devtools panel you can open, and no bug in the interface that can reveal it.
create policy couple_answers_select_after_answering on public.couple_answers
  for select to authenticated
  using (
    public.is_couple_prompt_member(prompt_id)
    and (
      user_id = (select auth.uid())
      or public.has_answered_prompt(prompt_id)
    )
  );

create policy couple_answers_insert_own on public.couple_answers
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.is_couple_prompt_member(prompt_id)
  );

create policy couple_answers_update_own on public.couple_answers
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
