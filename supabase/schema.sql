-- Find Aircraft: accounts and leaderboard.
--
-- Run this once in the Supabase SQL editor. It is safe to run again.
--
-- The players table has row level security switched on and no policies, so the
-- public API key cannot read or write it directly. Everything goes through the
-- four functions below, which check the password or session token themselves.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.players (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  -- Names are unique without regard to case: "Helen" and "helen" collide.
  name_key    text generated always as (lower(name)) stored unique,
  pass_hash   text not null,
  -- Session token handed to the browser at sign up and sign in.
  token       uuid not null default gen_random_uuid() unique,
  -- Fewest shots in a won light-mode game. Null until the first win.
  best_shots  integer check (best_shots between 2 and 100),
  games_won   integer not null default 0,
  created_at  timestamptz not null default now()
);

alter table public.players enable row level security;
revoke all on table public.players from anon, authenticated;

create or replace function public.fa_sign_up(p_name text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_row  public.players;
begin
  if v_name !~ '^[A-Za-z0-9 _-]{2,20}$' then
    raise exception 'invalid_name';
  end if;
  if p_password is null or length(p_password) < 6 or length(p_password) > 72 then
    raise exception 'invalid_password';
  end if;
  begin
    insert into public.players (name, pass_hash)
    values (v_name, crypt(p_password, gen_salt('bf')))
    returning * into v_row;
  exception when unique_violation then
    raise exception 'name_taken';
  end;
  return json_build_object('name', v_row.name, 'token', v_row.token, 'best', v_row.best_shots);
end;
$$;

create or replace function public.fa_sign_in(p_name text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row public.players;
begin
  select * into v_row
  from public.players
  where name_key = lower(btrim(coalesce(p_name, '')));
  -- Same error whether the name or the password is wrong.
  if not found or v_row.pass_hash <> crypt(coalesce(p_password, ''), v_row.pass_hash) then
    raise exception 'bad_credentials';
  end if;
  return json_build_object('name', v_row.name, 'token', v_row.token, 'best', v_row.best_shots);
end;
$$;

create or replace function public.fa_submit_score(p_token uuid, p_shots integer)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row public.players;
begin
  if p_shots is null or p_shots < 2 or p_shots > 100 then
    raise exception 'invalid_score';
  end if;
  update public.players
  set best_shots = least(coalesce(best_shots, p_shots), p_shots),
      games_won  = games_won + 1
  where token = p_token
  returning * into v_row;
  if not found then
    raise exception 'bad_session';
  end if;
  return json_build_object('name', v_row.name, 'best', v_row.best_shots);
end;
$$;

create or replace function public.fa_leaderboard()
returns table (name text, best integer)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select p.name, p.best_shots
  from public.players p
  where p.best_shots is not null
  order by p.best_shots asc, p.created_at asc
  limit 50;
$$;

revoke all on function public.fa_sign_up(text, text) from public;
revoke all on function public.fa_sign_in(text, text) from public;
revoke all on function public.fa_submit_score(uuid, integer) from public;
revoke all on function public.fa_leaderboard() from public;

grant execute on function public.fa_sign_up(text, text) to anon, authenticated;
grant execute on function public.fa_sign_in(text, text) to anon, authenticated;
grant execute on function public.fa_submit_score(uuid, integer) to anon, authenticated;
grant execute on function public.fa_leaderboard() to anon, authenticated;
