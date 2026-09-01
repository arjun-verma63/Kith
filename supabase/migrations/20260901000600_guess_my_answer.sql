-- =============================================================================
-- KITH — 0023 · Guess My Answer
--
-- The second couple game, and the first that needs to be configured before it
-- starts: the pair choose which category of questions they are in the mood for.
--
-- Which means `create_couple_game` needs a config, something no game has wanted
-- until now. `game_sessions.config` has existed since migration 0007 for exactly
-- this and has been empty ever since.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- create_couple_game, with config
--
-- The signature changes, so the old one goes. Config is opaque to Postgres by
-- design — it is the engine's, and a database that understood it would be a
-- database that had to be migrated every time a game gained an option.
--
-- Size-capped, though. It arrives from a browser, it is stored, and it is sent
-- to both players on every broadcast; a client that could put a megabyte in
-- there would have found a cheap way to make every round slow.
-- -----------------------------------------------------------------------------
drop function if exists public.create_couple_game(uuid, text, uuid);

create function public.create_couple_game(
  p_couple_id uuid,
  p_game_key text,
  p_config jsonb default '{}'::jsonb,
  p_rematch_of uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  partner uuid;
  existing uuid;
  new_session uuid;
  config jsonb := coalesce(p_config, '{}'::jsonb);
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if not public.is_couple_member(p_couple_id) then
    raise exception 'not_permitted' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.couples c where c.id = p_couple_id and c.status = 'active'
  ) then
    raise exception 'not_active' using errcode = '55006';
  end if;

  if not exists (
    select 1 from public.games g
    where g.key = p_game_key and g.enabled and g.audience = 'couple'
  ) then
    raise exception 'game_unavailable' using errcode = '22023';
  end if;

  if length(config::text) > 2000 then
    raise exception 'config_too_large' using errcode = '22023';
  end if;

  select case when c.user_low = me then c.user_high else c.user_low end
    into partner
  from public.couples c where c.id = p_couple_id;

  perform public.abandon_stale_games();
  perform pg_advisory_xact_lock(hashtext('kith.couple-game:' || p_couple_id::text || ':' || p_game_key));

  select s.id into existing
  from public.game_sessions s
  where s.couple_id = p_couple_id
    and s.game_key = p_game_key
    and s.status in ('lobby', 'active')
  order by s.created_at desc
  limit 1;

  if existing is not null then
    return existing;
  end if;

  insert into public.game_sessions (game_key, couple_id, host_id, status, config, rematch_of)
  values (p_game_key, p_couple_id, me, 'lobby', config, p_rematch_of)
  returning id into new_session;

  insert into public.game_players (session_id, user_id, seat)
  values (new_session, me, 0), (new_session, partner, 1);

  return new_session;
end;
$$;

revoke execute on function public.create_couple_game(uuid, text, jsonb, uuid) from public, anon;
grant execute on function public.create_couple_game(uuid, text, jsonb, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- The game.
--
-- `realtime`: both of you answer at once, and neither sees anything until all
-- four submissions are in.
-- -----------------------------------------------------------------------------
insert into public.games (key, name, tagline, audience, pace, min_players, max_players, enabled)
values (
  'guess-my-answer',
  'Guess My Answer',
  'Both of you answer. Both of you predict. Then look.',
  'couple',
  'realtime',
  2,
  2,
  true
)
on conflict (key) do update
  set name = excluded.name,
      tagline = excluded.tagline,
      pace = excluded.pace,
      min_players = excluded.min_players,
      max_players = excluded.max_players,
      enabled = excluded.enabled;
