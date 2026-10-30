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

-- 12. Password attempt limit (v12) --------------------------------------
-- Counts wrong viewer-password tries per catalog and visitor address. Only the server
-- (service role) reads or writes it, so RLS is on with no policies.
create table if not exists unlock_attempts (
  key text primary key,
  fails int not null default 0,
  locked_until timestamptz
);
alter table unlock_attempts enable row level security;

-- 13. Link expiry (v13) ---------------------------------------------------
-- Optional end time for a catalog's public link. Null = no end. After it passes,
-- get_flipbook returns nothing, so the viewer and the original stop working.
alter table flipbooks add column if not exists expires_at timestamptz;

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
  from flipbooks f
  where f.slug = p_slug and f.is_public
    and (f.expires_at is null or f.expires_at > now())
  limit 1;
$$;
grant execute on function get_flipbook(text) to anon, authenticated;
notify pgrst, 'reload schema';

-- 14. Referral abuse guard (v14) ---------------------------------------
-- The sign-up address is stored only as a hash (see app/api/signup-track). Before the reward is
-- granted, reward_referral() refuses it when:
--   * the new member signed up from the same address as the referrer, or
--   * 2 or more other referred sign-ups from that address happened in the last 30 days.
-- A refused referral still marks the sign-up as done (no retries), but gives no bonus.
alter table customers add column if not exists signup_ip_hash text;

create table if not exists signup_visits (
  email text primary key,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
alter table signup_visits enable row level security;

create or replace function reward_referral()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_me customers%rowtype;
  v_ref customers%rowtype;
  v_ip text;
  v_recent int;
  v_allowed boolean := true;
begin
  if new.email_confirmed_at is null then return new; end if;
  select * into v_me from customers where user_id = new.id;
  if not found or v_me.referral_rewarded or v_me.referred_by is null then return new; end if;

  if v_me.signup_ip_hash is null then
    select ip_hash into v_ip from signup_visits where email = lower(new.email);
    if v_ip is not null then
      update customers set signup_ip_hash = v_ip where id = v_me.id;
      v_me.signup_ip_hash := v_ip;
    end if;
  end if;

  select * into v_ref from customers where id = v_me.referred_by;
  if not found then return new; end if;

  if v_me.signup_ip_hash is not null then
    if v_ref.signup_ip_hash = v_me.signup_ip_hash then v_allowed := false; end if;
    select count(*) into v_recent from customers
      where signup_ip_hash = v_me.signup_ip_hash
        and referred_by is not null
        and referral_rewarded
        and id <> v_me.id
        and created_at > now() - interval '30 days';
    if v_recent >= 2 then v_allowed := false; end if;
  end if;

  if v_allowed and coalesce(v_ref.referral_rewards, 0) < 10 then
    update customers
       set bonus_flipbooks = bonus_flipbooks + 1,
           referral_rewards = referral_rewards + 1
     where id = v_ref.id;
    update customers set bonus_flipbooks = bonus_flipbooks + 1 where id = v_me.id;
  end if;
  update customers set referral_rewarded = true where id = v_me.id;
  return new;
end;
$$;
notify pgrst, 'reload schema';

-- 15. Business chat (v15) -----------------------------------------------
-- Business members only (is_business, set after a valid business number is saved).
-- One 1:1 thread per pair. Messages can carry a catalog card (a snapshot of title, slug, thumb).
alter table customers add column if not exists is_business boolean not null default false;
alter table customers add column if not exists business_number text;
create unique index if not exists customers_business_number_uniq
  on customers (business_number) where business_number is not null;

create table if not exists chat_threads (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references auth.users(id) on delete cascade,
  user_b uuid not null references auth.users(id) on delete cascade,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (user_a < user_b),
  unique (user_a, user_b)
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references chat_threads(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 2000),
  catalog_title text,
  catalog_slug text,
  catalog_thumb text,
  created_at timestamptz not null default now(),
  check (char_length(body) > 0 or catalog_slug is not null)
);
create index if not exists chat_messages_thread_idx on chat_messages (thread_id, created_at);

create table if not exists chat_reads (
  thread_id uuid not null references chat_threads(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);

create table if not exists chat_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

create table if not exists chat_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid references chat_messages(id) on delete cascade,
  reason text not null check (char_length(reason) <= 500),
  created_at timestamptz not null default now()
);

alter table chat_threads enable row level security;
alter table chat_messages enable row level security;
alter table chat_reads enable row level security;
alter table chat_blocks enable row level security;
alter table chat_reports enable row level security;

create or replace function is_business_user(u uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce((select is_business from customers where user_id = u), false) $$;

create or replace function is_blocked_between(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from chat_blocks
    where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)
  )
$$;

-- Threads: readable by the two members; created only through open_chat().
drop policy if exists chat_threads_member_select on chat_threads;
create policy chat_threads_member_select on chat_threads for select to authenticated
  using (user_a = auth.uid() or user_b = auth.uid());

-- Messages: members of an unblocked thread, both business members, sender must be the caller.
drop policy if exists chat_messages_member_select on chat_messages;
create policy chat_messages_member_select on chat_messages for select to authenticated
  using (exists (
    select 1 from chat_threads t
    where t.id = thread_id and (t.user_a = auth.uid() or t.user_b = auth.uid())
      and not is_blocked_between(t.user_a, t.user_b)
  ));

drop policy if exists chat_messages_member_insert on chat_messages;
create policy chat_messages_member_insert on chat_messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and is_business_user(auth.uid())
    and exists (
      select 1 from chat_threads t
      where t.id = thread_id and (t.user_a = auth.uid() or t.user_b = auth.uid())
        and not is_blocked_between(t.user_a, t.user_b)
    )
    and (catalog_slug is null or exists (
      select 1 from flipbooks f where f.slug = catalog_slug and f.user_id = auth.uid()
    ))
  );

