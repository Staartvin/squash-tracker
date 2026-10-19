-- Update 002: each player has their own subscription start date.
--
-- Run once in Supabase: SQL Editor -> New query, paste this file, Run.
-- (A fresh install via schema.sql already includes this.)
--
-- A subscriber's year runs from their start date, so break-even is measured
-- per person. An empty date means "no subscription".

alter table public.players add column if not exists subscription_start date;

-- Existing subscribers started with the first group subscription.
update public.players
set subscription_start = date '2026-10-03'
where is_subscriber and subscription_start is null;

drop function if exists public.save_player(text, uuid, text, boolean, boolean);

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

revoke execute on function public.save_player(text, uuid, text, date, boolean) from public;
grant execute on function public.save_player(text, uuid, text, date, boolean) to anon, authenticated;
