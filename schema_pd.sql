-- Moose Management - Property Desk  |  schema_pd.sql
-- Safe to re-run. Built to sit in the SAME Supabase project as the Maintenance Desk
-- ("Moose Management - Maintenance") so the whole office has one sign-in, but it also
-- works on an empty project.
--
-- It only ADDS things. Every object it makes starts with pd_ (plus one new column,
-- allowed_users.pd_role). It never alters or drops a Maintenance Desk table, policy or function.
--
-- Rules carried over from the Claude artifact and from the Maintenance Desk:
--   * Nothing is deleted: pd_docs refuses DELETE and TRUNCATE. Every overwrite of a person's
--     work keeps the old copy in pd_docs_log (append-only).
--   * Only people with allowed_users.pd_role set can read or write anything here.
--   * The board's code itself (it names vendors, phone numbers and an example door code)
--     lives in pd_app behind sign-in, so the public GitHub repo holds only a sign-in shell.

create extension if not exists pgcrypto;

-- ---------- people (shared with the Maintenance Desk when it is there) ----------
create table if not exists allowed_users (
  id          uuid primary key default gen_random_uuid(),
  email       text,
  alt_email   text,
  name        text not null unique,
  role        text not null default 'viewer' check (role in ('admin','tech','viewer')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table allowed_users add column if not exists alt_email text;
alter table allowed_users add column if not exists initials text;
alter table allowed_users add column if not exists pd_role text;
do $$ begin
  alter table allowed_users add constraint allowed_users_pd_role_chk check (pd_role is null or pd_role in ('admin','editor'));
exception when duplicate_object then null; end $$;
alter table allowed_users enable row level security;

create or replace function pd_role() returns text
language sql stable security definer set search_path = public as $$
  select pd_role from allowed_users
   where active and lower(auth.jwt()->>'email') in (lower(coalesce(email,'')), lower(coalesce(alt_email,'')))
   limit 1
$$;
create or replace function pd_actor() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('app.actor', true),''), auth.jwt()->>'email', 'system')
$$;

-- Sign-ups: the Maintenance Desk already refuses anyone not in allowed_users. On an empty
-- project there is no such trigger yet, so add our own.
create or replace function pd_only_allowed_signups() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.allowed_users
                  where active and lower(new.email) in (lower(coalesce(email,'')), lower(coalesce(alt_email,'')))) then
    raise exception 'This email is not on the Moose list.';
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname in ('only_allowed_signups','pd_only_allowed_signups')) then
    create trigger pd_only_allowed_signups before insert on auth.users for each row execute function public.pd_only_allowed_signups();
  end if;
end $$;

create or replace function pd_identity() returns table (name text, initials text, pd_role text, email text)
language sql stable security definer set search_path = public as $$
  select name, initials, pd_role, auth.jwt()->>'email' from allowed_users
   where active and pd_role is not null
     and lower(auth.jwt()->>'email') in (lower(coalesce(email,'')), lower(coalesce(alt_email,'')))
   limit 1
$$;
grant execute on function pd_identity() to authenticated;

-- ---------- the board's own database (same shape it had inside Claude) ----------
create table if not exists pd_docs (
  collection  text not null,           -- jobs, feeds, config, meetings ...
  id          text not null,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text not null default pd_actor(),
  primary key (collection, id)
);
create table if not exists pd_docs_log (
  log_id      bigint generated always as identity primary key,
  collection  text not null,
  id          text not null,
  old_data    jsonb,
  changed_at  timestamptz not null default now(),
  changed_by  text not null default pd_actor()
);
create index if not exists pd_docs_log_doc on pd_docs_log (collection, id, changed_at);

create or replace function pd_forbid_delete() returns trigger language plpgsql as $$
begin raise exception 'Nothing is deleted on the Property Desk (%). Close the job instead.', tg_table_name; end $$;
create or replace function pd_forbid_change() returns trigger language plpgsql as $$
begin raise exception '% is append-only', tg_table_name; end $$;

create or replace function pd_docs_keep() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now(); new.updated_by := pd_actor();
  -- keep history of people's work; program feeds (big, rewritten every run) are not logged
  if tg_op = 'UPDATE' and new.collection <> 'feeds' and new.data is distinct from old.data then
    insert into pd_docs_log (collection, id, old_data) values (old.collection, old.id, old.data);
  end if;
  return new;
