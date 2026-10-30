-- =====================================================================
-- CatalogTalk schema (v2: mobile + RLS)
-- Idempotent: safe on a fresh project AND on the existing v1 database.
-- Run the whole file once in Supabase SQL Editor BEFORE deploying v2 code.
-- =====================================================================

-- 1. Tables ------------------------------------------------------------
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  email text unique not null,
  company_name text,
  plan text not null default 'free',   -- free | starter | pro | team
  created_at timestamptz default now()
);

create table if not exists flipbooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  title text not null,
  slug text unique not null,
  pdf_url text,
  thumb_url text,                      -- first page image (OG / Kakao thumbnail)
  page_count int not null default 0,
  status text default 'ready',
  views int default 0,
  created_at timestamptz default now()
);
alter table flipbooks add column if not exists thumb_url text;

-- v3: profile fields, referral codes, bonus flipbook slots, and folders
alter table customers add column if not exists name text;
alter table customers add column if not exists phone text;
alter table customers add column if not exists referral_code text unique;
alter table customers add column if not exists referred_by uuid references customers(id) on delete set null;
alter table customers add column if not exists bonus_flipbooks int not null default 0;

create table if not exists folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz default now()
);
alter table flipbooks add column if not exists folder_id uuid references folders(id) on delete set null;
alter table flipbooks add column if not exists page_count int not null default 0;

create table if not exists flipbook_pages (
  id uuid primary key default gen_random_uuid(),
  flipbook_id uuid references flipbooks(id) on delete cascade,
  page_no int not null,
  image_url text not null
);
create unique index if not exists flipbook_pages_uniq on flipbook_pages (flipbook_id, page_no);

create table if not exists flipbook_views (
  id uuid primary key default gen_random_uuid(),
  flipbook_id uuid references flipbooks(id) on delete cascade,
  viewed_at timestamptz default now(),
  ip text,                             -- not collected on the client (no server IP available)
  user_agent text,
  page_no int,
  dwell_ms int
);
alter table flipbook_views add column if not exists dwell_ms int;
create index if not exists flipbook_views_fb_idx on flipbook_views (flipbook_id, viewed_at);

-- 2. Row Level Security -----------------------------------------------
alter table customers       enable row level security;
alter table flipbooks       enable row level security;
alter table flipbook_pages  enable row level security;
alter table flipbook_views  enable row level security;

-- customers: a user can read/update only their own row. Rows are created by trigger (below).
drop policy if exists customers_select_own on customers;
create policy customers_select_own on customers for select to authenticated
  using (user_id = auth.uid());
drop policy if exists customers_update_own on customers;
create policy customers_update_own on customers for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table folders enable row level security;
drop policy if exists folders_owner_all on folders;
create policy folders_owner_all on folders for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke update on customers from authenticated;
grant update (name, phone, company_name) on customers to authenticated;

-- flipbooks: owners manage their own rows. Anonymous viewers never SELECT this table
-- directly (that would expose every catalog); they use get_flipbook() below.
drop policy if exists flipbooks_owner_select on flipbooks;
create policy flipbooks_owner_select on flipbooks for select to authenticated
  using (user_id = auth.uid());
drop policy if exists flipbooks_owner_insert on flipbooks;
create policy flipbooks_owner_insert on flipbooks for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists flipbooks_owner_update on flipbooks;
create policy flipbooks_owner_update on flipbooks for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists flipbooks_owner_delete on flipbooks;
create policy flipbooks_owner_delete on flipbooks for delete to authenticated
  using (user_id = auth.uid());

-- flipbook_pages: public read (page images are public anyway; ids are unguessable uuids).
-- Writes only by the owner of the parent flipbook.
drop policy if exists pages_public_select on flipbook_pages;
create policy pages_public_select on flipbook_pages for select to anon, authenticated
  using (true);
drop policy if exists pages_owner_write on flipbook_pages;
create policy pages_owner_write on flipbook_pages for all to authenticated
  using (exists (select 1 from flipbooks f where f.id = flipbook_id and f.user_id = auth.uid()))
  with check (exists (select 1 from flipbooks f where f.id = flipbook_id and f.user_id = auth.uid()));

-- flipbook_views: anyone (viewers) can insert; only the owner can read their stats.
drop policy if exists views_public_insert on flipbook_views;
create policy views_public_insert on flipbook_views for insert to anon, authenticated
  with check (true);
