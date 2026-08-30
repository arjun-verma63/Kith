-- =============================================================================
-- KITH — 0008 · Notifications
--
-- A notification is something the system says to you. It follows that no client
-- may create one: there is a SELECT policy and an UPDATE policy (for marking
-- read), and no INSERT policy at all. Rows arrive from database triggers running
-- as SECURITY DEFINER, or from the service role.
--
-- Without that rule, any account could write a notification into any other
-- account's feed — a spam channel and a phishing surface, delivered by the
-- product itself.
-- =============================================================================

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind public.notification_kind not null,

  -- Who caused it. SET NULL so a deleted account does not take the notification
  -- with it and leave a gap in somebody's history.
  actor_id uuid references public.profiles (id) on delete set null,

  -- Enough to render and route the notification without a join per row:
  -- conversation id, call id, session id, a preview string.
  payload jsonb not null default '{}'::jsonb,

  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- The unread badge, and the notification list. Partial on unread because that is
-- the query that runs on every page load.
create index notifications_unread_idx
  on public.notifications (user_id, created_at desc)
  where read_at is null;

create index notifications_actor_idx
  on public.notifications (actor_id)
  where actor_id is not null;

create index notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Delivery
--
-- Notifications are raised by triggers rather than by the application, for the
-- same reason `updated_at` is: a code path cannot forget, and a client cannot
-- lie about who the actor was. SECURITY DEFINER because the table has no INSERT
-- policy — which is the point.
-- -----------------------------------------------------------------------------

create or replace function public.notify_friend_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notifications (user_id, kind, actor_id, payload)
  values (
    new.addressee_id,
    'friend_request',
    new.requester_id,
    jsonb_build_object('request_id', new.id)
  );

  return new;
end;
$$;

create trigger friend_request_notify
  after insert on public.friend_requests
  for each row
  when (new.status = 'pending')
  execute function public.notify_friend_request();

create or replace function public.notify_friend_accepted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'accepted' and old.status = 'pending' then
    insert into public.notifications (user_id, kind, actor_id, payload)
    values (
      new.requester_id,
      'friend_accepted',
      new.addressee_id,
      jsonb_build_object('request_id', new.id)
    );
  end if;

  return new;
end;
$$;

create trigger friend_request_accepted_notify
  after update on public.friend_requests
  for each row execute function public.notify_friend_accepted();

-- =============================================================================
-- Row Level Security
-- =============================================================================

alter table public.notifications enable row level security;
alter table public.notifications force row level security;

create policy notifications_select_own on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Marking read. The WITH CHECK repeats the ownership test so an update cannot
-- reassign the row to somebody else on its way through.
create policy notifications_update_own on public.notifications
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy notifications_delete_own on public.notifications
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- No INSERT policy, deliberately. See the header.
