-- Update 003: head starts (handicaps) per game, and editing a whole session.
--
-- Run once in Supabase: SQL Editor -> New query, paste this file, Run.
-- (A fresh install via schema.sql already includes this.)

-- A head start is the score a player starts the game on, e.g. 4 for "starts at 4-0".
-- score_a/score_b stay the final scoreboard, head start included.
alter table public.games add column if not exists start_a smallint not null default 0;
alter table public.games add column if not exists start_b smallint not null default 0;

alter table public.games drop constraint if exists games_head_start_check;
alter table public.games add constraint games_head_start_check
  check (start_a between 0 and 10 and start_b between 0 and 10 and score_a >= start_a and score_b >= start_b);

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
-- the existing session instead of creating a second one.
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

revoke execute on function public.update_session(text, uuid, date, text, uuid[], jsonb, text) from public;
grant execute on function public.update_session(text, uuid, date, text, uuid[], jsonb, text) to anon, authenticated;
