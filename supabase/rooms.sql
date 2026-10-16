-- Find Aircraft: play against a friend.
--
-- Run this once in the Supabase SQL editor, after schema.sql. It is safe to
-- run again.
--
-- A room has a four-letter code and lasts three hours. Each round:
--   1. both players hide two different aircraft on their own grid (60 s),
--   2. each searches the other's grid (5 min),
--   3. whoever finds both cockpits in fewer shots wins.
--
-- The rooms table, like players, has row level security with no policies, so
-- the public key cannot read it. Hidden layouts never leave the database while
-- a round is being played: every shot is judged here.

create table if not exists public.rooms (
  code            text primary key check (code ~ '^[A-Z]{4}$'),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '3 hours',
  round           integer not null default 1,
  host_secret     uuid not null default gen_random_uuid(),
  host_name       text not null,
  guest_secret    uuid,
  guest_name      text,
  -- { "planes": [{shape, dir, r, c}, ...], "cells": [{r, c, h, p}, ...] }
  host_layout     jsonb,
  guest_layout    jsonb,
  place_deadline  timestamptz,
  play_deadline   timestamptz,
  -- Shots taken BY that player, on the other player's grid: [{r, c, t}, ...]
  host_shots      jsonb not null default '[]',
  guest_shots     jsonb not null default '[]',
  -- Shot count at which that player found both cockpits.
  host_done       integer,
  guest_done      integer,
  finished_at     timestamptz,
  result          jsonb
);

alter table public.rooms enable row level security;
revoke all on table public.rooms from anon, authenticated;

-- Aircraft shapes, nose up, as [row, column] offsets from the cockpit.
-- Must match SHAPES in js/game.js.
create or replace function public.fa_shape_offsets(p_shape text)
returns jsonb
language sql
immutable
as $$
  select case p_shape
    when 'classic'  then '[[0,0],[1,-2],[1,-1],[1,0],[1,1],[1,2],[2,0],[3,-1],[3,0],[3,1]]'::jsonb
    when 'delta'    then '[[0,0],[1,-1],[1,0],[1,1],[2,-2],[2,-1],[2,0],[2,1],[2,2],[3,0]]'::jsonb
    when 'airliner' then '[[0,0],[1,0],[2,-2],[2,-1],[2,0],[2,1],[2,2],[3,0],[4,-1],[4,0],[4,1]]'::jsonb
  end;
$$;