drop policy if exists views_owner_select on flipbook_views;
create policy views_owner_select on flipbook_views for select to authenticated
  using (exists (select 1 from flipbooks f where f.id = flipbook_id and f.user_id = auth.uid()));

-- 3. Functions ---------------------------------------------------------

-- Public viewer lookup by slug. Returns only what a viewer needs (no user_id).
create or replace function get_flipbook(p_slug text)
returns table (
  id uuid, title text, slug text, pdf_url text, thumb_url text,
  page_count int, views int, created_at timestamptz
)
language sql stable security definer set search_path = public
as $$
  select f.id, f.title, f.slug, f.pdf_url, f.thumb_url, f.page_count, f.views, f.created_at
  from flipbooks f where f.slug = p_slug limit 1;
$$;
grant execute on function get_flipbook(text) to anon, authenticated;

-- Atomic view counter (replaces the client-side read-modify-write).
create or replace function increment_view(fb_id uuid)
returns void
language sql security definer set search_path = public
as $$
  update flipbooks set views = views + 1 where id = fb_id;
$$;
grant execute on function increment_view(uuid) to anon, authenticated;

-- Create a customers row automatically when a user signs up.
-- (Client-side insert is impossible under RLS when email confirmation is on.)
-- A valid referral code (signup metadata "ref") gives the new user AND the referrer +1 flipbook slot.
create or replace function handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_ref text := nullif(upper(new.raw_user_meta_data ->> 'ref'), '');
  v_referrer uuid;
begin
  if v_ref is not null then
    select id into v_referrer from customers where referral_code = v_ref limit 1;
  end if;
  -- Rewards are granted later, after email confirmation (see reward_referral).
  insert into customers (user_id, email, company_name, name, phone, referral_code, referred_by, bonus_flipbooks, referral_rewarded)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'company_name',
    new.raw_user_meta_data ->> 'name',
    new.raw_user_meta_data ->> 'phone',
    upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)),
    v_referrer,
    0,
    v_referrer is null
  )
  on conflict (email) do nothing;
  return new;
end;
$$;
update customers set referral_code = upper(substr(md5(random()::text || clock_timestamp()::text || id::text), 1, 8))
  where referral_code is null;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Enforce the plan's flipbook limit on insert (free = 3, starter = 20, pro/team = unlimited).
create or replace function enforce_flipbook_limit()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_plan text;
  v_bonus int;
  v_limit int;
  v_count int;
begin
  select coalesce(c.plan, 'free'), coalesce(c.bonus_flipbooks, 0)
    into v_plan, v_bonus
    from customers c where c.user_id = new.user_id;
  v_limit := case coalesce(v_plan, 'free')
    when 'free' then 3 + v_bonus
    when 'starter' then 20 + v_bonus
    else null
  end;
  if v_limit is not null then
    select count(*) into v_count from flipbooks where user_id = new.user_id;
    if v_count >= v_limit then
      raise exception 'PLAN_LIMIT: 현재 요금제에서는 플립북을 %개까지 만들 수 있어요', v_limit
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists flipbook_limit on flipbooks;
create trigger flipbook_limit
  before insert on flipbooks
  for each row execute function enforce_flipbook_limit();

-- 4. Storage policies (bucket "flipbook-files" is created manually as PUBLIC) --
-- Public bucket = anyone can GET by URL. Only signed-in users may upload/replace/delete.
drop policy if exists flipbook_files_insert on storage.objects;
create policy flipbook_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'flipbook-files');
drop policy if exists flipbook_files_update_own on storage.objects;
create policy flipbook_files_update_own on storage.objects for update to authenticated
  using (bucket_id = 'flipbook-files' and owner = auth.uid());
drop policy if exists flipbook_files_delete_own on storage.objects;
create policy flipbook_files_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'flipbook-files' and owner = auth.uid());

-- 4. Visit analytics (v4) ----------------------------------------------
-- session_id groups the page rows of one visit. Owners read it through the existing
-- views_owner_select policy.
alter table flipbook_views add column if not exists session_id text;
create index if not exists flipbook_views_session_idx on flipbook_views (flipbook_id, session_id);
notify pgrst, 'reload schema';

