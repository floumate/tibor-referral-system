-- Tibor (Edit Unovac) — Uživo Trening — Referral System Schema
-- Konsolidovana finalna šema (tabela + sve funkcije, uklj. leaderboard i maskiranje emailova).
-- Pokreni JEDNOM u Supabase SQL Editor-u posle kreiranja projekta.

create extension if not exists pgcrypto;

create table if not exists signups (
  id              uuid primary key default gen_random_uuid(),
  email           text not null unique,
  first_name      text,
  last_name       text,
  ref_code        text not null unique,
  referred_by     text references signups(ref_code) on delete set null,
  dashboard_token text not null unique,
  attended        boolean not null default false,
  reward_sent     boolean not null default false,
  flagged         boolean not null default false,
  notes           text,
  ip              text,           -- IP prijave (Vercel x-forwarded-for) — detekcija prevare, vidi ANTI-FRAUD.md
  user_agent      text,           -- browser/uredjaj prijave — dodatni signal
  created_at      timestamptz not null default now()
);

create index if not exists signups_referred_by_idx on signups(referred_by);
create index if not exists signups_dashboard_token_idx on signups(dashboard_token);
create index if not exists signups_created_at_idx on signups(created_at desc);
create index if not exists signups_ip_idx on signups(ip);

-- random code generator: 6 chars, uppercase alphanumeric, no 0/O/I/1 confusion
create or replace function gen_ref_code() returns text
language plpgsql as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := '';
  i int;
begin
  for i in 1..6 loop
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return result;
end;
$$;

-- random url-safe dashboard token (~24 chars)
create or replace function gen_dashboard_token() returns text
language plpgsql as $$
declare
  raw text;
begin
  raw := encode(gen_random_bytes(18), 'base64');
  raw := replace(raw, '+', '-');
  raw := replace(raw, '/', '_');
  raw := replace(raw, '=', '');
  return raw;
end;
$$;

-- Main signup function. Idempotent on email.
-- Poziva je /api/signup preko service_role ključa.
create or replace function create_signup(
  p_email text,
  p_first_name text default null,
  p_referred_by text default null,
  p_last_name text default null,
  p_ip text default null,
  p_user_agent text default null
) returns table (
  out_ref_code text,
  out_dashboard_token text,
  out_is_new boolean,
  out_referred_by text
)
language plpgsql
security definer
as $$
declare
  v_existing signups%rowtype;
  v_ref_code text;
  v_token text;
  v_referred_by text;
  v_attempts int := 0;
begin
  p_email := lower(trim(p_email));
  if p_email is null or p_email = '' or position('@' in p_email) = 0 then
    raise exception 'Invalid email';
  end if;

  select * into v_existing from signups where email = p_email limit 1;
  if found then
    if v_existing.last_name is null and nullif(trim(p_last_name), '') is not null then
      update signups set last_name = trim(p_last_name) where id = v_existing.id;
    end if;
    return query select
      v_existing.ref_code,
      v_existing.dashboard_token,
      false,
      v_existing.referred_by;
    return;
  end if;

  v_referred_by := null;
  if p_referred_by is not null and length(trim(p_referred_by)) > 0 then
    select s.ref_code into v_referred_by
    from signups s
    where s.ref_code = upper(trim(p_referred_by))
    limit 1;
  end if;

  loop
    v_ref_code := gen_ref_code();
    exit when not exists (select 1 from signups where ref_code = v_ref_code);
    v_attempts := v_attempts + 1;
    if v_attempts > 20 then
      raise exception 'Could not generate unique ref_code after 20 attempts';
    end if;
  end loop;

  v_token := gen_dashboard_token();

  insert into signups (email, first_name, last_name, ref_code, referred_by, dashboard_token, ip, user_agent)
  values (
    p_email,
    nullif(trim(p_first_name), ''),
    nullif(trim(p_last_name), ''),
    v_ref_code,
    v_referred_by,
    v_token,
    nullif(trim(p_ip), ''),
    nullif(trim(p_user_agent), '')
  );

  return query select v_ref_code, v_token, true, v_referred_by;
