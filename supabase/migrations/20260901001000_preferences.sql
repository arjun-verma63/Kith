-- =============================================================================
-- KITH — 0027 · Preferences
--
-- `user_settings` has carried nine columns since migration 0002. Four of them
-- are read by policies. Three were still read by nothing at all:
--
--   notification_prefs   every notification was delivered regardless
--   theme / motion       the theme lived in localStorage; motion was a comment
--                        in tokens.css saying "Settings → Appearance, Phase 2"
--
-- A settings page whose switches do nothing is worse than a settings page that
-- does not exist, so this migration is what makes the notification section real.
-- The appearance section is made real in CSS, which is the right place for it —
-- see the note at the bottom.
--
-- It also adds the one profile-visibility control that is worth having.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 · show_birthday
--
-- Of everything on a profile, the birthday is the only field that is properly
-- personal: a full date of birth is the answer to a security question somewhere
-- else. Bio and pronouns are things people wrote in order to be read.
--
-- So this is the one that gets a scope, rather than giving every field a control
-- nobody will ever touch.
-- -----------------------------------------------------------------------------
alter table public.user_settings
  add column if not exists show_birthday public.permission_scope not null default 'friends';

comment on column public.user_settings.show_birthday is
  'Who may see the birthday on this person''s profile. Enforced in get_profile, not by the client omitting it.';

-- -----------------------------------------------------------------------------
-- 2 · get_profile
--
-- A profile read that can redact.
--
-- `profiles_select` is a ROW policy — it decides whether you see the row, and
-- has no way to hide one column of it from one viewer. Redacting in TypeScript
-- would put the rule in the one place the profile query file says rules must not
-- live, so the read moves behind a function instead.
--
-- Three rules, in one place:
--   · the block rule, unchanged in effect from `profiles_select`
--   · the birthday scope
--   · a deleted account, which resolves by id for old messages but should not be
--     browsable by name
-- -----------------------------------------------------------------------------
create or replace function public.get_profile(p_username text)
returns table (
  id uuid,
  username text,
  display_name text,
  avatar_path text,
  bio text,
  pronouns text,
  accent public.profile_accent,
  status public.presence_status,
  status_text text,
  status_expires_at timestamptz,
  birthday date,
  last_seen_at timestamptz,
  created_at timestamptz,
  deleted_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    p.username,
    p.display_name,
    p.avatar_path,
    p.bio,
    p.pronouns,
    p.accent,
    p.status,
    p.status_text,
    p.status_expires_at,
    -- The redaction. Your own birthday is always yours to see.
    case
      when p.id = (select auth.uid()) then p.birthday
      when s.show_birthday = 'everyone' then p.birthday
      when s.show_birthday = 'friends' and public.are_friends(p.id) then p.birthday
      else null
    end,
    case when p.status = 'invisible' then null else p.last_seen_at end,
    p.created_at,
    p.deleted_at
  from public.profiles p
  left join public.user_settings s on s.user_id = p.id
  where lower(p.username) = lower(btrim(coalesce(p_username, '')))
    and (select auth.uid()) is not null
    -- Same effect as profiles_select. Repeated rather than inherited because
    -- SECURITY DEFINER bypasses the policy that would otherwise apply it.
    and (p.id = (select auth.uid()) or not public.is_blocked_either(p.id))
    -- A deleted account still resolves by id, so two-year-old messages render a
    -- name. It does not resolve by username, so it cannot be browsed to.
    and (p.deleted_at is null or p.id = (select auth.uid()));
$$;

comment on function public.get_profile(text) is
  'One profile by username, with the block rule, the birthday scope and the deleted-account rule applied. The only read path for somebody else''s profile.';

revoke execute on function public.get_profile(text) from public, anon;
grant execute on function public.get_profile(text) to authenticated;

-- -----------------------------------------------------------------------------
-- 3 · Notification preferences
--
-- ── One gate, not seven ──────────────────────────────────────────────────────
--
-- There are seven trigger functions that insert notifications, and there will be
-- more. Teaching each one to consult a preference means seven places to get it
-- right and one place to forget it in six months.
--
-- So the gate is a BEFORE INSERT trigger on `notifications` itself. Returning
-- NULL from it drops the row silently, which is exactly the semantics wanted:
-- the sender's action still succeeds, the recipient simply is not told. It works
-- for the set-based inserts the message trigger uses, it works for anything
-- added later, and it cannot be bypassed by a new trigger that does not know
-- about it.
--
-- ── Default on, explicit off ─────────────────────────────────────────────────
--
-- `notification_prefs` is `{}` for everybody today, and an absent key means on.
-- Only an explicit `false` suppresses. A default of off would mean shipping this
-- migration silently muted every notification in the app.
-- -----------------------------------------------------------------------------
create or replace function public.notification_enabled(
  p_user_id uuid,
  p_kind public.notification_kind
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    -- Never suppressible. `system` is how the app says something that is not
    -- about another person — an account action, a service notice — and a
    -- preference that can silence it is a preference that hides the one message
    -- somebody needs to see.
    p_kind = 'system'
    or coalesce(
      (
        select s.notification_prefs ->> p_kind::text
        from public.user_settings s
        where s.user_id = p_user_id
      ),
      'true'
    ) is distinct from 'false';
$$;

comment on function public.notification_enabled(uuid, public.notification_kind) is
  'Whether this person wants notifications of this kind. Absent means yes; only an explicit false suppresses. `system` is always yes.';

revoke execute on function public.notification_enabled(uuid, public.notification_kind)
  from public, anon;
grant execute on function public.notification_enabled(uuid, public.notification_kind)
  to authenticated, service_role;

create or replace function public.apply_notification_prefs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.notification_enabled(new.user_id, new.kind) then
    return new;
  end if;

  -- Dropped, not raised. The action that caused it must still succeed — muting
  -- game invites should not stop anybody starting a game.
  return null;
end;
$$;

drop trigger if exists notifications_apply_prefs on public.notifications;

create trigger notifications_apply_prefs
  before insert on public.notifications
  for each row execute function public.apply_notification_prefs();

-- Reading a preference on every insert is one index probe on the primary key of
-- a table with one row per account. Named here so the cost is on the record.

-- -----------------------------------------------------------------------------
-- 4 · Theme and motion need nothing here
--
-- Both columns already exist and neither is read by any policy, because neither
-- is a permission — they decide what a browser draws. The persistence is the
-- whole database side of it; the enforcement is CSS in `src/styles/tokens.css`,
-- and until this phase that CSS had a comment in it saying the setting was
-- coming. It does now.
--
-- `theme` has a third value, 'system', which the enum has always had and the
-- client never offered.
-- -----------------------------------------------------------------------------