drop policy if exists chat_reads_own on chat_reads;
create policy chat_reads_own on chat_reads for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists chat_blocks_own on chat_blocks;
create policy chat_blocks_own on chat_blocks for all to authenticated
  using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());

drop policy if exists chat_reports_insert_own on chat_reports;
create policy chat_reports_insert_own on chat_reports for insert to authenticated
  with check (reporter_id = auth.uid());

create or replace function open_chat(p_other uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  tid uuid;
begin
  if me is null then raise exception '로그인이 필요해요'; end if;
  if p_other = me then raise exception '자기 자신과는 대화할 수 없어요'; end if;
  if not is_business_user(me) or not is_business_user(p_other) then
    raise exception '사업자 회원끼리만 대화할 수 있어요';
  end if;
  if is_blocked_between(me, p_other) then raise exception '대화할 수 없는 상대예요'; end if;
  insert into chat_threads (user_a, user_b)
  values (least(me, p_other), greatest(me, p_other))
  on conflict (user_a, user_b) do update set user_a = excluded.user_a
  returning id into tid;
  return tid;
end;
$$;

create or replace function find_business_member(p_number text)
returns table (user_id uuid, company_name text)
language sql stable security definer set search_path = public
as $$
  select c.user_id, c.company_name
  from customers c
  where c.business_number = p_number
    and c.is_business
    and c.user_id <> auth.uid()
    and is_business_user(auth.uid())
    and not is_blocked_between(c.user_id, auth.uid())
  limit 1
$$;

create or replace function list_chat_threads()
returns table (
  thread_id uuid, partner_id uuid, partner_company text,
  last_message_at timestamptz, last_body text, unread int
)
language sql stable security definer set search_path = public
as $$
  select
    t.id,
    case when t.user_a = auth.uid() then t.user_b else t.user_a end,
    (select c.company_name from customers c
      where c.user_id = case when t.user_a = auth.uid() then t.user_b else t.user_a end),
    t.last_message_at,
    (select case when m.body <> '' then m.body else '[카탈로그] ' || coalesce(m.catalog_title, '') end
       from chat_messages m where m.thread_id = t.id order by m.created_at desc limit 1),
    (select count(*)::int from chat_messages m
       where m.thread_id = t.id and m.sender_id <> auth.uid()
         and m.created_at > coalesce(
           (select r.last_read_at from chat_reads r where r.thread_id = t.id and r.user_id = auth.uid()),
           'epoch'::timestamptz))
  from chat_threads t
  where (t.user_a = auth.uid() or t.user_b = auth.uid())
    and not is_blocked_between(t.user_a, t.user_b)
  order by t.last_message_at desc
$$;

create or replace function touch_chat_thread()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  update chat_threads set last_message_at = new.created_at where id = new.thread_id;
  return new;
end;
$$;
drop trigger if exists chat_message_touch on chat_messages;
create trigger chat_message_touch after insert on chat_messages
  for each row execute function touch_chat_thread();

grant execute on function open_chat(uuid) to authenticated;
grant execute on function find_business_member(text) to authenticated;
grant execute on function list_chat_threads() to authenticated;
grant execute on function is_business_user(uuid) to authenticated;
grant execute on function is_blocked_between(uuid, uuid) to authenticated;

-- Live updates for the open conversation.
do $$
begin
  alter publication supabase_realtime add table chat_messages;
exception when duplicate_object then null;
end $$;
notify pgrst, 'reload schema';

-- 16. Chat without business verification (v16) ----------------------------
-- Every member can chat. Members find each other with their friend code (customers.referral_code).
-- The business number is no longer used for chat; its column and index stay harmless.
create or replace function is_business_user(u uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from customers where user_id = u) $$;

drop function if exists find_business_member(text);
create or replace function find_chat_partner(p_code text)
returns table (user_id uuid, company_name text)
language sql stable security definer set search_path = public
as $$
  select c.user_id, coalesce(c.company_name, c.name)
  from customers c
  where c.referral_code = upper(trim(p_code))
    and c.user_id <> auth.uid()
    and is_business_user(auth.uid())
    and not is_blocked_between(c.user_id, auth.uid())
  limit 1
$$;
grant execute on function find_chat_partner(text) to authenticated;

create or replace function list_chat_threads()
returns table (
  thread_id uuid, partner_id uuid, partner_company text,
  last_message_at timestamptz, last_body text, unread int
)
language sql stable security definer set search_path = public
as $$
  select
    t.id,
    case when t.user_a = auth.uid() then t.user_b else t.user_a end,
    (select coalesce(c.company_name, c.name) from customers c
      where c.user_id = case when t.user_a = auth.uid() then t.user_b else t.user_a end),
    t.last_message_at,
    (select case when m.body <> '' then m.body else '[카탈로그] ' || coalesce(m.catalog_title, '') end
       from chat_messages m where m.thread_id = t.id order by m.created_at desc limit 1),
    (select count(*)::int from chat_messages m
       where m.thread_id = t.id and m.sender_id <> auth.uid()
         and m.created_at > coalesce(
           (select r.last_read_at from chat_reads r where r.thread_id = t.id and r.user_id = auth.uid()),
           'epoch'::timestamptz))
  from chat_threads t
  where (t.user_a = auth.uid() or t.user_b = auth.uid())
    and not is_blocked_between(t.user_a, t.user_b)
  order by t.last_message_at desc
$$;
notify pgrst, 'reload schema';

-- 17. Pinned conversations (v17) ------------------------------------------
-- Each member pins their own conversations. Other members never see it.
create table if not exists chat_pins (
  user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references chat_threads(id) on delete cascade,
  pinned_at timestamptz not null default now(),
  primary key (user_id, thread_id)
);
alter table chat_pins enable row level security;

drop policy if exists chat_pins_own on chat_pins;
create policy chat_pins_own on chat_pins for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from chat_threads t
      where t.id = thread_id and (t.user_a = auth.uid() or t.user_b = auth.uid())
    )
  );