end;
$$;

-- Dashboard read function: vraća moje podatke + rank + listu dovedenih.
-- SECURITY DEFINER da anon rola (bez pristupa tabeli) može da je pozove sa tokenom.
create or replace function get_dashboard(p_token text)
returns table (
  ref_code text,
  first_name text,
  last_name text,
  referral_count bigint,
  my_rank int,
  total_with_referrals bigint,
  referrals json
)
language plpgsql
security definer
as $$
declare
  v_ref_code text;
  v_first_name text;
  v_last_name text;
  v_my_count bigint;
  v_my_rank int;
  v_total bigint;
begin
  if p_token is null or length(p_token) < 10 then
    return;
  end if;

  select s.ref_code, s.first_name, s.last_name
  into v_ref_code, v_first_name, v_last_name
  from signups s
  where s.dashboard_token = p_token
  limit 1;

  if not found then
    return;
  end if;

  v_my_count := (select count(*) from signups x where x.referred_by = v_ref_code);
  v_total    := (select count(*) from (
    select s.ref_code
    from signups s
    where (select count(*) from signups y where y.referred_by = s.ref_code) > 0
  ) t);

  if v_my_count > 0 then
    v_my_rank := (
      select count(*) + 1
      from signups s
      where (select count(*) from signups z where z.referred_by = s.ref_code) > v_my_count
    );
  else
    v_my_rank := null;
  end if;

  return query
  select
    v_ref_code,
    v_first_name,
    v_last_name,
    v_my_count,
    v_my_rank,
    v_total,
    coalesce(
      (select json_agg(json_build_object(
        'email', x.email,
        'first_name', x.first_name,
        'last_name', x.last_name,
        'created_at', x.created_at
      ) order by x.created_at desc)
      from signups x where x.referred_by = v_ref_code),
      '[]'::json
    );
end;
$$;

-- Server-side email masking za leaderboard: gledalac vidi svoj pun email,
-- svi ostali redovi su "d***@gmail.com".
create or replace function mask_email(e text) returns text
language sql
immutable
as $$
  select case
    when e is null or position('@' in e) = 0 then e
    else substr(e, 1, 1) || '***' || substr(e, position('@' in e))
  end
$$;

create or replace function get_leaderboard(p_token text default null)
returns table (
  rank int,
  first_name text,
  last_name text,
  email text,
  referral_count bigint,
  is_me boolean
)
language plpgsql
security definer
as $fn$
declare
  v_viewer_email text;
begin
  if p_token is not null and length(p_token) >= 10 then
    select s.email into v_viewer_email
    from signups s
    where s.dashboard_token = p_token
    limit 1;
  end if;

  return query
  with counts as (
    select
      s.ref_code,
      s.first_name,
      s.last_name,
      s.email,
      (select count(*) from signups x where x.referred_by = s.ref_code) as cnt
    from signups s
  )
  select
    (row_number() over (order by c.cnt desc, c.first_name nulls last))::int as rank,
    c.first_name,
    c.last_name,
    case
      when v_viewer_email is not null and c.email = v_viewer_email then c.email
      else mask_email(c.email)
    end as email,
    c.cnt as referral_count,
    (v_viewer_email is not null and c.email = v_viewer_email) as is_me
  from counts c
  where c.cnt >= 1
  order by c.cnt desc, c.first_name nulls last
  limit 50;
end;
$fn$;

-- Zaključavanje: RLS bez policy-ja = nula direktnog pristupa tabeli.
-- Sva čitanja idu kroz get_dashboard/get_leaderboard (token), upis kroz create_signup (service_role).
alter table signups enable row level security;

grant execute on function get_dashboard(text) to anon;
grant execute on function get_leaderboard(text) to anon;
revoke execute on function create_signup(text, text, text, text, text, text) from anon, authenticated;