-- Check a layout of two different aircraft and list the squares they cover.
create or replace function public.fa_layout_cells(p_planes jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_cells  jsonb := '[]';
  v_seen   text[] := '{}';
  v_shapes text[] := '{}';
  v_plane  jsonb;
  v_off    jsonb;
  v_index  integer := 0;
  v_shape  text;
  v_dir    text;
  v_r      integer;
  v_c      integer;
  v_dr     integer;
  v_dc     integer;
  v_rr     integer;
  v_cc     integer;
  v_first  boolean;
begin
  if p_planes is null or jsonb_typeof(p_planes) <> 'array' or jsonb_array_length(p_planes) <> 2 then
    raise exception 'invalid_layout';
  end if;
  for v_plane in select value from jsonb_array_elements(p_planes) loop
    v_shape := v_plane->>'shape';
    v_dir := v_plane->>'dir';
    if public.fa_shape_offsets(v_shape) is null
       or v_dir is null or v_dir not in ('up', 'right', 'down', 'left')
       or v_shape = any(v_shapes)
       or coalesce(v_plane->>'r', '') !~ '^[0-9]$'
       or coalesce(v_plane->>'c', '') !~ '^[0-9]$' then
      raise exception 'invalid_layout';
    end if;
    v_shapes := v_shapes || v_shape;
    v_r := (v_plane->>'r')::integer;
    v_c := (v_plane->>'c')::integer;
    v_first := true;
    for v_off in select value from jsonb_array_elements(public.fa_shape_offsets(v_shape)) loop
      v_dr := (v_off->>0)::integer;
      v_dc := (v_off->>1)::integer;
      case v_dir
        when 'up'    then v_rr := v_r + v_dr; v_cc := v_c + v_dc;
        when 'right' then v_rr := v_r + v_dc; v_cc := v_c - v_dr;
        when 'down'  then v_rr := v_r - v_dr; v_cc := v_c - v_dc;
        else              v_rr := v_r - v_dc; v_cc := v_c + v_dr;
      end case;
      if v_rr < 0 or v_rr > 9 or v_cc < 0 or v_cc > 9 or (v_rr || ',' || v_cc) = any(v_seen) then
        raise exception 'invalid_layout';
      end if;
      v_seen := v_seen || (v_rr || ',' || v_cc);
      v_cells := v_cells || jsonb_build_object('r', v_rr, 'c', v_cc, 'h', v_first, 'p', v_index);
      v_first := false;
    end loop;
    v_index := v_index + 1;
  end loop;
  return v_cells;
end;
$$;

create or replace function public.fa_heads(p_shots jsonb)
returns integer
language sql
immutable
as $$
  select count(*)::integer from jsonb_array_elements(coalesce(p_shots, '[]')) s where s->>'t' = 'head';
$$;

-- Move a room on when time runs out or both players are ready or done.
create or replace function public.fa_room_advance(p_code text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v       public.rooms;
  v_hs    integer;
  v_gs    integer;
  v_win   text;
  v_why   text;
begin
  select * into v from public.rooms where code = p_code for update;
  if not found or v.finished_at is not null or v.guest_secret is null then
    return;
  end if;

  if v.play_deadline is null then
    if v.host_layout is not null and v.guest_layout is not null then
      update public.rooms set play_deadline = now() + interval '5 minutes 2 seconds' where code = p_code;
    elsif now() > v.place_deadline + interval '8 seconds' then
      update public.rooms
      set finished_at = now(),
          result = jsonb_build_object(
            'reason', 'not_placed',
            'winner', case when v.host_layout is not null then 'host'
                           when v.guest_layout is not null then 'guest' end)
      where code = p_code;
    end if;
    return;
  end if;

  v_hs := jsonb_array_length(v.host_shots);
  v_gs := jsonb_array_length(v.guest_shots);
  -- A player still searching who has already used as many shots as the
  -- finished player cannot win, so the round can end early.
  if not ((v.host_done is not null and v.guest_done is not null)
          or (v.host_done is not null and v_gs >= v.host_done)
          or (v.guest_done is not null and v_hs >= v.guest_done)
          or now() > v.play_deadline) then
    return;
  end if;

  if v.host_done is not null and v.guest_done is not null then
    v_why := 'both_found';
    v_win := case when v.host_done < v.guest_done then 'host'
                  when v.guest_done < v.host_done then 'guest' end;
  elsif v.host_done is not null then
    v_why := case when now() > v.play_deadline then 'time' else 'found_first' end;
    v_win := 'host';
  elsif v.guest_done is not null then
    v_why := case when now() > v.play_deadline then 'time' else 'found_first' end;
    v_win := 'guest';
  else
    v_why := 'time';
    v_win := case when public.fa_heads(v.host_shots) > public.fa_heads(v.guest_shots) then 'host'
                  when public.fa_heads(v.guest_shots) > public.fa_heads(v.host_shots) then 'guest' end;
  end if;
  update public.rooms
  set finished_at = now(), result = jsonb_build_object('reason', v_why, 'winner', v_win)
  where code = p_code;
end;
$$;

create or replace function public.fa_room_check_name(p_name text)
returns text
language plpgsql
immutable
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
begin
  if v_name = '' then
    return 'Guest';
  end if;
  if v_name !~ '^[A-Za-z0-9 _-]{1,20}$' then
    raise exception 'invalid_name';
  end if;
  return v_name;
end;
$$;

-- Which side of the room a secret belongs to.
create or replace function public.fa_room_role(v public.rooms, p_secret uuid)
returns text
language plpgsql
immutable
as $$
begin
  if p_secret is not null and p_secret = v.host_secret then return 'host'; end if;
  if p_secret is not null and p_secret = v.guest_secret then return 'guest'; end if;
  raise exception 'room_not_found';
end;
$$;

create or replace function public.fa_room_create(p_name text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name    text := public.fa_room_check_name(p_name);
  v_letters text := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_code    text;
  v_row     public.rooms;
begin
  delete from public.rooms where expires_at < now() - interval '1 day';
  for attempt in 1..50 loop
    v_code := '';
    for i in 1..4 loop
      v_code := v_code || substr(v_letters, 1 + floor(random() * length(v_letters))::integer, 1);
    end loop;
    delete from public.rooms where code = v_code and expires_at < now();
    begin
      insert into public.rooms (code, host_name) values (v_code, v_name) returning * into v_row;
      return json_build_object('code', v_row.code, 'secret', v_row.host_secret, 'role', 'host');
    exception when unique_violation then
      -- Code in use; draw another.
    end;
  end loop;
  raise exception 'server';
end;
$$;

create or replace function public.fa_room_join(p_code text, p_name text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text := public.fa_room_check_name(p_name);
  v      public.rooms;
begin
  select * into v from public.rooms where code = upper(btrim(coalesce(p_code, ''))) for update;
  if not found or v.expires_at <= now() then
    raise exception 'room_not_found';
  end if;
  if v.guest_secret is not null then
    raise exception 'room_full';
  end if;
  update public.rooms
  set guest_secret = gen_random_uuid(),
      guest_name = v_name,
      place_deadline = now() + interval '62 seconds'
  where code = v.code
  returning * into v;
  return json_build_object('code', v.code, 'secret', v.guest_secret, 'role', 'guest');
end;
$$;

create or replace function public.fa_room_rename(p_code text, p_secret uuid, p_name text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text := public.fa_room_check_name(p_name);
  v      public.rooms;
begin
  select * into v from public.rooms where code = upper(coalesce(p_code, '')) for update;
  if not found then raise exception 'room_not_found'; end if;
  if public.fa_room_role(v, p_secret) = 'host' then
    update public.rooms set host_name = v_name where code = v.code;
  else
    update public.rooms set guest_name = v_name where code = v.code;
  end if;
  return json_build_object('name', v_name);
end;
$$;

create or replace function public.fa_room_state(p_code text, p_secret uuid)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v        public.rooms;
  v_role   text;
  v_host   boolean;
  v_phase  text;
  v_mine   jsonb;
  v_theirs jsonb;
begin
  perform public.fa_room_advance(upper(coalesce(p_code, '')));
  select * into v from public.rooms where code = upper(coalesce(p_code, ''));
  if not found then raise exception 'room_not_found'; end if;
  v_role := public.fa_room_role(v, p_secret);
  v_host := v_role = 'host';
  v_phase := case
    when v.expires_at <= now() then 'closed'
    when v.guest_secret is null then 'waiting'
    when v.finished_at is not null then 'finished'
    when v.play_deadline is not null then 'playing'
    else 'placing' end;
  v_mine := case when v_host then v.host_layout else v.guest_layout end;
  v_theirs := case when v_host then v.guest_layout else v.host_layout end;
  return json_build_object(
    'code', v.code,
    'role', v_role,
    'round', v.round,
    'phase', v_phase,
    'now', now(),
    'expires_at', v.expires_at,
    'place_deadline', v.place_deadline,
    'play_deadline', v.play_deadline,
    'result', v.result,
    'me', json_build_object(
      'name', case when v_host then v.host_name else v.guest_name end,
      'placed', v_mine is not null,
      'planes', v_mine->'planes',
      'shots', case when v_host then v.host_shots else v.guest_shots end,
      'done', case when v_host then v.host_done else v.guest_done end),
    'opp', json_build_object(
      'name', case when v_host then v.guest_name else v.host_name end,
      'placed', v_theirs is not null,
      -- The other player's shots land on my grid, so I may see them.
      'shots', case when v_host then v.guest_shots else v.host_shots end,
      'done', case when v_host then v.guest_done else v.host_done end,
      -- Their hidden aircraft are revealed only once the round is over.
      'planes', case when v_phase in ('finished', 'closed') then v_theirs->'planes' end)
  );
end;
$$;

create or replace function public.fa_room_place(p_code text, p_secret uuid, p_planes jsonb)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v      public.rooms;
  v_host boolean;
  v_cells jsonb;
begin
  perform public.fa_room_advance(upper(coalesce(p_code, '')));
  select * into v from public.rooms where code = upper(coalesce(p_code, '')) for update;
  if not found then raise exception 'room_not_found'; end if;
  v_host := public.fa_room_role(v, p_secret) = 'host';
  if v.expires_at <= now() or v.guest_secret is null or v.finished_at is not null or v.play_deadline is not null then
    raise exception 'not_placing';
  end if;
  if (v_host and v.host_layout is not null) or (not v_host and v.guest_layout is not null) then
    raise exception 'already_placed';
  end if;
  v_cells := public.fa_layout_cells(p_planes);
  if v_host then
    update public.rooms set host_layout = jsonb_build_object('planes', p_planes, 'cells', v_cells) where code = v.code;
  else
    update public.rooms set guest_layout = jsonb_build_object('planes', p_planes, 'cells', v_cells) where code = v.code;
  end if;
  return public.fa_room_state(v.code, p_secret);
end;
$$;

create or replace function public.fa_room_shoot(p_code text, p_secret uuid, p_r integer, p_c integer)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v       public.rooms;
  v_host  boolean;
  v_shots jsonb;
  v_cell  jsonb;
  v_type  text;
  v_done  integer;
begin
  perform public.fa_room_advance(upper(coalesce(p_code, '')));
  select * into v from public.rooms where code = upper(coalesce(p_code, '')) for update;
  if not found then raise exception 'room_not_found'; end if;
  v_host := public.fa_room_role(v, p_secret) = 'host';
  if v.play_deadline is null or v.finished_at is not null or v.expires_at <= now() or now() > v.play_deadline then
    raise exception 'not_playing';
  end if;
  if (v_host and v.host_done is not null) or (not v_host and v.guest_done is not null) then
    raise exception 'already_done';
  end if;
  if p_r is null or p_c is null or p_r < 0 or p_r > 9 or p_c < 0 or p_c > 9 then
    raise exception 'invalid_shot';
  end if;
  v_shots := case when v_host then v.host_shots else v.guest_shots end;
  if exists (select 1 from jsonb_array_elements(v_shots) s
             where (s->>'r')::integer = p_r and (s->>'c')::integer = p_c) then
    return json_build_object('type', 'ignored', 'shots', jsonb_array_length(v_shots));
  end if;

  select value into v_cell
  from jsonb_array_elements(case when v_host then v.guest_layout else v.host_layout end->'cells')
  where (value->>'r')::integer = p_r and (value->>'c')::integer = p_c;
  v_type := case when v_cell is null then 'miss'
                 when (v_cell->>'h')::boolean then 'head'
                 else 'body' end;
  v_shots := v_shots || jsonb_build_object('r', p_r, 'c', p_c, 't', v_type);
  v_done := case when public.fa_heads(v_shots) = 2 then jsonb_array_length(v_shots) end;

  if v_host then
    update public.rooms set host_shots = v_shots, host_done = v_done where code = v.code;
  else
    update public.rooms set guest_shots = v_shots, guest_done = v_done where code = v.code;
  end if;
  perform public.fa_room_advance(v.code);
  return json_build_object('type', v_type, 'shots', jsonb_array_length(v_shots), 'done', v_done);
end;
$$;

-- Start another round in the same room. Either player may ask.
create or replace function public.fa_room_rematch(p_code text, p_secret uuid)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v public.rooms;
begin
  perform public.fa_room_advance(upper(coalesce(p_code, '')));
  select * into v from public.rooms where code = upper(coalesce(p_code, '')) for update;
  if not found then raise exception 'room_not_found'; end if;
  perform public.fa_room_role(v, p_secret);
  if v.expires_at <= now() then raise exception 'room_not_found'; end if;
  if v.finished_at is not null then
    update public.rooms
    set round = round + 1,
        host_layout = null, guest_layout = null,
        host_shots = '[]', guest_shots = '[]',
        host_done = null, guest_done = null,
        play_deadline = null, finished_at = null, result = null,
        place_deadline = now() + interval '62 seconds'
    where code = v.code;
  end if;
  return public.fa_room_state(v.code, p_secret);
end;
$$;

create or replace function public.fa_room_leave(p_code text, p_secret uuid)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v public.rooms;
begin
  select * into v from public.rooms where code = upper(coalesce(p_code, '')) for update;
  if not found then return json_build_object('ok', true); end if;
  perform public.fa_room_role(v, p_secret);
  update public.rooms set expires_at = least(expires_at, now()) where code = v.code;
  return json_build_object('ok', true);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'fa_shape_offsets(text)', 'fa_layout_cells(jsonb)', 'fa_heads(jsonb)',
    'fa_room_advance(text)', 'fa_room_check_name(text)', 'fa_room_role(public.rooms, uuid)'
  ] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
  end loop;
  foreach f in array array[
    'fa_room_create(text)', 'fa_room_join(text, text)', 'fa_room_rename(text, uuid, text)',
    'fa_room_state(text, uuid)', 'fa_room_place(text, uuid, jsonb)',
    'fa_room_shoot(text, uuid, integer, integer)', 'fa_room_rematch(text, uuid)',
    'fa_room_leave(text, uuid)'
  ] loop
    execute 'revoke all on function public.' || f || ' from public';
    execute 'grant execute on function public.' || f || ' to anon, authenticated';
  end loop;
end;
$$;
