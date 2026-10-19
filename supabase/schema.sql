-- Squash tracker: database setup for Supabase.
--
-- Run this once in your Supabase project: Dashboard -> SQL Editor -> New query,
-- paste the whole file, and press Run.
--
-- BEFORE RUNNING: replace CHANGE-ME below with the group code you and your
-- friends will type on the site to add games. Do that in the Supabase editor
-- only, never in this file: this repository is public.
--
-- How access works:
--   * Anyone can READ players, sessions, attendance and games (the site is public).
--   * Nobody can write to the tables directly. All changes go through the
--     functions at the bottom, and each one checks the group code first.
--   * The code is stored hashed in the "private" schema, which the public API
--     cannot see.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Group code (private)
-- ---------------------------------------------------------------------------

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.settings (
  id        int  primary key default 1 check (id = 1),
  code_hash text not null
);

insert into private.settings (id, code_hash)
values (1, extensions.crypt('CHANGE-ME', extensions.gen_salt('bf')))
on conflict (id) do update set code_hash = excluded.code_hash;

-- To change the code later, run:
--   update private.settings
--   set code_hash = extensions.crypt('new-code', extensions.gen_salt('bf'));

create or replace function private.check_code(p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_code is null or not exists (
    select 1 from private.settings s
    where s.code_hash = extensions.crypt(p_code, s.code_hash)
  ) then
    raise exception 'Wrong group code' using errcode = '28000';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables (public, read-only for visitors)
-- ---------------------------------------------------------------------------

create table if not exists public.players (
  id            uuid        primary key default gen_random_uuid(),
  name          text        not null unique check (char_length(btrim(name)) between 1 and 40),
  is_subscriber boolean     not null default false,
  -- Start of this player's yearly subscription; null = no subscription.
  subscription_start date,
  active        boolean     not null default true,
  created_at    timestamptz not null default now()
);

-- One row per visit. slot decides what the visit is worth for break-even:
--   offpeak     weekend daytime / weekday 14-18 (pay-as-you-go: 10 euro p.p.)
--   fri_peak    Friday 18-22                     (pay-as-you-go: 14 euro p.p.)
--   fri_offpeak Friday outside peak              (subscribers only)
create table if not exists public.sessions (
  id         uuid        primary key default gen_random_uuid(),
  played_on  date        not null,
  slot       text        not null check (slot in ('offpeak', 'fri_peak', 'fri_offpeak')),
  note       text        check (char_length(note) <= 200),
  created_at timestamptz not null default now(),
  unique (played_on, slot)
);

create table if not exists public.attendance (
  session_id uuid not null references public.sessions (id) on delete cascade,
  player_id  uuid not null references public.players (id) on delete restrict,
  primary key (session_id, player_id)
);

-- One row per game (a game is usually to 11).
create table if not exists public.games (
  id         bigint      generated always as identity primary key,
  session_id uuid        not null references public.sessions (id) on delete cascade,
  player_a   uuid        not null references public.players (id) on delete restrict,
  player_b   uuid        not null references public.players (id) on delete restrict,
  score_a    smallint    not null check (score_a between 0 and 99),
  score_b    smallint    not null check (score_b between 0 and 99),
  -- Head start: the score a player starts on, e.g. 4 for "starts at 4-0".
  -- score_a/score_b are the final scoreboard, head start included.
  start_a    smallint    not null default 0,
  start_b    smallint    not null default 0,
  created_at timestamptz not null default now(),
  check (player_a <> player_b),
  check (score_a <> score_b),
  constraint games_head_start_check
    check (start_a between 0 and 10 and start_b between 0 and 10 and score_a >= start_a and score_b >= start_b)
);

create index if not exists games_session_idx on public.games (session_id);

alter table public.players    enable row level security;
alter table public.sessions   enable row level security;
alter table public.attendance enable row level security;
alter table public.games      enable row level security;

drop policy if exists "Anyone can read" on public.players;
drop policy if exists "Anyone can read" on public.sessions;
drop policy if exists "Anyone can read" on public.attendance;
drop policy if exists "Anyone can read" on public.games;
create policy "Anyone can read" on public.players    for select to anon, authenticated using (true);
create policy "Anyone can read" on public.sessions   for select to anon, authenticated using (true);
create policy "Anyone can read" on public.attendance for select to anon, authenticated using (true);
create policy "Anyone can read" on public.games      for select to anon, authenticated using (true);

revoke insert, update, delete, truncate on public.players, public.sessions, public.attendance, public.games
  from anon, authenticated;
grant select on public.players, public.sessions, public.attendance, public.games
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Write functions (called from the site, each checks the group code)
-- ---------------------------------------------------------------------------

create or replace function public.verify_code(p_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.check_code(p_code);
  return true;
exception when sqlstate '28000' then
  return false;
end;
$$;

-- Inserts games from JSON: [{"a": uuid, "b": uuid, "sa": 11, "sb": 7, "ha": 0, "hb": 4}, ...]
create or replace function private.insert_games(p_session_id uuid, p_games jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.games (session_id, player_a, player_b, score_a, score_b, start_a, start_b)
  select p_session_id, (g ->> 'a')::uuid, (g ->> 'b')::uuid, (g ->> 'sa')::smallint, (g ->> 'sb')::smallint,
         coalesce((g ->> 'ha')::smallint, 0), coalesce((g ->> 'hb')::smallint, 0)
  from jsonb_array_elements(coalesce(p_games, '[]'::jsonb)) with ordinality as t(g, n)
  order by n;

  -- Everyone who played a game was there.
  insert into public.attendance (session_id, player_id)
  select p_session_id, player_a from public.games where session_id = p_session_id
  union
  select p_session_id, player_b from public.games where session_id = p_session_id
  on conflict do nothing;
end;
$$;

revoke execute on function private.insert_games(uuid, jsonb) from public, anon, authenticated;

-- Logs a visit plus its games. Logging the same date and slot twice adds to
-- the existing session instead of creating a second one, so a visit is never
-- counted twice for break-even.
-- p_games: [{"a": "<player uuid>", "b": "<player uuid>", "sa": 11, "sb": 7}, ...]
create or replace function public.log_session(
  p_code       text,
  p_played_on  date,
  p_slot       text,
  p_player_ids uuid[],
  p_games      jsonb default '[]'::jsonb,
  p_note       text  default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.check_code(p_code);

  insert into public.sessions (played_on, slot, note)
  values (p_played_on, p_slot, nullif(btrim(p_note), ''))
  on conflict (played_on, slot)
    do update set note = coalesce(excluded.note, public.sessions.note)
  returning id into v_id;

  insert into public.attendance (session_id, player_id)
  select v_id, pid from unnest(coalesce(p_player_ids, '{}')) as pid
  on conflict do nothing;

  perform private.insert_games(v_id, p_games);
  return v_id;
end;
$$;

-- Replaces a session's date, slot, note, attendance and games in one go.
create or replace function public.update_session(
  p_code       text,
  p_id         uuid,
  p_played_on  date,
  p_slot       text,
  p_player_ids uuid[],
  p_games      jsonb default '[]'::jsonb,
  p_note       text  default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.check_code(p_code);

  if exists (
    select 1 from public.sessions
    where played_on = p_played_on and slot = p_slot and id <> p_id
  ) then
    raise exception 'There is already another session on that date and time slot.';
  end if;

  update public.sessions
  set played_on = p_played_on, slot = p_slot, note = nullif(btrim(p_note), '')
  where id = p_id;
  if not found then
    raise exception 'That session no longer exists.';
  end if;

  delete from public.games where session_id = p_id;
  delete from public.attendance where session_id = p_id;

  insert into public.attendance (session_id, player_id)
  select p_id, pid from unnest(coalesce(p_player_ids, '{}')) as pid
  on conflict do nothing;

  perform private.insert_games(p_id, p_games);
  return p_id;
end;
$$;

create or replace function public.delete_game(p_code text, p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.check_code(p_code);
  delete from public.games where id = p_id;
end;
$$;

create or replace function public.delete_session(p_code text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.check_code(p_code);
  delete from public.sessions where id = p_id;
end;
$$;

create or replace function public.remove_attendance(p_code text, p_session_id uuid, p_player_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.check_code(p_code);
  if exists (
    select 1 from public.games
    where session_id = p_session_id and p_player_id in (player_a, player_b)
  ) then
    raise exception 'This player has games in this session. Delete those games first.';
  end if;
  delete from public.attendance where session_id = p_session_id and player_id = p_player_id;
end;
$$;

-- Adds a player (p_id null) or updates one. A null start date means no subscription.
create or replace function public.save_player(
  p_code               text,
  p_id                 uuid,
  p_name               text,
  p_subscription_start date,
  p_active             boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.check_code(p_code);
  if p_id is null then
    insert into public.players (name, is_subscriber, subscription_start, active)
    values (btrim(p_name), p_subscription_start is not null, p_subscription_start, p_active)
    returning id into v_id;
  else
    update public.players
    set name = btrim(p_name),
        is_subscriber = p_subscription_start is not null,
        subscription_start = p_subscription_start,
        active = p_active
    where id = p_id
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

revoke execute on function private.check_code(text) from public, anon, authenticated;

revoke execute on function
  public.verify_code(text),
  public.log_session(text, date, text, uuid[], jsonb, text),
  public.update_session(text, uuid, date, text, uuid[], jsonb, text),
  public.delete_game(text, bigint),
  public.delete_session(text, uuid),
  public.remove_attendance(text, uuid, uuid),
  public.save_player(text, uuid, text, date, boolean)
from public;

grant execute on function
  public.verify_code(text),
  public.log_session(text, date, text, uuid[], jsonb, text),
  public.update_session(text, uuid, date, text, uuid[], jsonb, text),
  public.delete_game(text, bigint),
  public.delete_session(text, uuid),
  public.remove_attendance(text, uuid, uuid),
  public.save_player(text, uuid, text, date, boolean)
to anon, authenticated;
