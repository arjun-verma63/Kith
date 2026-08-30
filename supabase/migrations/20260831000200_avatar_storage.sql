-- =============================================================================
-- KITH — 0012 · Avatar storage
--
-- The `avatars` bucket and its policies.
--
-- THE BUCKET IS PRIVATE. There are no public buckets in KITH.
--
-- A public bucket is tempting here — avatars are small, everybody in the room
-- can see everybody, and public URLs are stable and cacheable. But "public" in
-- Supabase means the object URL works for anyone who ever sees it, forever, with
-- no relationship to whether they are still a member. Someone who leaves, or is
-- blocked, or was never here at all keeps a working link to every avatar they
-- ever loaded. For a product whose entire proposition is "nobody gets in", that
-- is the wrong default even for a 200px portrait.
--
-- So: private bucket, short-lived signed URLs minted per request. The cost is
-- one signing call per profile render, which at six people is nothing.
--
-- Policies key on the FIRST PATH SEGMENT being the owner's user id
-- (`avatars/<uuid>/<file>`). That is why the path layout is a security decision
-- rather than a filing preference — `storage.foldername(name)[1]` is the only
-- handle a policy has on where an object lives.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  false,
  2097152, -- 2 MiB. Enforced by Storage itself, not just by the client.
  array['image/webp', 'image/jpeg', 'image/png']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- -----------------------------------------------------------------------------
-- Policies
--
-- Supabase enables RLS on storage.objects by default; these add the rules.
-- Written per-operation rather than as one FOR ALL policy, because read and
-- write have genuinely different audiences: everybody in the room may look at an
-- avatar, only its owner may replace it.
-- -----------------------------------------------------------------------------

-- Read: any signed-in member, subject to the block check. Someone you have
-- blocked cannot fetch your picture, and you cannot fetch theirs — the same
-- symmetry the profiles table uses, applied to the file.
create policy "avatars are readable by members"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'avatars'
    and not public.is_blocked_either(((storage.foldername(name))[1])::uuid)
  );

-- Write: your own folder only. The first path segment must be your user id, so
-- there is no filename a client can construct that lands in somebody else's
-- prefix.
create policy "avatars are writable by their owner"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "avatars are replaceable by their owner"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Delete matters as much as insert: without it, replacing an avatar leaves the
-- old object behind forever, and the bucket grows without bound.
create policy "avatars are deletable by their owner"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