drop function if exists list_chat_threads();
create function list_chat_threads()
returns table (
  thread_id uuid, partner_id uuid, partner_company text,
  last_message_at timestamptz, last_body text, unread int, pinned boolean
)
language sql stable security definer set search_path = public
as $$
  select
    t.id,
    case when t.user_a = auth.uid() then t.user_b else t.user_a end,
    (select coalesce(c.company_name, c.name) from customers c
      where c.user_id = case when t.user_a = auth.uid() then t.user_b else t.user_a end),
    t.last_message_at,
    (select case when m.body <> '' then m.body else '[카탈로그] ' || coalesce(m.catalog_title, '') end
       from chat_messages m where m.thread_id = t.id order by m.created_at desc limit 1),
    (select count(*)::int from chat_messages m
       where m.thread_id = t.id and m.sender_id <> auth.uid()
         and m.created_at > coalesce(
           (select r.last_read_at from chat_reads r where r.thread_id = t.id and r.user_id = auth.uid()),
           'epoch'::timestamptz)),
    exists (select 1 from chat_pins p where p.thread_id = t.id and p.user_id = auth.uid())
  from chat_threads t
  where (t.user_a = auth.uid() or t.user_b = auth.uid())
    and not is_blocked_between(t.user_a, t.user_b)
  order by
    exists (select 1 from chat_pins p where p.thread_id = t.id and p.user_id = auth.uid()) desc,
    t.last_message_at desc
$$;
grant execute on function list_chat_threads() to authenticated;
notify pgrst, 'reload schema';

-- 18. Member search and friend requests (v18) ------------------------------
-- Members search each other by name or company, send a friend request, and chat once it is
-- accepted. A rejected request cannot be sent again. Each member may send 20 requests a day.
alter table customers add column if not exists discoverable boolean not null default true;
grant update (discoverable) on customers to authenticated;