end $$;
drop trigger if exists pd_docs_keep on pd_docs;
create trigger pd_docs_keep before insert or update on pd_docs for each row execute function pd_docs_keep();
drop trigger if exists pd_docs_no_delete on pd_docs;
create trigger pd_docs_no_delete before delete on pd_docs for each row execute function pd_forbid_delete();
drop trigger if exists pd_docs_no_truncate on pd_docs;
create trigger pd_docs_no_truncate before truncate on pd_docs for each statement execute function pd_forbid_delete();
drop trigger if exists pd_docs_log_no_change on pd_docs_log;
create trigger pd_docs_log_no_change before update or delete on pd_docs_log for each row execute function pd_forbid_change();

-- Who writes what. Admin: everything. Editor: the jobs, the meeting notes and community facts
-- (what the board itself writes in normal use). Feeds from Track / Breezeway are written by the
-- ThinkStation with the service key, which bypasses these rules.
create or replace function pd_can_write(c text, i text) returns boolean language sql stable security definer set search_path = public as $$
  select case pd_role()
    when 'admin'  then true
    when 'editor' then c in ('jobs','meetings') or (c = 'feeds' and i = 'community-facts')
    else false end
$$;

alter table pd_docs enable row level security;
alter table pd_docs_log enable row level security;
drop policy if exists pd_read on pd_docs;
create policy pd_read on pd_docs for select to authenticated using (pd_role() is not null);
drop policy if exists pd_ins on pd_docs;
create policy pd_ins on pd_docs for insert to authenticated with check (pd_can_write(collection, id));
drop policy if exists pd_upd on pd_docs;
create policy pd_upd on pd_docs for update to authenticated using (pd_can_write(collection, id)) with check (pd_can_write(collection, id));
drop policy if exists pd_log_admin on pd_docs_log;
create policy pd_log_admin on pd_docs_log for select to authenticated using (pd_role() = 'admin');

do $$ begin
  alter publication supabase_realtime add table pd_docs;
exception when others then null; end $$;

-- The artifact's db.update(): merge nested objects, replace everything else (arrays too).
create or replace function pd_jsonb_merge(a jsonb, b jsonb) returns jsonb language plpgsql immutable as $$
declare k text; v jsonb; r jsonb;
begin
  if jsonb_typeof(a) <> 'object' or jsonb_typeof(b) <> 'object' or a is null then return b; end if;
  r := a;
  for k, v in select * from jsonb_each(b) loop
    if r ? k then r := jsonb_set(r, array[k], pd_jsonb_merge(r->k, v)); else r := r || jsonb_build_object(k, v); end if;
  end loop;
  return r;
end $$;

-- update = merge into an existing document; refuses a missing one (the board then falls back to set)
create or replace function pd_update(p_collection text, p_id text, p_patch jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update pd_docs set data = pd_jsonb_merge(data, p_patch) where collection = p_collection and id = p_id;
  if not found then
    raise exception 'pd_update: % / % does not exist', p_collection, p_id using errcode = 'P0002';
  end if;
end $$;
grant execute on function pd_update(text, text, jsonb) to authenticated;

-- ---------- the board's code, behind sign-in ----------
create table if not exists pd_app (
  name        text primary key,      -- 'desk'
  html        text not null,          -- the board body, exactly as it ran in Claude
  version     text,
  updated_at  timestamptz not null default now()
);
alter table pd_app enable row level security;
drop policy if exists pd_app_read on pd_app;
create policy pd_app_read on pd_app for select to authenticated using (pd_role() is not null);

-- ---------- who can sign in to the Property Desk ----------
-- Names and initials come from the board's own roster. People already on the Maintenance list
-- (matched on initials) just get pd_role. New names are added without an email: they can't sign in
-- until Brandon adds one in Table editor > allowed_users.
-- New rows get the Maintenance role 'viewer' (read only, no codes, no costs there).
with roster(name, initials, pd_role) as (values
  ('Brandon','BT','admin'), ('Kimberley','KB','admin'), ('Jeff','JJ','admin'),
  ('Carmila','CA','editor'), ('Charmayne','CH','editor'), ('Chris','CM','editor'), ('Cheree','CE','editor'),
  ('Haylee','HL','editor'), ('Janae','JB','editor'), ('Keno','KO','editor'), ('Porsha','PT','editor'),
  ('Pyper','PB','editor'), ('Sheryl','SM','editor'), ('Valinda','VC','editor'), ('Jannah','JN','editor'))
, upd as (
  update allowed_users u set pd_role = r.pd_role
    from roster r where u.initials = r.initials and u.pd_role is null
  returning u.initials)
insert into allowed_users (name, initials, role, pd_role)
select r.name, r.initials, 'viewer', r.pd_role from roster r
 where not exists (select 1 from allowed_users u where u.initials = r.initials or lower(u.name) = lower(r.name))
on conflict (name) do nothing;
