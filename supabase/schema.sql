-- Mary's Cycle Tracker — Supabase schema.
--
-- Run this once against a DEDICATED Supabase project (not shared with any
-- other app — see README "Manual setup"). It creates three tables and locks
-- every one of them behind an email allow-list, so only signed-in Google
-- accounts on that list can read or write anything.
--
-- Safe to re-run: policies and triggers are dropped before being recreated,
-- since Postgres has no CREATE POLICY IF NOT EXISTS. Re-running never touches
-- logged data — only the table/policy definitions.

-- ── allowed_emails ──────────────────────────────────────────────────────
-- The access control list. Adding or removing a person is a plain INSERT/
-- DELETE — no code change, no redeploy.
create table if not exists allowed_emails (
  email text primary key
);

alter table allowed_emails enable row level security;

-- Only an already-allowed signed-in user can see who else is allowed.
drop policy if exists "allowed users can read the allow-list" on allowed_emails;
create policy "allowed users can read the allow-list"
  on allowed_emails for select
  using (exists (
    select 1 from allowed_emails a where a.email = auth.jwt() ->> 'email'
  ));

-- Seed with Mary's and Roger's Google account emails before anyone signs in.
-- insert into allowed_emails (email) values ('mary@example.com'), ('roger@example.com');

-- ── cycle_entries ───────────────────────────────────────────────────────
-- One row per logged event: a period start, a period end, or a note
-- (spotting, symptom, etc). Deliberately just three meaningful columns so
-- the schema stays as easy to read and modify as DoingTheDoings.
create table if not exists cycle_entries (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null,
  entry_type text not null check (entry_type in ('period_start', 'period_end', 'note')),
  notes text,
  created_by text not null default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cycle_entries_occurred_at_idx on cycle_entries (occurred_at desc);

alter table cycle_entries enable row level security;

drop policy if exists "allowed users can read entries" on cycle_entries;
create policy "allowed users can read entries"
  on cycle_entries for select
  using (exists (select 1 from allowed_emails a where a.email = auth.jwt() ->> 'email'));

drop policy if exists "allowed users can insert entries" on cycle_entries;
create policy "allowed users can insert entries"
  on cycle_entries for insert
  with check (exists (select 1 from allowed_emails a where a.email = auth.jwt() ->> 'email'));

drop policy if exists "allowed users can update entries" on cycle_entries;
create policy "allowed users can update entries"
  on cycle_entries for update
  using (exists (select 1 from allowed_emails a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowed_emails a where a.email = auth.jwt() ->> 'email'));

drop policy if exists "allowed users can delete entries" on cycle_entries;
create policy "allowed users can delete entries"
  on cycle_entries for delete
  using (exists (select 1 from allowed_emails a where a.email = auth.jwt() ->> 'email'));

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists cycle_entries_set_updated_at on cycle_entries;
create trigger cycle_entries_set_updated_at
  before update on cycle_entries
  for each row execute function set_updated_at();

-- ── cycle_settings ──────────────────────────────────────────────────────
-- A single settings row (id is always 1) so the average-cycle-length
-- override and the anomaly-detection tuning are editable in place, the
-- same low-ceremony pattern DoingTheDoings uses for its own settings.
create table if not exists cycle_settings (
  id int primary key default 1 check (id = 1),
  average_override numeric,
  sd_multiplier numeric not null default 2.0,
  updated_at timestamptz not null default now()
);

insert into cycle_settings (id) values (1) on conflict (id) do nothing;

alter table cycle_settings enable row level security;

drop policy if exists "allowed users can read settings" on cycle_settings;
create policy "allowed users can read settings"
  on cycle_settings for select
  using (exists (select 1 from allowed_emails a where a.email = auth.jwt() ->> 'email'));

drop policy if exists "allowed users can update settings" on cycle_settings;
create policy "allowed users can update settings"
  on cycle_settings for update
  using (exists (select 1 from allowed_emails a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowed_emails a where a.email = auth.jwt() ->> 'email'));

drop trigger if exists cycle_settings_set_updated_at on cycle_settings;
create trigger cycle_settings_set_updated_at
  before update on cycle_settings
  for each row execute function set_updated_at();
