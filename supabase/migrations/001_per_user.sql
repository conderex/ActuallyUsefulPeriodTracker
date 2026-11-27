-- ────────────────────────────────────────────────────────────────────────
-- Migration 001: Per-user authentication and data isolation.
--
-- BEFORE: one shared database, gated by an allowed_emails allow-list that
--   every RLS policy consulted via is_allowed_user(). The whole app was
--   effectively one tenant.
--
-- AFTER: every user data table carries a user_id tied to auth.users, and
--   RLS enforces row-level ownership (auth.uid() = user_id). The client
--   issues normal queries; Postgres auto-scopes them. The client NEVER
--   adds "where user_id = ..." — if it did, a bug there would be a data
--   leak. Server-side enforcement is the point.
--
-- MARY'S DATA: preserved by backfilling her user_id onto her existing
--   cycle_entries and cycle_settings rows. Nothing is deleted or moved.
--
-- ROLLBACK SAFETY: the allowed_emails table and is_allowed_user() stay
--   in place but unused. If the new model misbehaves, the old policies
--   can be restored from supabase/schema.sql without data loss. A later
--   cleanup migration drops them once we're confident.
--
-- RUN: paste into the Supabase SQL editor and execute. The whole script
--   is wrapped in a single transaction — on any error, nothing changes.
--   Safe to re-run.
-- ────────────────────────────────────────────────────────────────────────

begin;

-- Fail fast if Mary is not in auth.users: we have nothing to backfill to,
-- and silently leaving user_id NULL on her rows would hide them from her
-- the moment the new RLS policies go live.
do $$
begin
  if not exists (select 1 from auth.users where email = 'maryhaney9@gmail.com') then
    raise exception 'maryhaney9@gmail.com not found in auth.users. Aborting; the migration backfills her existing rows and needs her uuid.';
  end if;
end $$;

-- ── cycle_entries: add user_id, backfill, lock in ──────────────────────

alter table public.cycle_entries
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

update public.cycle_entries
set user_id = (select id from auth.users where email = 'maryhaney9@gmail.com')
where user_id is null;

alter table public.cycle_entries
  alter column user_id set not null,
  alter column user_id set default auth.uid();

create index if not exists cycle_entries_user_id_idx
  on public.cycle_entries (user_id, occurred_at desc);

-- Drop the allow-list policies, then install owner-based ones. There is a
-- brief moment between the drops and creates where only the transaction
-- holds the gate; since we're inside a transaction nothing outside this
-- script can observe it.
drop policy if exists "allowed users can read entries"   on public.cycle_entries;
drop policy if exists "allowed users can insert entries" on public.cycle_entries;
drop policy if exists "allowed users can update entries" on public.cycle_entries;
drop policy if exists "allowed users can delete entries" on public.cycle_entries;

drop policy if exists "own entries read"   on public.cycle_entries;
create policy "own entries read" on public.cycle_entries
  for select using (user_id = auth.uid());

drop policy if exists "own entries insert" on public.cycle_entries;
create policy "own entries insert" on public.cycle_entries
  for insert with check (user_id = auth.uid());

drop policy if exists "own entries update" on public.cycle_entries;
create policy "own entries update" on public.cycle_entries
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own entries delete" on public.cycle_entries;
create policy "own entries delete" on public.cycle_entries
  for delete using (user_id = auth.uid());

-- ── cycle_settings: single-row to per-user ────────────────────────────

alter table public.cycle_settings
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

update public.cycle_settings
set user_id = (select id from auth.users where email = 'maryhaney9@gmail.com')
where user_id is null;

-- Old shape: single row with PK id=1. New shape: PK is user_id.
alter table public.cycle_settings drop constraint if exists cycle_settings_pkey;
alter table public.cycle_settings drop constraint if exists cycle_settings_id_check;
alter table public.cycle_settings drop column if exists id;

alter table public.cycle_settings
  alter column user_id set not null,
  alter column user_id set default auth.uid();

alter table public.cycle_settings
  add constraint cycle_settings_pkey primary key (user_id);

drop policy if exists "allowed users can read settings"   on public.cycle_settings;
drop policy if exists "allowed users can update settings" on public.cycle_settings;