create table if not exists chat_friend_requests (
  id uuid primary key default gen_random_uuid(),
  from_id uuid not null references auth.users(id) on delete cascade,
  to_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (from_id <> to_id),
  unique (from_id, to_id)
);
alter table chat_friend_requests enable row level security;
-- No direct table access from the browser: everything goes through the functions below.

create or replace function search_members(p_query text)
returns table (user_id uuid, display_name text, company_name text, relation text, thread_id uuid)
language sql stable security definer set search_path = public
as $$
  select
    c.user_id,
    coalesce(c.company_name, c.name),
    c.company_name,
    case
      when exists (select 1 from chat_threads t where (t.user_a = least(auth.uid(), c.user_id) and t.user_b = greatest(auth.uid(), c.user_id))) then 'friend'
      when exists (select 1 from chat_friend_requests r where r.from_id = auth.uid() and r.to_id = c.user_id and r.status = 'pending') then 'sent'
      when exists (select 1 from chat_friend_requests r where r.from_id = c.user_id and r.to_id = auth.uid() and r.status = 'pending') then 'received'
      when exists (select 1 from chat_friend_requests r where r.from_id = auth.uid() and r.to_id = c.user_id and r.status = 'rejected') then 'rejected'
      else 'none'
    end,
    (select t.id from chat_threads t where t.user_a = least(auth.uid(), c.user_id) and t.user_b = greatest(auth.uid(), c.user_id))
  from customers c
  where auth.uid() is not null
    and c.discoverable
    and c.user_id <> auth.uid()
    and char_length(trim(p_query)) >= 2
    and (c.company_name ilike '%' || trim(p_query) || '%' or c.name ilike '%' || trim(p_query) || '%')
    and not is_blocked_between(c.user_id, auth.uid())
  order by coalesce(c.company_name, c.name)
  limit 20
$$;

