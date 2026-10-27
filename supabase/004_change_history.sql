-- Update 004: change history, restore, and protection against overwriting.
--
-- Run once in Supabase: SQL Editor -> New query, paste this file, Run.
-- (A fresh install via schema.sql already includes this.)
--
-- What it adds:
--   * private.change_log: every change made through the site, with who made
--     it and a full snapshot of the session before and after. Nothing is
--     ever lost for good: any change can be restored from here.
--   * sessions.updated_at: editing a session is refused when someone else
--     changed it after the edit form was opened.
--   * public.list_changes and public.restore_change: see and undo changes
--     from the site (group code required).
--   * Every write function takes an optional p_actor: the name of whoever is
--     logging, so the history shows who did what.

alter table public.sessions add column if not exists updated_at timestamptz not null default now();

create table if not exists private.change_log (
  id         bigint      generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      text,
  action     text        not null,
  session_id uuid,
  before     jsonb,
  after      jsonb
);
create index if not exists change_log_session_idx on private.change_log (session_id);
revoke all on private.change_log from public, anon, authenticated;

-- Everything about one session as JSON (null when it doesn't exist).
create or replace function private.session_snapshot(p_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id,
    'played_on', s.played_on,
    'slot', s.slot,
    'note', s.note,
    'updated_at', s.updated_at,
    'attendance', coalesce((select jsonb_agg(a.player_id order by a.player_id) from public.attendance a where a.session_id = s.id), '[]'::jsonb),
    'games', coalesce((select jsonb_agg(jsonb_build_object(
        'a', g.player_a, 'b', g.player_b, 'sa', g.score_a, 'sb', g.score_b, 'ha', g.start_a, 'hb', g.start_b
      ) order by g.id) from public.games g where g.session_id = s.id), '[]'::jsonb)
  )
  from public.sessions s
  where s.id = p_id
$$;

create or replace function private.log_change(p_actor text, p_action text, p_session_id uuid, p_before jsonb, p_after jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.change_log (actor, action, session_id, before, after)
  values (nullif(btrim(p_actor), ''), p_action, p_session_id, p_before, p_after);
$$;

revoke execute on function private.session_snapshot(uuid) from public, anon, authenticated;
revoke execute on function private.log_change(text, text, uuid, jsonb, jsonb) from public, anon, authenticated;

-- Replace the write functions with versions that record history.
drop function if exists public.log_session(text, date, text, uuid[], jsonb, text);
drop function if exists public.update_session(text, uuid, date, text, uuid[], jsonb, text);
drop function if exists public.delete_game(text, bigint);
drop function if exists public.delete_session(text, uuid);
drop function if exists public.remove_attendance(text, uuid, uuid);
drop function if exists public.save_player(text, uuid, text, date, boolean);

-- Logs a visit plus its games. Logging the same date and slot twice adds to
-- the existing session instead of creating a second one.
create or replace function public.log_session(
  p_code       text,
  p_played_on  date,
  p_slot       text,
  p_player_ids uuid[],
  p_games      jsonb default '[]'::jsonb,
  p_note       text  default null,
  p_actor      text  default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_before jsonb;
begin
  perform private.check_code(p_code);

  select id into v_id from public.sessions where played_on = p_played_on and slot = p_slot;
  if v_id is not null then
    v_before := private.session_snapshot(v_id);
  end if;

  insert into public.sessions (played_on, slot, note)
  values (p_played_on, p_slot, nullif(btrim(p_note), ''))
  on conflict (played_on, slot)
    do update set note = coalesce(excluded.note, public.sessions.note), updated_at = now()
  returning id into v_id;

  insert into public.attendance (session_id, player_id)
  select v_id, pid from unnest(coalesce(p_player_ids, '{}')) as pid
  on conflict do nothing;

  perform private.insert_games(v_id, p_games);
  perform private.log_change(p_actor, case when v_before is null then 'create' else 'add' end, v_id, v_before, private.session_snapshot(v_id));
  return v_id;
end;
$$;

-- Replaces a session's date, slot, note, attendance and games in one go.
-- p_expected_updated is the session's updated_at when the edit form was
-- opened; if the session changed since, nothing is saved.
create or replace function public.update_session(
  p_code              text,
  p_id                uuid,
  p_played_on         date,
  p_slot              text,
  p_player_ids        uuid[],
  p_games             jsonb       default '[]'::jsonb,
  p_note              text        default null,
  p_actor             text        default null,
  p_expected_updated  timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before  jsonb;
  v_updated timestamptz;
begin
  perform private.check_code(p_code);

  select updated_at into v_updated from public.sessions where id = p_id for update;
  if not found then
    raise exception 'That session no longer exists.';
  end if;
  if p_expected_updated is not null and v_updated is distinct from p_expected_updated then
    raise exception 'This session was changed by someone else after you opened it. Reload the page and try again.';
  end if;
  if exists (
    select 1 from public.sessions
    where played_on = p_played_on and slot = p_slot and id <> p_id
  ) then
    raise exception 'There is already another session on that date and time slot.';
  end if;

  v_before := private.session_snapshot(p_id);

  update public.sessions
  set played_on = p_played_on, slot = p_slot, note = nullif(btrim(p_note), ''), updated_at = now()
  where id = p_id;

  delete from public.games where session_id = p_id;
  delete from public.attendance where session_id = p_id;

  insert into public.attendance (session_id, player_id)
  select p_id, pid from unnest(coalesce(p_player_ids, '{}')) as pid
  on conflict do nothing;

  perform private.insert_games(p_id, p_games);
  perform private.log_change(p_actor, 'edit', p_id, v_before, private.session_snapshot(p_id));
  return p_id;
end;
$$;

create or replace function public.delete_game(p_code text, p_id bigint, p_actor text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session uuid;
  v_before  jsonb;
begin
  perform private.check_code(p_code);
  select session_id into v_session from public.games where id = p_id;
  if v_session is null then return; end if;
  v_before := private.session_snapshot(v_session);
  delete from public.games where id = p_id;
  update public.sessions set updated_at = now() where id = v_session;
  perform private.log_change(p_actor, 'delete game', v_session, v_before, private.session_snapshot(v_session));
end;
$$;

create or replace function public.delete_session(p_code text, p_id uuid, p_actor text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
begin
  perform private.check_code(p_code);
  v_before := private.session_snapshot(p_id);
  if v_before is null then return; end if;
  delete from public.sessions where id = p_id;
  perform private.log_change(p_actor, 'delete', p_id, v_before, null);
end;
$$;

create or replace function public.remove_attendance(p_code text, p_session_id uuid, p_player_id uuid, p_actor text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
begin
  perform private.check_code(p_code);
  if exists (
    select 1 from public.games
    where session_id = p_session_id and p_player_id in (player_a, player_b)
  ) then
    raise exception 'This player has games in this session. Delete those games first.';
  end if;
  v_before := private.session_snapshot(p_session_id);
  delete from public.attendance where session_id = p_session_id and player_id = p_player_id;
  update public.sessions set updated_at = now() where id = p_session_id;
  perform private.log_change(p_actor, 'remove person', p_session_id, v_before, private.session_snapshot(p_session_id));
end;
$$;

-- Adds a player (p_id null) or updates one. A null start date means no subscription.
create or replace function public.save_player(
  p_code               text,
  p_id                 uuid,
  p_name               text,
  p_subscription_start date,
  p_active             boolean default true,
  p_actor              text    default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_before jsonb;
begin
  perform private.check_code(p_code);
  if p_id is null then
    insert into public.players (name, is_subscriber, subscription_start, active)
    values (btrim(p_name), p_subscription_start is not null, p_subscription_start, p_active)
    returning id into v_id;
  else
    select to_jsonb(p) into v_before from public.players p where p.id = p_id;
    update public.players
    set name = btrim(p_name),
        is_subscriber = p_subscription_start is not null,
        subscription_start = p_subscription_start,
        active = p_active
    where id = p_id
    returning id into v_id;
  end if;
  perform private.log_change(p_actor, case when p_id is null then 'add player' else 'edit player' end, null, v_before,
    (select to_jsonb(p) from public.players p where p.id = v_id));
  return v_id;
end;
$$;

-- The most recent changes, newest first.
create or replace function public.list_changes(p_code text, p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.check_code(p_code);
  return coalesce((
    select jsonb_agg(to_jsonb(c) order by c.id desc)
    from (select * from private.change_log order by id desc limit least(greatest(p_limit, 1), 200)) c
  ), '[]'::jsonb);
end;
$$;

-- Puts a session back exactly as it was before the given change.
-- (Restoring a 'create' removes the session again.)
create or replace function public.restore_change(p_code text, p_change_id bigint, p_actor text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_change  private.change_log;
  v_id      uuid;
  v_snap    jsonb;
  v_current jsonb;
begin
  perform private.check_code(p_code);
  select * into v_change from private.change_log where id = p_change_id;
  if not found or v_change.session_id is null then
    raise exception 'There is nothing to restore for that change.';
  end if;
  v_id := v_change.session_id;
  v_snap := v_change.before;
  v_current := private.session_snapshot(v_id);

  if v_snap is null then
    -- The change created this session: restoring means removing it.
    delete from public.sessions where id = v_id;
    perform private.log_change(p_actor, 'restore', v_id, v_current, null);
    return v_id;
  end if;

  if exists (
    select 1 from public.sessions
    where played_on = (v_snap ->> 'played_on')::date and slot = v_snap ->> 'slot' and id <> v_id
  ) then
    raise exception 'Another session now exists on that date and time slot. Delete or move it first.';
  end if;

  insert into public.sessions (id, played_on, slot, note, updated_at)
  values (v_id, (v_snap ->> 'played_on')::date, v_snap ->> 'slot', v_snap ->> 'note', now())
  on conflict (id) do update
    set played_on = excluded.played_on, slot = excluded.slot, note = excluded.note, updated_at = now();

  delete from public.games where session_id = v_id;
  delete from public.attendance where session_id = v_id;

  insert into public.attendance (session_id, player_id)
  select v_id, value::uuid from jsonb_array_elements_text(coalesce(v_snap -> 'attendance', '[]'::jsonb))
  on conflict do nothing;

  perform private.insert_games(v_id, v_snap -> 'games');
  perform private.log_change(p_actor, 'restore', v_id, v_current, private.session_snapshot(v_id));
  return v_id;
end;
$$;

revoke execute on function
  public.log_session(text, date, text, uuid[], jsonb, text, text),
  public.update_session(text, uuid, date, text, uuid[], jsonb, text, text, timestamptz),
  public.delete_game(text, bigint, text),
  public.delete_session(text, uuid, text),
  public.remove_attendance(text, uuid, uuid, text),
  public.save_player(text, uuid, text, date, boolean, text),
  public.list_changes(text, int),
  public.restore_change(text, bigint, text)
from public;

grant execute on function
  public.log_session(text, date, text, uuid[], jsonb, text, text),
  public.update_session(text, uuid, date, text, uuid[], jsonb, text, text, timestamptz),
  public.delete_game(text, bigint, text),
  public.delete_session(text, uuid, text),
  public.remove_attendance(text, uuid, uuid, text),
  public.save_player(text, uuid, text, date, boolean, text),
  public.list_changes(text, int),
  public.restore_change(text, bigint, text)
to anon, authenticated;