drop policy if exists "own settings read"   on public.cycle_settings;
create policy "own settings read" on public.cycle_settings
  for select using (user_id = auth.uid());

drop policy if exists "own settings insert" on public.cycle_settings;
create policy "own settings insert" on public.cycle_settings
  for insert with check (user_id = auth.uid());

drop policy if exists "own settings update" on public.cycle_settings;
create policy "own settings update" on public.cycle_settings
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── user_profiles: new table for per-user scene preferences ───────────
-- scene_preference is PURELY aesthetic landscape decoration, not avatar
-- or identity. The column is named for the scene it decorates rather
-- than for the animal itself, so no future UI copy accidentally frames
-- it as a mascot.
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  scene_preference text not null default 'plesiosaur' check (
    scene_preference in ('plesiosaur', 'trex', 'stegosaurus', 'brachiosaurus')
  ),
  scene_time_mode text not null default 'auto' check (
    scene_time_mode in ('auto', 'day', 'night')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

drop policy if exists "own profile read"   on public.user_profiles;
create policy "own profile read" on public.user_profiles
  for select using (user_id = auth.uid());

drop policy if exists "own profile insert" on public.user_profiles;
create policy "own profile insert" on public.user_profiles
  for insert with check (user_id = auth.uid());

drop policy if exists "own profile update" on public.user_profiles;
create policy "own profile update" on public.user_profiles
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop trigger if exists user_profiles_set_updated_at on public.user_profiles;
create trigger user_profiles_set_updated_at
  before update on public.user_profiles
  for each row execute function set_updated_at();

-- ── grants ────────────────────────────────────────────────────────────

grant select, insert, update, delete on public.user_profiles to authenticated;

-- ── auto-provision profile and settings for new signups ───────────────
-- The client never has to check "does my settings row exist yet"; the
-- trigger has already created it by the time onAuthStateChange fires.
-- SECURITY DEFINER so the insert bypasses the RLS policies above (which
-- would otherwise reject it: auth.uid() is NULL during a trigger from
-- the auth schema).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into public.user_profiles (user_id) values (new.id)
    on conflict (user_id) do nothing;
  insert into public.cycle_settings (user_id) values (new.id)
    on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── seed profile + settings for the two existing accounts ─────────────
-- Mary's cycle_settings row was backfilled above (the old id=1 row now
-- carries her user_id). She just needs a user_profiles row. Roger has
-- nothing yet, so seed both for him.

insert into public.user_profiles (user_id)
  select id from auth.users
  where email in ('maryhaney9@gmail.com', 'rogerthatheart@gmail.com')
  on conflict (user_id) do nothing;

insert into public.cycle_settings (user_id)
  select id from auth.users
  where email = 'rogerthatheart@gmail.com'
  on conflict (user_id) do nothing;

-- ── delete_user(): self-service account deletion ──────────────────────
-- Called from the client as sb.rpc('delete_user'). SECURITY DEFINER so
-- it can touch auth.users, which authenticated normally can't. Scoped
-- strictly to auth.uid() so a caller can never delete anyone else, and
-- explicit guard against an unauthenticated session calling it.
--
-- ON DELETE CASCADE on the user_id FKs means `delete from auth.users`
-- would clean up cycle_entries, cycle_settings and user_profiles on
-- its own, but we do it explicitly so the function is self-documenting
-- and audit-friendly.
create or replace function public.delete_user()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  delete from public.cycle_entries where user_id = uid;
  delete from public.cycle_settings where user_id = uid;
  delete from public.user_profiles where user_id = uid;
  delete from auth.users where id = uid;
end $$;

revoke all on function public.delete_user() from public;
grant execute on function public.delete_user() to authenticated;

commit;

-- ── verification queries (run separately after the migration) ─────────
--
-- Expect zero unassigned entries:
--   select count(*) as orphans from cycle_entries where user_id is null;
--
-- Mary's uuid should own her full history:
--   select user_id, count(*) from cycle_entries group by user_id;
--
-- Two profile rows (Mary, Roger), both with scene_preference = 'plesiosaur':
--   select * from user_profiles;
--
-- Two settings rows (Mary's with her data, Roger's blank):
--   select * from cycle_settings;