create or replace function send_friend_request(p_to uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  rid uuid;
  today_count int;
begin
  if me is null then raise exception '로그인이 필요해요'; end if;
  if p_to = me then raise exception '자기 자신에게는 신청할 수 없어요'; end if;
  if not exists (select 1 from customers where user_id = p_to and discoverable) then
    raise exception '이 회원에게는 신청할 수 없어요';
  end if;
  if is_blocked_between(me, p_to) then raise exception '이 회원에게는 신청할 수 없어요'; end if;
  if exists (select 1 from chat_friend_requests where from_id = p_to and to_id = me and status = 'pending') then
    raise exception '상대가 먼저 신청했어요. 받은 신청에서 수락해 주세요';
  end if;
  if exists (select 1 from chat_friend_requests where from_id = me and to_id = p_to and status = 'accepted') then
    raise exception '이미 친구예요';
  end if;
  if exists (select 1 from chat_friend_requests where from_id = me and to_id = p_to and status = 'pending') then
    raise exception '이미 신청했어요. 상대의 답을 기다려 주세요';
  end if;
  if exists (select 1 from chat_friend_requests where from_id = me and to_id = p_to and status = 'rejected') then
    raise exception '거절된 신청은 다시 보낼 수 없어요';
  end if;
  select count(*) into today_count from chat_friend_requests
    where from_id = me and created_at > now() - interval '1 day';
  if today_count >= 20 then raise exception '하루에 보낼 수 있는 친구 신청(20건)을 모두 썼어요'; end if;

  insert into chat_friend_requests (from_id, to_id) values (me, p_to) returning id into rid;
  return rid;
end;
$$;

create or replace function respond_friend_request(p_id uuid, p_accept boolean)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  r chat_friend_requests%rowtype;
  tid uuid;
begin
  if me is null then raise exception '로그인이 필요해요'; end if;
  select * into r from chat_friend_requests where id = p_id and to_id = me and status = 'pending';
  if not found then raise exception '처리할 신청을 찾지 못했어요'; end if;

  if not p_accept then
    update chat_friend_requests set status = 'rejected', responded_at = now() where id = r.id;
    return null;
  end if;

  update chat_friend_requests set status = 'accepted', responded_at = now() where id = r.id;
  insert into chat_threads (user_a, user_b)
  values (least(r.from_id, r.to_id), greatest(r.from_id, r.to_id))
  on conflict (user_a, user_b) do update set user_a = excluded.user_a
  returning id into tid;
  return tid;
end;
$$;

create or replace function list_friend_requests()
returns table (
  request_id uuid, direction text, other_id uuid, display_name text, created_at timestamptz
)
language sql stable security definer set search_path = public
as $$
  select r.id,
         case when r.to_id = auth.uid() then 'received' else 'sent' end,
         case when r.to_id = auth.uid() then r.from_id else r.to_id end,
         (select coalesce(c.company_name, c.name) from customers c
            where c.user_id = case when r.to_id = auth.uid() then r.from_id else r.to_id end),
         r.created_at
  from chat_friend_requests r
  where r.status = 'pending' and (r.from_id = auth.uid() or r.to_id = auth.uid())
  order by r.created_at desc
$$;

-- Chat is allowed only between accepted friends.
create or replace function open_chat(p_other uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  tid uuid;
begin
  if me is null then raise exception '로그인이 필요해요'; end if;
  if p_other = me then raise exception '자기 자신과는 대화할 수 없어요'; end if;
  if is_blocked_between(me, p_other) then raise exception '대화할 수 없는 상대예요'; end if;
  select t.id into tid from chat_threads t
    where t.user_a = least(me, p_other) and t.user_b = greatest(me, p_other);
  if tid is null then raise exception '친구가 된 뒤에 대화할 수 있어요'; end if;
  return tid;
end;
$$;

grant execute on function search_members(text) to authenticated;
grant execute on function send_friend_request(uuid) to authenticated;
grant execute on function respond_friend_request(uuid, boolean) to authenticated;
grant execute on function list_friend_requests() to authenticated;
grant execute on function open_chat(uuid) to authenticated;
notify pgrst, 'reload schema';

-- 19. Add friend instantly (v19) ------------------------------------------
-- Like KakaoTalk: adding a member makes them a friend at once and opens the conversation.
-- No accept/reject step. Protection comes from block, report and a limit of 20 new friends a day.
drop function if exists respond_friend_request(uuid, boolean);
drop function if exists list_friend_requests();

create or replace function send_friend_request(p_to uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  tid uuid;
  today_count int;
begin
  if me is null then raise exception '로그인이 필요해요'; end if;
  if p_to = me then raise exception '자기 자신과는 친구가 될 수 없어요'; end if;
  if not exists (select 1 from customers where user_id = p_to and discoverable) then
    raise exception '이 회원을 추가할 수 없어요';
  end if;
  if is_blocked_between(me, p_to) then raise exception '이 회원을 추가할 수 없어요'; end if;

  -- Already friends: just return the conversation.
  select t.id into tid from chat_threads t
    where t.user_a = least(me, p_to) and t.user_b = greatest(me, p_to);
  if tid is not null then return tid; end if;

  select count(*) into today_count from chat_friend_requests
    where from_id = me and created_at > now() - interval '1 day';
  if today_count >= 20 then raise exception '하루에 추가할 수 있는 친구는 20명까지예요'; end if;

  insert into chat_friend_requests (from_id, to_id, status, responded_at)
  values (me, p_to, 'accepted', now())
  on conflict (from_id, to_id) do update set status = 'accepted', responded_at = now();

  insert into chat_threads (user_a, user_b)
  values (least(me, p_to), greatest(me, p_to))
  on conflict (user_a, user_b) do update set user_a = excluded.user_a
  returning id into tid;
  return tid;
end;
$$;
grant execute on function send_friend_request(uuid) to authenticated;
notify pgrst, 'reload schema';

-- 20. No daily limit on adding friends (v20) ---------------------------------
-- Removes the 20-per-day cap. Reports (신고) remain the only way to flag unwanted contact.
create or replace function send_friend_request(p_to uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  tid uuid;
begin
  if me is null then raise exception '로그인이 필요해요'; end if;
  if p_to = me then raise exception '자기 자신과는 친구가 될 수 없어요'; end if;
  if not exists (select 1 from customers where user_id = p_to and discoverable) then
    raise exception '이 회원을 추가할 수 없어요';
  end if;

  select t.id into tid from chat_threads t
    where t.user_a = least(me, p_to) and t.user_b = greatest(me, p_to);
  if tid is not null then return tid; end if;

  insert into chat_friend_requests (from_id, to_id, status, responded_at)
  values (me, p_to, 'accepted', now())
  on conflict (from_id, to_id) do update set status = 'accepted', responded_at = now();

  insert into chat_threads (user_a, user_b)
  values (least(me, p_to), greatest(me, p_to))
  on conflict (user_a, user_b) do update set user_a = excluded.user_a
  returning id into tid;
  return tid;
end;
$$;
grant execute on function send_friend_request(uuid) to authenticated;
notify pgrst, 'reload schema';