-- 5. Security hardening (v5) -------------------------------------------
-- 5a. Views: browsers no longer insert rows directly. They call record_view(), which
--     checks the flipbook, the page number and simple per-session / per-day limits.
alter table flipbook_views drop constraint if exists flipbook_views_page_chk;
alter table flipbook_views add constraint flipbook_views_page_chk
  check (page_no is null or page_no between 1 and 5000);
alter table flipbook_views drop constraint if exists flipbook_views_dwell_chk;
alter table flipbook_views add constraint flipbook_views_dwell_chk
  check (dwell_ms is null or dwell_ms between 0 and 3600000);
alter table flipbook_views drop constraint if exists flipbook_views_session_chk;
alter table flipbook_views add constraint flipbook_views_session_chk
  check (session_id is null or char_length(session_id) between 8 and 64);
alter table flipbook_views drop constraint if exists flipbook_views_ua_chk;
alter table flipbook_views add constraint flipbook_views_ua_chk
  check (user_agent is null or char_length(user_agent) <= 255);

drop policy if exists views_public_insert on flipbook_views;
revoke insert on flipbook_views from anon, authenticated;

-- The old per-load counter is replaced by record_view (it counted anyone, unlimited).
drop function if exists increment_view(uuid);

create or replace function record_view(
  p_flipbook uuid, p_session text, p_page int, p_dwell int, p_ua text
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_pages int;
  v_is_new boolean;
begin
  if p_session is null or char_length(p_session) not between 8 and 64 then return; end if;
  select page_count into v_pages from flipbooks where id = p_flipbook;
  if v_pages is null or v_pages < 1 then return; end if;
  if p_page is null or p_page < 1 or p_page > v_pages then return; end if;
  -- one session may write at most 300 page rows in 10 minutes
  if (select count(*) from flipbook_views
       where session_id = p_session and viewed_at > now() - interval '10 minutes') >= 300 then
    return;
  end if;
  -- coarse daily ceiling per flipbook (stops runaway spam)
  if (select count(*) from flipbook_views
       where flipbook_id = p_flipbook and viewed_at > now() - interval '1 day') >= 50000 then
    return;
  end if;
  v_is_new := not exists (
    select 1 from flipbook_views where flipbook_id = p_flipbook and session_id = p_session
  );
  insert into flipbook_views (flipbook_id, session_id, page_no, dwell_ms, user_agent)
  values (p_flipbook, p_session, p_page,
          greatest(0, least(coalesce(p_dwell, 0), 3600000)), left(p_ua, 255));
  -- a view is counted once per visit, when its first page row arrives
  if v_is_new then
    update flipbooks set views = views + 1 where id = p_flipbook;
  end if;
end $$;

revoke all on function record_view(uuid, text, int, int, text) from public;
grant execute on function record_view(uuid, text, int, int, text) to anon, authenticated;

-- 6. Link on/off (v6) ---------------------------------------------------
-- The owner can switch a catalog's public link off. get_flipbook returns nothing for it,
-- so the viewer page shows "not found" and the page list (which needs the flipbook id) stays hidden.
alter table flipbooks add column if not exists is_public boolean not null default true;

create or replace function get_flipbook(p_slug text)
returns table (
  id uuid, title text, slug text, pdf_url text, thumb_url text,
  page_count int, views int, created_at timestamptz
)
language sql stable security definer set search_path = public
as $$
  select f.id, f.title, f.slug, f.pdf_url, f.thumb_url, f.page_count, f.views, f.created_at
  from flipbooks f where f.slug = p_slug and f.is_public limit 1;
$$;
grant execute on function get_flipbook(text) to anon, authenticated;
notify pgrst, 'reload schema';

-- 7. Operator flag (v7) ------------------------------------------------
-- Operators are marked in the database instead of by email in the code.
-- Users cannot change this column: their updates are limited to name/phone/company_name.
alter table customers add column if not exists is_admin boolean not null default false;
update customers set is_admin = true
  where user_id = (select id from auth.users where email = 'parkhy5454@gmail.com');
notify pgrst, 'reload schema';

-- 8. Retention of view logs (v8) ---------------------------------------
-- Visit logs contain page numbers, time spent and device type. They are kept for 365 days.
create or replace function purge_old_flipbook_views()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_deleted int;
begin
  delete from flipbook_views where viewed_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;
revoke all on function purge_old_flipbook_views() from public, anon, authenticated;

-- Runs every day at 03:00 (UTC). Requires the pg_cron extension
-- (Supabase: Database → Extensions → pg_cron → enable), then run this once:
-- select cron.schedule('purge-flipbook-views', '0 3 * * *', $$select purge_old_flipbook_views()$$);

-- 9. Referral rewards after email confirmation, capped (v9) -----------
-- A referral pays out only when the new account confirms its email, and each referrer
-- earns at most 10 rewarded signups. Users cannot change these columns (see the grant).
alter table customers add column if not exists referral_rewarded boolean not null default false;
alter table customers add column if not exists referral_rewards int not null default 0;

-- Referrals made before this change were already rewarded: mark them and count per referrer.
update customers set referral_rewarded = true where referred_by is not null;
update customers r set referral_rewards = (select count(*) from customers c where c.referred_by = r.id);

create or replace function reward_referral()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_me customers%rowtype;
  v_rewards int;
begin
  if new.email_confirmed_at is null then return new; end if;
  select * into v_me from customers where user_id = new.id;
  if not found or v_me.referral_rewarded or v_me.referred_by is null then return new; end if;

  select referral_rewards into v_rewards from customers where id = v_me.referred_by;
  if coalesce(v_rewards, 0) < 10 then
    update customers
       set bonus_flipbooks = bonus_flipbooks + 1,
           referral_rewards = referral_rewards + 1
     where id = v_me.referred_by;
    update customers set bonus_flipbooks = bonus_flipbooks + 1 where id = v_me.id;
  end if;
  update customers set referral_rewarded = true where id = v_me.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_referral_reward on auth.users;
create trigger on_auth_user_referral_reward
  after insert or update of email_confirmed_at on auth.users
  for each row execute function reward_referral();
notify pgrst, 'reload schema';

-- 10. Private catalog files (v10) ---------------------------------------
-- BEFORE running this: in Supabase Storage create the bucket "flipbook-private" with
-- Public = OFF. Pages and originals of new catalogs live there and are served only through
-- short-lived signed URLs (see lib/flipbook/sign.ts and app/api/original). Thumbnails stay in
-- the public "flipbook-files" bucket so link-preview crawlers can read them.
-- Anonymous visitors get no policy here, so they cannot read the bucket at all.
drop policy if exists flipbook_private_insert on storage.objects;
create policy flipbook_private_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'flipbook-private');
drop policy if exists flipbook_private_update_own on storage.objects;
create policy flipbook_private_update_own on storage.objects for update to authenticated
  using (bucket_id = 'flipbook-private' and owner = auth.uid());
-- Owners may read and delete files under their own catalog folders (folder = slug or row id).
drop policy if exists flipbook_private_select_own on storage.objects;
create policy flipbook_private_select_own on storage.objects for select to authenticated
  using (
    bucket_id = 'flipbook-private'
    and (storage.foldername(name))[1] in (
      select slug from flipbooks where user_id = auth.uid()
      union select id::text from flipbooks where user_id = auth.uid()
    )
  );
drop policy if exists flipbook_private_delete_own on storage.objects;
create policy flipbook_private_delete_own on storage.objects for delete to authenticated
  using (
    bucket_id = 'flipbook-private'
    and (storage.foldername(name))[1] in (
      select slug from flipbooks where user_id = auth.uid()
      union select id::text from flipbooks where user_id = auth.uid()
    )
  );

-- 11. Flipbook password (v11) ------------------------------------------
-- Stored as a scrypt hash (set by the owner through the app). Anonymous readers only learn
-- has_password through get_flipbook; the hash itself is never returned to them.
alter table flipbooks add column if not exists password_hash text;

drop function if exists get_flipbook(text);
create function get_flipbook(p_slug text)
returns table (
  id uuid, title text, slug text, pdf_url text, thumb_url text,
  page_count int, views int, created_at timestamptz, has_password boolean
)
language sql stable security definer set search_path = public
as $$
  select f.id, f.title, f.slug, f.pdf_url, f.thumb_url, f.page_count, f.views, f.created_at,
         f.password_hash is not null
  from flipbooks f where f.slug = p_slug and f.is_public limit 1;
$$;
grant execute on function get_flipbook(text) to anon, authenticated;
notify pgrst, 'reload schema';
