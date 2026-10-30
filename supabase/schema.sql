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

-- 21. Nicknames and leaving a conversation (v21) ---------------------------
-- Both are per member: a nickname only I see, and "leave" only hides the room from my list.
-- A hidden room comes back by itself when the other person sends a new message.
create table if not exists chat_thread_prefs (
  user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references chat_threads(id) on delete cascade,
  alias text check (char_length(alias) <= 30),
  hidden_at timestamptz,
  primary key (user_id, thread_id)
);
alter table chat_thread_prefs enable row level security;

drop policy if exists chat_thread_prefs_own on chat_thread_prefs;
create policy chat_thread_prefs_own on chat_thread_prefs for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from chat_threads t
      where t.id = thread_id and (t.user_a = auth.uid() or t.user_b = auth.uid())
    )
  );

create or replace function set_chat_alias(p_thread uuid, p_alias text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  clean text := nullif(trim(coalesce(p_alias, '')), '');
begin
  if me is null then raise exception '로그인이 필요해요'; end if;
  if not exists (select 1 from chat_threads t where t.id = p_thread and (t.user_a = me or t.user_b = me)) then
    raise exception '대화를 찾을 수 없어요';
  end if;
  insert into chat_thread_prefs (user_id, thread_id, alias) values (me, p_thread, clean)
  on conflict (user_id, thread_id) do update set alias = excluded.alias;
end;
$$;

create or replace function leave_chat(p_thread uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception '로그인이 필요해요'; end if;
  if not exists (select 1 from chat_threads t where t.id = p_thread and (t.user_a = me or t.user_b = me)) then
    raise exception '대화를 찾을 수 없어요';
  end if;
  insert into chat_thread_prefs (user_id, thread_id, hidden_at) values (me, p_thread, now())
  on conflict (user_id, thread_id) do update set hidden_at = excluded.hidden_at;
end;
$$;

-- Opening a conversation (also from search) brings it back into my list.
create or replace function get_chat_thread(p_id uuid)
returns table (partner_id uuid, partner_company text, alias text, pinned boolean)
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception '로그인이 필요해요'; end if;
  if not exists (select 1 from chat_threads t where t.id = p_id and (t.user_a = me or t.user_b = me)) then
    return;
  end if;
  update chat_thread_prefs set hidden_at = null where user_id = me and thread_id = p_id;
  return query
    select
      case when t.user_a = me then t.user_b else t.user_a end,
      (select coalesce(c.company_name, c.name) from customers c
        where c.user_id = case when t.user_a = me then t.user_b else t.user_a end),
      (select p.alias from chat_thread_prefs p where p.user_id = me and p.thread_id = t.id),
      exists (select 1 from chat_pins p where p.user_id = me and p.thread_id = t.id)
    from chat_threads t
    where t.id = p_id;
end;
$$;

drop function if exists list_chat_threads();
create function list_chat_threads()
returns table (
  thread_id uuid, partner_id uuid, partner_company text, alias text,
  last_message_at timestamptz, last_body text, unread int, pinned boolean
)
language sql stable security definer set search_path = public
as $$
  select
    t.id,
    case when t.user_a = auth.uid() then t.user_b else t.user_a end,
    (select coalesce(c.company_name, c.name) from customers c
      where c.user_id = case when t.user_a = auth.uid() then t.user_b else t.user_a end),
    (select p.alias from chat_thread_prefs p where p.user_id = auth.uid() and p.thread_id = t.id),
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
    and not exists (
      select 1 from chat_thread_prefs p
      where p.thread_id = t.id and p.user_id = auth.uid()
        and p.hidden_at is not null and t.last_message_at <= p.hidden_at
    )
  order by
    exists (select 1 from chat_pins p where p.thread_id = t.id and p.user_id = auth.uid()) desc,
    t.last_message_at desc
$$;

grant execute on function set_chat_alias(uuid, text) to authenticated;
grant execute on function leave_chat(uuid) to authenticated;
grant execute on function get_chat_thread(uuid) to authenticated;
grant execute on function list_chat_threads() to authenticated;
notify pgrst, 'reload schema';

-- 22. Group chats (v22) -----------------------------------------------------
-- Group rooms keep their members in chat_members. Only friends can be added. Leaving a group is
-- quiet: no message is posted. 1:1 rooms keep user_a / user_b as before.
alter table chat_threads drop constraint if exists chat_threads_check;
alter table chat_threads alter column user_a drop not null;
alter table chat_threads alter column user_b drop not null;
alter table chat_threads add column if not exists is_group boolean not null default false;
alter table chat_threads add column if not exists title text check (char_length(title) <= 40);
alter table chat_threads drop constraint if exists chat_threads_shape;
alter table chat_threads add constraint chat_threads_shape check (
  (is_group and user_a is null and user_b is null) or (not is_group and user_a < user_b)
);

create table if not exists chat_members (
  thread_id uuid not null references chat_threads(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (thread_id, user_id)
);
alter table chat_members enable row level security;

create or replace function is_thread_member(p_thread uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from chat_threads t
    where t.id = p_thread and not t.is_group and (t.user_a = p_user or t.user_b = p_user)
  ) or exists (
    select 1 from chat_members m
    where m.thread_id = p_thread and m.user_id = p_user and m.left_at is null
  )
$$;

create or replace function is_friend(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from chat_threads t
    where not t.is_group and t.user_a = least(a, b) and t.user_b = greatest(a, b)
  )
$$;

drop policy if exists chat_threads_member_select on chat_threads;
create policy chat_threads_member_select on chat_threads for select to authenticated
  using (is_thread_member(id, auth.uid()));

drop policy if exists chat_messages_member_select on chat_messages;
create policy chat_messages_member_select on chat_messages for select to authenticated
  using (is_thread_member(thread_id, auth.uid()));

drop policy if exists chat_messages_member_insert on chat_messages;
create policy chat_messages_member_insert on chat_messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and is_business_user(auth.uid())
    and is_thread_member(thread_id, auth.uid())
    and (catalog_slug is null or exists (
      select 1 from flipbooks f where f.slug = catalog_slug and f.user_id = auth.uid()
    ))
  );

drop policy if exists chat_members_select on chat_members;
create policy chat_members_select on chat_members for select to authenticated
  using (is_thread_member(thread_id, auth.uid()));

drop policy if exists chat_pins_own on chat_pins;
create policy chat_pins_own on chat_pins for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and is_thread_member(thread_id, auth.uid()));

drop policy if exists chat_thread_prefs_own on chat_thread_prefs;
create policy chat_thread_prefs_own on chat_thread_prefs for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and is_thread_member(thread_id, auth.uid()));

create or replace function create_group_chat(p_title text, p_members uuid[])
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  tid uuid;
  m uuid;
  picked int := 0;
begin
  if me is null then raise exception '로그인이 필요해요'; end if;
  foreach m in array coalesce(p_members, '{}') loop
    if m = me then continue; end if;
    if not is_friend(me, m) then raise exception '친구만 단체 대화에 넣을 수 있어요'; end if;
    picked := picked + 1;
  end loop;
  if picked < 1 then raise exception '대화할 친구를 한 명 이상 골라 주세요'; end if;

  insert into chat_threads (is_group, title) values (true, nullif(trim(coalesce(p_title, '')), ''))
  returning id into tid;
  insert into chat_members (thread_id, user_id) values (tid, me);
  foreach m in array coalesce(p_members, '{}') loop
    if m <> me then
      insert into chat_members (thread_id, user_id) values (tid, m)
      on conflict (thread_id, user_id) do nothing;
    end if;
  end loop;
  return tid;
end;
$$;

create or replace function add_group_members(p_thread uuid, p_members uuid[])
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  m uuid;
begin
  if me is null then raise exception '로그인이 필요해요'; end if;
  if not exists (select 1 from chat_threads t where t.id = p_thread and t.is_group)
     or not is_thread_member(p_thread, me) then
    raise exception '대화를 찾을 수 없어요';
  end if;
  foreach m in array coalesce(p_members, '{}') loop
    if m <> me and not is_friend(me, m) then raise exception '친구만 초대할 수 있어요'; end if;
  end loop;
  foreach m in array coalesce(p_members, '{}') loop
    if m <> me then
      insert into chat_members (thread_id, user_id) values (p_thread, m)
      on conflict (thread_id, user_id) do update set left_at = null;
    end if;
  end loop;
end;
$$;

create or replace function list_my_friends()
returns table (user_id uuid, display_name text)
language sql stable security definer set search_path = public
as $$
  select
    case when t.user_a = auth.uid() then t.user_b else t.user_a end,
    (select coalesce(c.company_name, c.name) from customers c
      where c.user_id = case when t.user_a = auth.uid() then t.user_b else t.user_a end)
  from chat_threads t
  where not t.is_group and (t.user_a = auth.uid() or t.user_b = auth.uid())
  order by 2
$$;

create or replace function get_chat_members(p_thread uuid)
returns table (user_id uuid, display_name text)
language sql stable security definer set search_path = public
as $$
  select u.uid, coalesce(c.company_name, c.name)
  from (
    select m.user_id as uid from chat_members m where m.thread_id = p_thread and m.left_at is null
    union
    select t.user_a from chat_threads t where t.id = p_thread and not t.is_group
    union
    select t.user_b from chat_threads t where t.id = p_thread and not t.is_group
  ) u
  left join customers c on c.user_id = u.uid
  where u.uid is not null and is_thread_member(p_thread, auth.uid())
$$;

drop function if exists get_chat_thread(uuid);
create function get_chat_thread(p_id uuid)
returns table (partner_id uuid, partner_company text, alias text, pinned boolean, is_group boolean)
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not is_thread_member(p_id, me) then return; end if;
  update chat_thread_prefs set hidden_at = null where user_id = me and thread_id = p_id;
  return query
    select
      case when t.is_group then null else case when t.user_a = me then t.user_b else t.user_a end end,
      case when t.is_group then coalesce(t.title, (
        select string_agg(x.n, ', ') from (
          select coalesce(c.company_name, c.name) as n from chat_members m
            join customers c on c.user_id = m.user_id
           where m.thread_id = t.id and m.left_at is null and m.user_id <> me
           limit 3) x))
      else (select coalesce(c.company_name, c.name) from customers c
              where c.user_id = case when t.user_a = me then t.user_b else t.user_a end)
      end,
      (select p.alias from chat_thread_prefs p where p.user_id = me and p.thread_id = t.id),
      exists (select 1 from chat_pins p where p.user_id = me and p.thread_id = t.id),
      t.is_group
    from chat_threads t
    where t.id = p_id;
end;
$$;

drop function if exists list_chat_threads();
create function list_chat_threads()
returns table (
  thread_id uuid, partner_id uuid, partner_company text, alias text,
  last_message_at timestamptz, last_body text, unread int, pinned boolean, is_group boolean
)
language sql stable security definer set search_path = public
as $$
  select
    t.id,
    case when t.is_group then null else case when t.user_a = auth.uid() then t.user_b else t.user_a end end,
    case when t.is_group then coalesce(t.title, (
      select string_agg(x.n, ', ') from (
        select coalesce(c.company_name, c.name) as n from chat_members m
          join customers c on c.user_id = m.user_id
         where m.thread_id = t.id and m.left_at is null and m.user_id <> auth.uid()
         limit 3) x))
    else (select coalesce(c.company_name, c.name) from customers c
            where c.user_id = case when t.user_a = auth.uid() then t.user_b else t.user_a end)
    end,
    (select p.alias from chat_thread_prefs p where p.user_id = auth.uid() and p.thread_id = t.id),
    t.last_message_at,
    (select case when m.body <> '' then m.body else '[카탈로그] ' || coalesce(m.catalog_title, '') end
       from chat_messages m where m.thread_id = t.id order by m.created_at desc limit 1),
    (select count(*)::int from chat_messages m
       where m.thread_id = t.id and m.sender_id <> auth.uid()
         and m.created_at > coalesce(
           (select r.last_read_at from chat_reads r where r.thread_id = t.id and r.user_id = auth.uid()),
           'epoch'::timestamptz)),
    exists (select 1 from chat_pins p where p.thread_id = t.id and p.user_id = auth.uid()),
    t.is_group
  from chat_threads t
  where is_thread_member(t.id, auth.uid())
    and not exists (
      select 1 from chat_thread_prefs p
      where p.thread_id = t.id and p.user_id = auth.uid()
        and p.hidden_at is not null and t.last_message_at <= p.hidden_at
    )
  order by
    exists (select 1 from chat_pins p where p.thread_id = t.id and p.user_id = auth.uid()) desc,
    t.last_message_at desc
$$;

create or replace function set_chat_alias(p_thread uuid, p_alias text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  clean text := nullif(trim(coalesce(p_alias, '')), '');
begin
  if me is null or not is_thread_member(p_thread, me) then raise exception '대화를 찾을 수 없어요'; end if;
  insert into chat_thread_prefs (user_id, thread_id, alias) values (me, p_thread, clean)
  on conflict (user_id, thread_id) do update set alias = excluded.alias;
end;
$$;

-- Groups: leaving is quiet (no notice). 1:1: the room only disappears from my list.
create or replace function leave_chat(p_thread uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  grp boolean;
begin
  if me is null or not is_thread_member(p_thread, me) then raise exception '대화를 찾을 수 없어요'; end if;
  select t.is_group into grp from chat_threads t where t.id = p_thread;
  if grp then
    update chat_members set left_at = now() where thread_id = p_thread and user_id = me;
  else
    insert into chat_thread_prefs (user_id, thread_id, hidden_at) values (me, p_thread, now())
    on conflict (user_id, thread_id) do update set hidden_at = excluded.hidden_at;
  end if;
end;
$$;

grant execute on function create_group_chat(text, uuid[]) to authenticated;
grant execute on function add_group_members(uuid, uuid[]) to authenticated;
grant execute on function list_my_friends() to authenticated;
grant execute on function get_chat_members(uuid) to authenticated;
grant execute on function get_chat_thread(uuid) to authenticated;
grant execute on function list_chat_threads() to authenticated;
grant execute on function set_chat_alias(uuid, text) to authenticated;
grant execute on function leave_chat(uuid) to authenticated;
notify pgrst, 'reload schema';

-- 23. Read receipts (v23) ---------------------------------------------------
-- Each member can turn read receipts off. When off, neither side sees the other's read status.
create table if not exists chat_user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  read_receipts boolean not null default true
);
alter table chat_user_settings enable row level security;

drop policy if exists chat_user_settings_own on chat_user_settings;
create policy chat_user_settings_own on chat_user_settings for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create or replace function get_my_read_receipts()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select s.read_receipts from chat_user_settings s where s.user_id = auth.uid()), true)
$$;

create or replace function set_read_receipts(p_on boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception '로그인이 필요해요'; end if;
  insert into chat_user_settings (user_id, read_receipts) values (auth.uid(), p_on)
  on conflict (user_id) do update set read_receipts = excluded.read_receipts;
end;
$$;

-- Other members' last read times in one room. Empty when the caller has receipts off,
-- and members who have receipts off are left out.
create or replace function get_read_status(p_thread uuid)
returns table (user_id uuid, last_read_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not is_thread_member(p_thread, me) then return; end if;
  if not get_my_read_receipts() then return; end if;
  return query
    select r.user_id, r.last_read_at
    from chat_reads r
    where r.thread_id = p_thread
      and r.user_id <> me
      and is_thread_member(p_thread, r.user_id)
      and coalesce((select s.read_receipts from chat_user_settings s where s.user_id = r.user_id), true);
end;
$$;

grant execute on function get_my_read_receipts() to authenticated;
grant execute on function set_read_receipts(boolean) to authenticated;
grant execute on function get_read_status(uuid) to authenticated;
notify pgrst, 'reload schema';

-- 24. Recommendations, blocking, company-first search (v24) ----------------
-- Blocking is two-way: neither side can message, add, or see the other in lists.
-- Blocked 1:1 rooms disappear from both lists; history stays in the database.

create or replace function recommend_members()
returns table (user_id uuid, display_name text, company_name text)
language sql stable security definer set search_path = public
as $$
  select c.user_id, coalesce(c.company_name, c.name), c.company_name
  from customers c
  where auth.uid() is not null
    and c.discoverable
    and c.user_id <> auth.uid()
    and not is_blocked_between(c.user_id, auth.uid())
    and not exists (
      select 1 from chat_threads t
      where not t.is_group and t.user_a = least(auth.uid(), c.user_id) and t.user_b = greatest(auth.uid(), c.user_id)
    )
  order by c.created_at desc
  limit 10
$$;

create or replace function block_user(p_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception '로그인이 필요해요'; end if;
  if p_user = auth.uid() then raise exception '자기 자신은 차단할 수 없어요'; end if;
  insert into chat_blocks (blocker_id, blocked_id) values (auth.uid(), p_user)
  on conflict (blocker_id, blocked_id) do nothing;
end;
$$;

create or replace function unblock_user(p_user uuid)
returns void
language sql security definer set search_path = public
as $$
  delete from chat_blocks where blocker_id = auth.uid() and blocked_id = p_user
$$;

create or replace function list_blocked_users()
returns table (user_id uuid, display_name text)
language sql stable security definer set search_path = public
as $$
  select b.blocked_id, coalesce(c.company_name, c.name)
  from chat_blocks b
  left join customers c on c.user_id = b.blocked_id
  where b.blocker_id = auth.uid()
  order by b.created_at desc
$$;

-- Company-name matches first.
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
  order by (c.company_name ilike '%' || trim(p_query) || '%') desc, coalesce(c.company_name, c.name)
  limit 20
$$;

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
  if not exists (select 1 from customers where user_id = p_to and discoverable) or is_blocked_between(me, p_to) then
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

create or replace function list_my_friends()
returns table (user_id uuid, display_name text)
language sql stable security definer set search_path = public
as $$
  select
    case when t.user_a = auth.uid() then t.user_b else t.user_a end,
    (select coalesce(c.company_name, c.name) from customers c
      where c.user_id = case when t.user_a = auth.uid() then t.user_b else t.user_a end)
  from chat_threads t
  where not t.is_group
    and (t.user_a = auth.uid() or t.user_b = auth.uid())
    and not is_blocked_between(t.user_a, t.user_b)
  order by 2
$$;

drop policy if exists chat_messages_member_insert on chat_messages;
create policy chat_messages_member_insert on chat_messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and is_business_user(auth.uid())
    and is_thread_member(thread_id, auth.uid())
    and not exists (
      select 1 from chat_threads t
      where t.id = thread_id and not t.is_group and is_blocked_between(t.user_a, t.user_b)
    )
    and (catalog_slug is null or exists (
      select 1 from flipbooks f where f.slug = catalog_slug and f.user_id = auth.uid()
    ))
  );

drop function if exists list_chat_threads();
create function list_chat_threads()
returns table (
  thread_id uuid, partner_id uuid, partner_company text, alias text,
  last_message_at timestamptz, last_body text, unread int, pinned boolean, is_group boolean
)
language sql stable security definer set search_path = public
as $$
  select
    t.id,
    case when t.is_group then null else case when t.user_a = auth.uid() then t.user_b else t.user_a end end,
    case when t.is_group then coalesce(t.title, (
      select string_agg(x.n, ', ') from (
        select coalesce(c.company_name, c.name) as n from chat_members m
          join customers c on c.user_id = m.user_id
         where m.thread_id = t.id and m.left_at is null and m.user_id <> auth.uid()
         limit 3) x))
    else (select coalesce(c.company_name, c.name) from customers c
            where c.user_id = case when t.user_a = auth.uid() then t.user_b else t.user_a end)
    end,
    (select p.alias from chat_thread_prefs p where p.user_id = auth.uid() and p.thread_id = t.id),
    t.last_message_at,
    (select case when m.body <> '' then m.body else '[카탈로그] ' || coalesce(m.catalog_title, '') end
       from chat_messages m where m.thread_id = t.id order by m.created_at desc limit 1),
    (select count(*)::int from chat_messages m
       where m.thread_id = t.id and m.sender_id <> auth.uid()
         and m.created_at > coalesce(
           (select r.last_read_at from chat_reads r where r.thread_id = t.id and r.user_id = auth.uid()),
           'epoch'::timestamptz)),
    exists (select 1 from chat_pins p where p.thread_id = t.id and p.user_id = auth.uid()),
    t.is_group
  from chat_threads t
  where is_thread_member(t.id, auth.uid())
    and not (not t.is_group and is_blocked_between(t.user_a, t.user_b))
    and not exists (
      select 1 from chat_thread_prefs p
      where p.thread_id = t.id and p.user_id = auth.uid()
        and p.hidden_at is not null and t.last_message_at <= p.hidden_at
    )
  order by
    exists (select 1 from chat_pins p where p.thread_id = t.id and p.user_id = auth.uid()) desc,
    t.last_message_at desc
$$;

grant execute on function recommend_members() to authenticated;
grant execute on function block_user(uuid) to authenticated;
grant execute on function unblock_user(uuid) to authenticated;
grant execute on function list_blocked_users() to authenticated;
grant execute on function search_members(text) to authenticated;
grant execute on function send_friend_request(uuid) to authenticated;
grant execute on function list_my_friends() to authenticated;
grant execute on function list_chat_threads() to authenticated;
notify pgrst, 'reload schema';

-- 25. Photo and PDF messages (v25) ----------------------------------------
-- Files are stored in the private bucket "chat-files" and sent through /api/chat/upload.
-- Downloads go through /api/chat/file, which checks membership and issues a short signed link.
alter table chat_messages add column if not exists file_path text;
alter table chat_messages add column if not exists file_name text;
alter table chat_messages add column if not exists file_type text;
alter table chat_messages add column if not exists file_size int;
alter table chat_messages drop constraint if exists chat_messages_check;
alter table chat_messages add constraint chat_messages_has_content check (
  char_length(body) > 0 or catalog_slug is not null or file_path is not null
);

insert into storage.buckets (id, name, public) values ('chat-files', 'chat-files', false)
on conflict (id) do nothing;

drop function if exists list_chat_threads();
create function list_chat_threads()
returns table (
  thread_id uuid, partner_id uuid, partner_company text, alias text,
  last_message_at timestamptz, last_body text, unread int, pinned boolean, is_group boolean
)
language sql stable security definer set search_path = public
as $$
  select
    t.id,
    case when t.is_group then null else case when t.user_a = auth.uid() then t.user_b else t.user_a end end,
    case when t.is_group then coalesce(t.title, (
      select string_agg(x.n, ', ') from (
        select coalesce(c.company_name, c.name) as n from chat_members m
          join customers c on c.user_id = m.user_id
         where m.thread_id = t.id and m.left_at is null and m.user_id <> auth.uid()
         limit 3) x))
    else (select coalesce(c.company_name, c.name) from customers c
            where c.user_id = case when t.user_a = auth.uid() then t.user_b else t.user_a end)
    end,
    (select p.alias from chat_thread_prefs p where p.user_id = auth.uid() and p.thread_id = t.id),
    t.last_message_at,
    (select case
              when m.body <> '' then m.body
              when m.file_path is not null and m.file_type like 'image/%' then '[사진]'
              when m.file_path is not null then '[파일] ' || coalesce(m.file_name, '')
              else '[카탈로그] ' || coalesce(m.catalog_title, '')
            end
       from chat_messages m where m.thread_id = t.id order by m.created_at desc limit 1),
    (select count(*)::int from chat_messages m
       where m.thread_id = t.id and m.sender_id <> auth.uid()
         and m.created_at > coalesce(
           (select r.last_read_at from chat_reads r where r.thread_id = t.id and r.user_id = auth.uid()),
           'epoch'::timestamptz)),
    exists (select 1 from chat_pins p where p.thread_id = t.id and p.user_id = auth.uid()),
    t.is_group
  from chat_threads t
  where is_thread_member(t.id, auth.uid())
    and not (not t.is_group and is_blocked_between(t.user_a, t.user_b))
    and not exists (
      select 1 from chat_thread_prefs p
      where p.thread_id = t.id and p.user_id = auth.uid()
        and p.hidden_at is not null and t.last_message_at <= p.hidden_at
    )
  order by
    exists (select 1 from chat_pins p where p.thread_id = t.id and p.user_id = auth.uid()) desc,
    t.last_message_at desc
$$;

grant execute on function list_chat_threads() to authenticated;
notify pgrst, 'reload schema';

-- 26. Report handling (v26) ------------------------------------------------
-- Operators review reports on the admin page: resolve, dismiss, or remove the reported message.
alter table chat_reports add column if not exists status text not null default 'open';
alter table chat_reports drop constraint if exists chat_reports_status_check;
alter table chat_reports add constraint chat_reports_status_check check (status in ('open', 'resolved', 'dismissed'));
alter table chat_reports add column if not exists handled_at timestamptz;
create index if not exists chat_reports_status_idx on chat_reports (status, created_at desc);
notify pgrst, 'reload schema';

-- 27. Rate limits against spam (v27) ---------------------------------------
-- Generous limits that normal use never reaches. Friend requests are limited per hour, not per day.
-- Messages: 300 per member per hour. Friend additions: 30 per member per hour.
create index if not exists chat_messages_sender_time_idx on chat_messages (sender_id, created_at desc);

create or replace function enforce_message_rate()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if (select count(*) from chat_messages m
       where m.sender_id = new.sender_id and m.created_at > now() - interval '1 hour') >= 300 then
    raise exception 'RATE_LIMIT: 메시지를 너무 많이 보냈어요. 잠시 후 다시 보내 주세요';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_messages_rate on chat_messages;
create trigger chat_messages_rate
  before insert on chat_messages
  for each row execute function enforce_message_rate();

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
  if not exists (select 1 from customers where user_id = p_to and discoverable) or is_blocked_between(me, p_to) then
    raise exception '이 회원을 추가할 수 없어요';
  end if;

  select t.id into tid from chat_threads t
    where t.user_a = least(me, p_to) and t.user_b = greatest(me, p_to);
  if tid is not null then return tid; end if;

  if (select count(*) from chat_friend_requests r
        where r.from_id = me and r.responded_at > now() - interval '1 hour') >= 30 then
    raise exception 'RATE_LIMIT: 친구 추가를 너무 많이 했어요. 잠시 후 다시 시도해 주세요';
  end if;

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

-- 28. Hide a member inside a group (v28) ----------------------------------
-- A member can hide another member's messages in a group room. Only the hider stops seeing them;
-- the other person and the rest of the room are not affected. Works for group rooms only.
create table if not exists chat_mutes (
  user_id uuid not null references auth.users(id) on delete cascade,
  muted_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, muted_id)
);
alter table chat_mutes enable row level security;

drop policy if exists chat_mutes_own on chat_mutes;
create policy chat_mutes_own on chat_mutes for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists chat_messages_member_select on chat_messages;
create policy chat_messages_member_select on chat_messages for select to authenticated
  using (
    is_thread_member(thread_id, auth.uid())
    and not exists (
      select 1 from chat_mutes x
      where x.user_id = auth.uid() and x.muted_id = chat_messages.sender_id
    )
  );

create or replace function mute_member(p_thread uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or not is_thread_member(p_thread, auth.uid()) then
    raise exception '대화를 찾을 수 없어요';
  end if;
  if not exists (select 1 from chat_threads t where t.id = p_thread and t.is_group) then
    raise exception '단체 대화에서만 숨길 수 있어요';
  end if;
  if p_user = auth.uid() then raise exception '자기 자신은 숨길 수 없어요'; end if;
  insert into chat_mutes (user_id, muted_id) values (auth.uid(), p_user)
  on conflict (user_id, muted_id) do nothing;
end;
$$;

create or replace function unmute_member(p_user uuid)
returns void
language sql security definer set search_path = public
as $$
  delete from chat_mutes where user_id = auth.uid() and muted_id = p_user
$$;

create or replace function list_muted_members()
returns table (user_id uuid, display_name text)
language sql stable security definer set search_path = public
as $$
  select x.muted_id, coalesce(c.company_name, c.name)
  from chat_mutes x
  left join customers c on c.user_id = x.muted_id
  where x.user_id = auth.uid()
  order by x.created_at desc
$$;

grant execute on function mute_member(uuid, uuid) to authenticated;
grant execute on function unmute_member(uuid) to authenticated;
grant execute on function list_muted_members() to authenticated;
notify pgrst, 'reload schema';

-- 29. Auto-delete timer and expiry (v29) ----------------------------------------
-- Each room can set a timer (1 hour, 1 day, 1 week). Messages older than the timer disappear at once
-- from every member's view, and a daily job removes them and their files for good.
alter table chat_threads add column if not exists auto_delete_hours int;
alter table chat_threads drop constraint if exists chat_threads_auto_delete_check;
-- Any period from 1 day to 1 year, in hours.
alter table chat_threads add constraint chat_threads_auto_delete_check check (auto_delete_hours between 24 and 8760);

drop policy if exists chat_messages_member_select on chat_messages;
create policy chat_messages_member_select on chat_messages for select to authenticated
  using (
    is_thread_member(thread_id, auth.uid())
    and not exists (
      select 1 from chat_mutes x
      where x.user_id = auth.uid() and x.muted_id = chat_messages.sender_id
    )
    and not exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id
        and t.auto_delete_hours is not null
        and chat_messages.created_at < now() - make_interval(hours => t.auto_delete_hours)
    )
  );

create or replace function set_auto_delete(p_thread uuid, p_hours int)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or not is_thread_member(p_thread, auth.uid()) then
    raise exception '대화를 찾을 수 없어요';
  end if;
  if p_hours is not null and (p_hours < 24 or p_hours > 8760) then
    raise exception '자동 삭제는 1일에서 1년 사이로 정해 주세요';
  end if;
  update chat_threads set auto_delete_hours = p_hours where id = p_thread;
end;
$$;

drop function if exists get_chat_thread(uuid);
create function get_chat_thread(p_id uuid)
returns table (partner_id uuid, partner_company text, alias text, pinned boolean, is_group boolean, auto_delete_hours int)
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not is_thread_member(p_id, me) then return; end if;
  update chat_thread_prefs set hidden_at = null where user_id = me and thread_id = p_id;
  return query
    select
      case when t.is_group then null else case when t.user_a = me then t.user_b else t.user_a end end,
      case when t.is_group then coalesce(t.title, (
        select string_agg(x.n, ', ') from (
          select coalesce(c.company_name, c.name) as n from chat_members m
            join customers c on c.user_id = m.user_id
           where m.thread_id = t.id and m.left_at is null and m.user_id <> me
           limit 3) x))
      else (select coalesce(c.company_name, c.name) from customers c
              where c.user_id = case when t.user_a = me then t.user_b else t.user_a end)
      end,
      (select p.alias from chat_thread_prefs p where p.user_id = me and p.thread_id = t.id),
      exists (select 1 from chat_pins p where p.user_id = me and p.thread_id = t.id),
      t.is_group,
      t.auto_delete_hours
    from chat_threads t
    where t.id = p_id;
end;
$$;

grant execute on function set_auto_delete(uuid, int) to authenticated;
grant execute on function get_chat_thread(uuid) to authenticated;
notify pgrst, 'reload schema';

-- 30. Traffic source on views (v30) ------------------------------------

alter table flipbook_views add column if not exists src text;

-- Replace the 5-argument record_view with a 6-argument one (src is optional).
drop function if exists record_view(uuid, text, int, int, text);

create or replace function record_view(
  p_flipbook uuid, p_session text, p_page int, p_dwell int, p_ua text, p_src text default null
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
  insert into flipbook_views (flipbook_id, session_id, page_no, dwell_ms, user_agent, src)
  values (p_flipbook, p_session, p_page,
          greatest(0, least(coalesce(p_dwell, 0), 3600000)), left(p_ua, 255),
          case when p_src ~ '^[a-z]{1,16}$' then p_src else null end);
  -- a view is counted once per visit, when its first page row arrives
  if v_is_new then
    update flipbooks set views = views + 1 where id = p_flipbook;
  end if;
end $$;

revoke all on function record_view(uuid, text, int, int, text, text) from public;
grant execute on function record_view(uuid, text, int, int, text, text) to anon, authenticated;

notify pgrst, 'reload schema';

-- 31. Lead collection (v31) ----------------------------------------------

-- Owner switch: ask visitors for name and contact before/while they read.
alter table flipbooks add column if not exists lead_form boolean not null default false;

-- Collected leads. Only the catalog owner can read or delete them (RLS below).
create table if not exists flipbook_leads (
  id uuid primary key default gen_random_uuid(),
  flipbook_id uuid not null references flipbooks(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  contact text not null check (char_length(contact) between 5 and 120),
  marketing_consent boolean not null default false,
  session_id text,
  created_at timestamptz not null default now()
);
create index if not exists flipbook_leads_fb_idx on flipbook_leads (flipbook_id, created_at);

alter table flipbook_leads enable row level security;

drop policy if exists flipbook_leads_owner_select on flipbook_leads;
create policy flipbook_leads_owner_select on flipbook_leads for select to authenticated
  using (owner_id = auth.uid());

drop policy if exists flipbook_leads_owner_delete on flipbook_leads;
create policy flipbook_leads_owner_delete on flipbook_leads for delete to authenticated
  using (owner_id = auth.uid());

-- Visitors submit through this function only (no direct insert).
create or replace function submit_lead(
  p_flipbook uuid, p_name text, p_contact text, p_marketing boolean, p_session text
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_owner uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_contact text := btrim(coalesce(p_contact, ''));
begin
  select f.user_id into v_owner from flipbooks f
    where f.id = p_flipbook and f.is_public and f.lead_form
      and (f.expires_at is null or f.expires_at > now());
  if v_owner is null then raise exception '지금은 연락처를 받지 않는 자료예요'; end if;
  if char_length(v_name) not between 1 and 40 or char_length(v_contact) not between 5 and 120 then
    raise exception '이름과 연락처를 확인해 주세요';
  end if;
  if p_session is null or char_length(p_session) not between 8 and 64 then
    raise exception '잠시 후 다시 시도해 주세요';
  end if;
  -- one lead per visit: a second submit from the same visit does nothing
  if exists (select 1 from flipbook_leads where flipbook_id = p_flipbook and session_id = p_session) then
    return;
  end if;
  -- coarse daily ceiling per catalog (stops spam)
  if (select count(*) from flipbook_leads
       where flipbook_id = p_flipbook and created_at > now() - interval '1 day') >= 1000 then
    raise exception '오늘은 더 받을 수 없어요';
  end if;
  insert into flipbook_leads (flipbook_id, owner_id, name, contact, marketing_consent, session_id)
  values (p_flipbook, v_owner, v_name, v_contact, coalesce(p_marketing, false), p_session);
end $$;

revoke all on function submit_lead(uuid, text, text, boolean, text) from public;
grant execute on function submit_lead(uuid, text, text, boolean, text) to anon, authenticated;

-- Leads are kept for 1 year, then removed (run daily by /api/cron/retention).
create or replace function purge_old_leads()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_deleted int;
begin
  delete from flipbook_leads where created_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

revoke all on function purge_old_leads() from public, anon, authenticated;

-- get_flipbook now also tells the viewer whether to ask for a contact.
drop function if exists get_flipbook(text);
create function get_flipbook(p_slug text)
returns table (
  id uuid, title text, slug text, pdf_url text, thumb_url text,
  page_count int, views int, created_at timestamptz, has_password boolean, lead_form boolean
)
language sql stable security definer set search_path = public
as $$
  select f.id, f.title, f.slug, f.pdf_url, f.thumb_url, f.page_count, f.views, f.created_at,
         f.password_hash is not null, f.lead_form
  from flipbooks f
  where f.slug = p_slug and f.is_public
    and (f.expires_at is null or f.expires_at > now())
  limit 1;
$$;
grant execute on function get_flipbook(text) to anon, authenticated;

notify pgrst, 'reload schema';

-- 32. Team plan (v32) ----------------------------------------------------

-- Placeholder numbers, change here and in the trigger together:
--   pool of catalogs per team = 200, members per team = 30.

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists team_members (
  team_id uuid not null references teams(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create table if not exists team_invites (
  token text primary key,
  team_id uuid not null references teams(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table flipbooks add column if not exists team_id uuid references teams(id) on delete set null;
create index if not exists flipbooks_team_idx on flipbooks (team_id);

alter table teams enable row level security;
alter table team_members enable row level security;
alter table team_invites enable row level security;

-- Team ids of the caller. Security definer so policies do not recurse into team_members.
create or replace function my_team_ids()
returns setof uuid
language sql stable security definer set search_path = public
as $$
  select team_id from team_members where user_id = auth.uid();
$$;
revoke all on function my_team_ids() from public, anon;
grant execute on function my_team_ids() to authenticated;

drop policy if exists teams_member_select on teams;
create policy teams_member_select on teams for select to authenticated
  using (id in (select my_team_ids()));

drop policy if exists team_members_member_select on team_members;
create policy team_members_member_select on team_members for select to authenticated
  using (team_id in (select my_team_ids()));
-- team_invites: no direct access; members use the functions below.

-- Team members can read the team's catalogs (read only; edits stay with the owner).
drop policy if exists flipbooks_owner_select on flipbooks;
create policy flipbooks_owner_select on flipbooks for select to authenticated
  using (user_id = auth.uid() or team_id in (select my_team_ids()));

-- Catalog limit: a team member's new catalogs count against the team pool instead.
create or replace function enforce_flipbook_limit()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_plan text;
  v_bonus int;
  v_limit int;
  v_count int;
  v_team uuid;
begin
  select m.team_id into v_team from team_members m where m.user_id = new.user_id;
  if v_team is not null then
    select count(*) into v_count from flipbooks where team_id = v_team;
    if v_count >= 200 then
      raise exception 'PLAN_LIMIT: 팀 자료는 팀 전체 %개까지 만들 수 있어요', 200
        using errcode = 'P0001';
    end if;
    new.team_id := v_team;
    return new;
  end if;

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

create or replace function create_team(p_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if auth.uid() is null then raise exception '로그인이 필요해요'; end if;
  if exists (select 1 from team_members where user_id = auth.uid()) then
    raise exception '이미 팀에 참여하고 있어요';
  end if;
  if char_length(v_name) not between 1 and 40 then raise exception '팀 이름을 입력해 주세요'; end if;
  insert into teams (name, created_by) values (v_name, auth.uid()) returning id into v_id;
  insert into team_members (team_id, user_id) values (v_id, auth.uid());
  return v_id;
end;
$$;

-- Any member can create an invite link. It is valid for 7 days.
create or replace function create_team_invite()
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_team uuid;
  v_token text;
begin
  select m.team_id into v_team from team_members m where m.user_id = auth.uid();
  if v_team is null then raise exception '팀에 먼저 참여해 주세요'; end if;
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into team_invites (token, team_id, created_by, expires_at)
  values (v_token, v_team, auth.uid(), now() + interval '7 days');
  return v_token;
end;
$$;

create or replace function join_team(p_token text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_team uuid;
  v_expires timestamptz;
  v_members int;
begin
  if auth.uid() is null then raise exception '로그인이 필요해요'; end if;
  select i.team_id, i.expires_at into v_team, v_expires from team_invites i where i.token = p_token;
  if v_team is null or v_expires < now() then
    raise exception '초대 링크가 만료되었거나 올바르지 않아요';
  end if;
  if exists (select 1 from team_members where user_id = auth.uid() and team_id <> v_team) then
    raise exception '이미 다른 팀에 참여하고 있어요. 먼저 팀에서 나와 주세요';
  end if;
  if exists (select 1 from team_members where user_id = auth.uid() and team_id = v_team) then
    return v_team;
  end if;
  select count(*) into v_members from team_members where team_id = v_team;
  if v_members >= 30 then raise exception '팀 인원(30명)이 가득 찼어요'; end if;
  insert into team_members (team_id, user_id) values (v_team, auth.uid());
  return v_team;
end;
$$;

-- Leaving: your own catalogs stay yours but leave the team pool. The team is removed when empty.
create or replace function leave_team()
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_team uuid;
begin
  select m.team_id into v_team from team_members m where m.user_id = auth.uid();
  if v_team is null then return; end if;
  delete from team_members where user_id = auth.uid();
  update flipbooks set team_id = null where user_id = auth.uid() and team_id = v_team;
  if not exists (select 1 from team_members where team_id = v_team) then
    delete from teams where id = v_team;
  end if;
end;
$$;

-- Team info for the signed-in member (no row when not in a team).
create or replace function get_my_team()
returns table (id uuid, name text, member_count int, catalog_count int)
language sql stable security definer set search_path = public
as $$
  select t.id, t.name,
         (select count(*)::int from team_members x where x.team_id = t.id),
         (select count(*)::int from flipbooks f where f.team_id = t.id)
  from teams t
  join team_members me on me.team_id = t.id and me.user_id = auth.uid();
$$;

create or replace function list_team_members()
returns table (user_id uuid, display_name text, company_name text, is_me boolean)
language sql stable security definer set search_path = public
as $$
  select m.user_id, c.name, c.company_name, m.user_id = auth.uid()
  from team_members m
  left join customers c on c.user_id = m.user_id
  where m.team_id in (select my_team_ids())
  order by m.joined_at;
$$;

revoke all on function create_team(text), create_team_invite(), join_team(text), leave_team(),
  get_my_team(), list_team_members() from public, anon;
grant execute on function create_team(text), create_team_invite(), join_team(text), leave_team(),
  get_my_team(), list_team_members() to authenticated;

notify pgrst, 'reload schema';

-- 33. Team members manage team catalogs (v33) ----------------------------

-- Owner of the catalog or a member of its team.
create or replace function can_manage_flipbook(p_flipbook uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from flipbooks f
    where f.id = p_flipbook
      and (f.user_id = auth.uid() or f.team_id in (select my_team_ids()))
  );
$$;

-- Storage files live under a folder named by the catalog slug or id (see lib/flipbook/upload.ts).
create or replace function can_manage_storage_path(p_name text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from flipbooks f
    where (f.slug = split_part(p_name, '/', 1) or f.id::text = split_part(p_name, '/', 1))
      and (f.user_id = auth.uid() or f.team_id in (select my_team_ids()))
  );
$$;

revoke all on function can_manage_flipbook(uuid), can_manage_storage_path(text) from public, anon;
grant execute on function can_manage_flipbook(uuid), can_manage_storage_path(text) to authenticated;

-- flipbooks: update and delete by owner or team
drop policy if exists flipbooks_owner_update on flipbooks;
create policy flipbooks_owner_update on flipbooks for update to authenticated
  using (can_manage_flipbook(id)) with check (can_manage_flipbook(id));
drop policy if exists flipbooks_owner_delete on flipbooks;
create policy flipbooks_owner_delete on flipbooks for delete to authenticated
  using (can_manage_flipbook(id));

-- flipbook_pages: write by owner or team
drop policy if exists pages_owner_write on flipbook_pages;
create policy pages_owner_write on flipbook_pages for all to authenticated
  using (can_manage_flipbook(flipbook_id)) with check (can_manage_flipbook(flipbook_id));

-- view logs and leads: read by owner or team
drop policy if exists views_owner_select on flipbook_views;
create policy views_owner_select on flipbook_views for select to authenticated
  using (can_manage_flipbook(flipbook_id));

drop policy if exists flipbook_leads_owner_select on flipbook_leads;
create policy flipbook_leads_owner_select on flipbook_leads for select to authenticated
  using (can_manage_flipbook(flipbook_id));
drop policy if exists flipbook_leads_owner_delete on flipbook_leads;
create policy flipbook_leads_owner_delete on flipbook_leads for delete to authenticated
  using (can_manage_flipbook(flipbook_id));

-- storage: list, replace and delete files of the team's catalogs (both buckets)
drop policy if exists flipbook_private_select_team on storage.objects;
create policy flipbook_private_select_team on storage.objects for select to authenticated
  using (bucket_id = 'flipbook-private' and can_manage_storage_path(name));
drop policy if exists flipbook_private_update_team on storage.objects;
create policy flipbook_private_update_team on storage.objects for update to authenticated
  using (bucket_id = 'flipbook-private' and can_manage_storage_path(name));
drop policy if exists flipbook_private_delete_team on storage.objects;
create policy flipbook_private_delete_team on storage.objects for delete to authenticated
  using (bucket_id = 'flipbook-private' and can_manage_storage_path(name));

drop policy if exists flipbook_files_update_team on storage.objects;
create policy flipbook_files_update_team on storage.objects for update to authenticated
  using (bucket_id = 'flipbook-files' and can_manage_storage_path(name));
drop policy if exists flipbook_files_delete_team on storage.objects;
create policy flipbook_files_delete_team on storage.objects for delete to authenticated
  using (bucket_id = 'flipbook-files' and can_manage_storage_path(name));

notify pgrst, 'reload schema';

-- 34. Quote requests and CRM webhooks (v34) ---------------------------------

-- ── Quote requests ─────────────────────────────────────────────
alter table flipbooks add column if not exists quote_form boolean not null default false;

create table if not exists quote_requests (
  id uuid primary key default gen_random_uuid(),
  flipbook_id uuid not null references flipbooks(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  contact text not null check (char_length(contact) between 5 and 120),
  company text check (company is null or char_length(company) <= 60),
  memo text not null check (char_length(memo) between 1 and 1000),
  status text not null default 'new' check (status in ('new', 'done')),
  session_id text,
  created_at timestamptz not null default now()
);
create index if not exists quote_requests_fb_idx on quote_requests (flipbook_id, created_at);

alter table quote_requests enable row level security;

drop policy if exists quote_requests_manage_select on quote_requests;
create policy quote_requests_manage_select on quote_requests for select to authenticated
  using (can_manage_flipbook(flipbook_id));
drop policy if exists quote_requests_manage_update on quote_requests;
create policy quote_requests_manage_update on quote_requests for update to authenticated
  using (can_manage_flipbook(flipbook_id)) with check (can_manage_flipbook(flipbook_id));
drop policy if exists quote_requests_manage_delete on quote_requests;
create policy quote_requests_manage_delete on quote_requests for delete to authenticated
  using (can_manage_flipbook(flipbook_id));

create or replace function submit_quote_request(
  p_flipbook uuid, p_name text, p_contact text, p_company text, p_memo text, p_session text
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_owner uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_contact text := btrim(coalesce(p_contact, ''));
  v_company text := nullif(btrim(coalesce(p_company, '')), '');
  v_memo text := btrim(coalesce(p_memo, ''));
begin
  select f.user_id into v_owner from flipbooks f
    where f.id = p_flipbook and f.is_public and f.quote_form
      and (f.expires_at is null or f.expires_at > now());
  if v_owner is null then raise exception '지금은 견적 요청을 받지 않는 자료예요'; end if;
  if char_length(v_name) not between 1 and 40 or char_length(v_contact) not between 5 and 120 then
    raise exception '이름과 연락처를 확인해 주세요';
  end if;
  if char_length(v_memo) not between 1 and 1000 then raise exception '요청 내용을 입력해 주세요'; end if;
  if v_company is not null and char_length(v_company) > 60 then raise exception '회사명이 너무 길어요'; end if;
  if p_session is null or char_length(p_session) not between 8 and 64 then
    raise exception '잠시 후 다시 시도해 주세요';
  end if;
  if exists (select 1 from quote_requests where flipbook_id = p_flipbook and session_id = p_session) then
    return;
  end if;
  if (select count(*) from quote_requests
       where flipbook_id = p_flipbook and created_at > now() - interval '1 day') >= 200 then
    raise exception '오늘은 더 받을 수 없어요';
  end if;
  insert into quote_requests (flipbook_id, owner_id, name, contact, company, memo, session_id)
  values (p_flipbook, v_owner, v_name, v_contact, v_company, v_memo, p_session);
end $$;

revoke all on function submit_quote_request(uuid, text, text, text, text, text) from public;
grant execute on function submit_quote_request(uuid, text, text, text, text, text) to anon, authenticated;

-- Retention: leads and quote requests are both kept 1 year.
create or replace function purge_old_leads()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_deleted int;
begin
  delete from flipbook_leads where created_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;
  delete from quote_requests where created_at < now() - interval '365 days';
  return v_deleted;
end $$;

-- get_flipbook also reports quote_form now.
drop function if exists get_flipbook(text);
create function get_flipbook(p_slug text)
returns table (
  id uuid, title text, slug text, pdf_url text, thumb_url text,
  page_count int, views int, created_at timestamptz, has_password boolean,
  lead_form boolean, quote_form boolean
)
language sql stable security definer set search_path = public
as $$
  select f.id, f.title, f.slug, f.pdf_url, f.thumb_url, f.page_count, f.views, f.created_at,
         f.password_hash is not null, f.lead_form, f.quote_form
  from flipbooks f
  where f.slug = p_slug and f.is_public
    and (f.expires_at is null or f.expires_at > now())
  limit 1;
$$;
grant execute on function get_flipbook(text) to anon, authenticated;

-- ── Webhooks (CRM, 1단계) ───────────────────────────────────────
create table if not exists webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null check (char_length(url) <= 500 and url like 'https://%'),
  secret text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references webhook_endpoints(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  event text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_code int,
  last_error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index if not exists webhook_deliveries_due_idx on webhook_deliveries (status, next_attempt_at);
create index if not exists webhook_deliveries_user_idx on webhook_deliveries (user_id, created_at);

alter table webhook_endpoints enable row level security;
alter table webhook_deliveries enable row level security;

drop policy if exists webhook_endpoints_owner on webhook_endpoints;
create policy webhook_endpoints_owner on webhook_endpoints for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Only the owner reads delivery logs. Owners may add a test ping (event 'ping') themselves.
drop policy if exists webhook_deliveries_owner_select on webhook_deliveries;
create policy webhook_deliveries_owner_select on webhook_deliveries for select to authenticated
  using (user_id = auth.uid());
drop policy if exists webhook_deliveries_owner_ping on webhook_deliveries;
create policy webhook_deliveries_owner_ping on webhook_deliveries for insert to authenticated
  with check (
    user_id = auth.uid() and event = 'ping'
    and exists (select 1 from webhook_endpoints e where e.id = endpoint_id and e.user_id = auth.uid())
  );

-- Up to 5 endpoints per owner.
create or replace function enforce_webhook_endpoint_limit()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if (select count(*) from webhook_endpoints where user_id = new.user_id) >= 5 then
    raise exception '연동 주소는 5개까지 등록할 수 있어요';
  end if;
  return new;
end $$;
drop trigger if exists webhook_endpoint_limit on webhook_endpoints;
create trigger webhook_endpoint_limit before insert on webhook_endpoints
  for each row execute function enforce_webhook_endpoint_limit();

-- New lead or quote request → one pending delivery per enabled endpoint.
create or replace function queue_lead_webhooks()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into webhook_deliveries (endpoint_id, user_id, event, payload)
  select e.id, e.user_id, 'lead.created',
         jsonb_build_object(
           'event', 'lead.created',
           'created_at', new.created_at,
           'flipbook', jsonb_build_object('id', f.id, 'title', f.title),
           'lead', jsonb_build_object('name', new.name, 'contact', new.contact,
                                      'marketing_consent', new.marketing_consent))
  from webhook_endpoints e
  join flipbooks f on f.id = new.flipbook_id
  where e.user_id = new.owner_id and e.enabled;
  return new;
end $$;

create or replace function queue_quote_webhooks()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into webhook_deliveries (endpoint_id, user_id, event, payload)
  select e.id, e.user_id, 'quote.requested',
         jsonb_build_object(
           'event', 'quote.requested',
           'created_at', new.created_at,
           'flipbook', jsonb_build_object('id', f.id, 'title', f.title),
           'quote', jsonb_build_object('name', new.name, 'contact', new.contact,
                                       'company', new.company, 'memo', new.memo))
  from webhook_endpoints e
  join flipbooks f on f.id = new.flipbook_id
  where e.user_id = new.owner_id and e.enabled;
  return new;
end $$;

drop trigger if exists flipbook_leads_webhook on flipbook_leads;
create trigger flipbook_leads_webhook after insert on flipbook_leads
  for each row execute function queue_lead_webhooks();
drop trigger if exists quote_requests_webhook on quote_requests;
create trigger quote_requests_webhook after insert on quote_requests
  for each row execute function queue_quote_webhooks();

notify pgrst, 'reload schema';

-- 35. AI translation of catalog pages (v35) ------------------------------

create table if not exists flipbook_translations (
  flipbook_id uuid not null references flipbooks(id) on delete cascade,
  lang text not null check (lang in ('en', 'zh', 'ja', 'vi')),
  page_no int not null check (page_no >= 1),
  page_text text not null check (char_length(page_text) <= 8000),
  created_at timestamptz not null default now(),
  primary key (flipbook_id, lang, page_no)
);

-- One row per translated page, used to count the free allowance per account.
create table if not exists translation_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  flipbook_id uuid references flipbooks(id) on delete set null,
  lang text not null,
  page_no int not null,
  created_at timestamptz not null default now()
);
create index if not exists translation_usage_user_idx on translation_usage (user_id);

alter table flipbook_translations enable row level security;
alter table translation_usage enable row level security;

-- Owners and their teams can read and delete a catalog's translations.
-- Writes happen only on the server (service role), so there are no insert policies.
drop policy if exists translations_manage_select on flipbook_translations;
create policy translations_manage_select on flipbook_translations for select to authenticated
  using (can_manage_flipbook(flipbook_id));
drop policy if exists translations_manage_delete on flipbook_translations;
create policy translations_manage_delete on flipbook_translations for delete to authenticated
  using (can_manage_flipbook(flipbook_id));

drop policy if exists translation_usage_owner_select on translation_usage;
create policy translation_usage_owner_select on translation_usage for select to authenticated
  using (user_id = auth.uid());

-- Viewers: languages that exist for a public catalog, and its translated pages.
create or replace function get_translation_langs(p_slug text)
returns text[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(distinct t.lang order by t.lang), '{}')
  from flipbook_translations t
  join flipbooks f on f.id = t.flipbook_id
  where f.slug = p_slug and f.is_public and (f.expires_at is null or f.expires_at > now());
$$;

create or replace function get_translations(p_slug text, p_lang text)
returns table (page_no int, page_text text)
language sql stable security definer set search_path = public
as $$
  select t.page_no, t.page_text
  from flipbook_translations t
  join flipbooks f on f.id = t.flipbook_id
  where f.slug = p_slug and f.is_public and (f.expires_at is null or f.expires_at > now())
    and t.lang = p_lang
  order by t.page_no;
$$;

grant execute on function get_translation_langs(text), get_translations(text, text) to anon, authenticated;

notify pgrst, 'reload schema';

-- 36. Email notices to marketing-consented leads (v36) ----------------------

-- Each lead gets a private token for the one-click 수신거부 link in every notice.
alter table flipbook_leads add column if not exists unsubscribe_token uuid not null default gen_random_uuid();
create unique index if not exists flipbook_leads_unsub_idx on flipbook_leads (unsubscribe_token);

-- Log of notices sent (owner can read, server writes).
create table if not exists notify_sends (
  id uuid primary key default gen_random_uuid(),
  flipbook_id uuid references flipbooks(id) on delete set null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  channel text not null default 'email' check (channel in ('email')),
  subject text not null,
  recipient_count int not null,
  status text not null check (status in ('sent', 'partial', 'failed')),
  created_at timestamptz not null default now()
);
create index if not exists notify_sends_owner_idx on notify_sends (owner_id, created_at);

alter table notify_sends enable row level security;
drop policy if exists notify_sends_owner_select on notify_sends;
create policy notify_sends_owner_select on notify_sends for select to authenticated
  using (owner_id = auth.uid());

-- How many leads of this catalog can get an email: marketing consent + an email address.
-- Returns 0 unless the caller can manage the catalog.
create or replace function count_notify_recipients(p_flipbook uuid)
returns int
language sql stable security definer set search_path = public
as $$
  select case when can_manage_flipbook(p_flipbook) then (
    select count(*)::int from flipbook_leads l
    where l.flipbook_id = p_flipbook and l.marketing_consent and l.contact like '%@%'
  ) else 0 end;
$$;
revoke all on function count_notify_recipients(uuid) from public, anon;
grant execute on function count_notify_recipients(uuid) to authenticated;

notify pgrst, 'reload schema';

-- 37. Sales priority from viewing data (v37) ---------------------------------

-- Each lead gets a score from the visit that produced it (same session):
--   time spent (up to 20), pages reached (up to 10), finished the catalog (+30),
--   requested a quote in the same visit (+40). Owners and team members only.
create or replace function get_lead_priorities(p_flipbook uuid)
returns table (
  lead_id uuid,
  name text,
  contact text,
  marketing_consent boolean,
  lead_created_at timestamptz,
  max_page int,
  page_count int,
  dwell_ms bigint,
  finished boolean,
  quote_requested boolean,
  score int
)
language sql stable security definer set search_path = public
as $$
  with pc as (
    select f.page_count from flipbooks f where f.id = p_flipbook
  ),
  v as (
    select fv.session_id, max(fv.page_no) as maxp, coalesce(sum(fv.dwell_ms), 0) as dwell
    from flipbook_views fv
    where fv.flipbook_id = p_flipbook and fv.session_id is not null
    group by fv.session_id
  ),
  base as (
    select l.id, l.name, l.contact, l.marketing_consent, l.created_at, l.session_id,
           coalesce(v.maxp, 0) as maxp,
           coalesce(v.dwell, 0) as dwell,
           (q.id is not null) as asked
    from flipbook_leads l
    left join v on v.session_id = l.session_id
    left join lateral (
      select qr.id from quote_requests qr
      where qr.flipbook_id = p_flipbook and qr.session_id = l.session_id
      limit 1
    ) q on true
    where l.flipbook_id = p_flipbook
      and can_manage_flipbook(p_flipbook)
  )
  select b.id, b.name, b.contact, b.marketing_consent, b.created_at,
         b.maxp, coalesce(pc.page_count, 0), b.dwell,
         (coalesce(pc.page_count, 0) > 0 and b.maxp >= pc.page_count) as finished,
         b.asked,
         (least(b.dwell / 60000.0, 10) * 2
          + least(b.maxp, 10)
          + case when coalesce(pc.page_count, 0) > 0 and b.maxp >= pc.page_count then 30 else 0 end
          + case when b.asked then 40 else 0 end)::int as score
  from base b
  cross join pc
  order by score desc, b.created_at desc;
$$;

revoke all on function get_lead_priorities(uuid) from public, anon;
grant execute on function get_lead_priorities(uuid) to authenticated;

notify pgrst, 'reload schema';

-- 38. Buyer directory and deal ledger (v38) ----------------------------------

-- ── Directory: owners choose to list a public catalog ─────────────
alter table flipbooks add column if not exists listed boolean not null default false;
alter table flipbooks add column if not exists category text;
alter table flipbooks add column if not exists summary text;

alter table flipbooks drop constraint if exists flipbooks_category_check;
alter table flipbooks add constraint flipbooks_category_check
  check (category is null or category in ('산업용품', '식품', '패션', '전자', '생활', '기타'));
alter table flipbooks drop constraint if exists flipbooks_summary_check;
alter table flipbooks add constraint flipbooks_summary_check
  check (summary is null or char_length(summary) <= 200);

-- Listed, public, not expired catalogs. Anyone may read this list (no private fields).
create or replace function list_directory(p_category text default null, p_query text default null)
returns table (
  id uuid, title text, slug text, thumb_url text, summary text, category text,
  page_count int, quote_form boolean, created_at timestamptz
)
language sql stable security definer set search_path = public
as $$
  select f.id, f.title, f.slug, f.thumb_url, f.summary, f.category,
         f.page_count, f.quote_form, f.created_at
  from flipbooks f
  where f.listed and f.is_public and (f.expires_at is null or f.expires_at > now())
    and (p_category is null or p_category = '' or f.category = p_category)
    and (p_query is null or p_query = ''
         or f.title ilike '%' || p_query || '%'
         or coalesce(f.summary, '') ilike '%' || p_query || '%')
  order by f.created_at desc
  limit 60;
$$;
grant execute on function list_directory(text, text) to anon, authenticated;

-- ── Deal ledger: a quote that was won, with the amount and the fee at the current rate ──
create table if not exists deals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  quote_id uuid references quote_requests(id) on delete set null,
  flipbook_id uuid references flipbooks(id) on delete set null,
  buyer_name text not null check (char_length(buyer_name) between 1 and 40),
  buyer_company text check (buyer_company is null or char_length(buyer_company) <= 60),
  amount bigint not null check (amount >= 0),
  fee_rate numeric(5, 4) not null check (fee_rate >= 0 and fee_rate <= 1),
  fee_amount bigint not null check (fee_amount >= 0),
  memo text check (memo is null or char_length(memo) <= 500),
  closed_on date not null default current_date,
  created_at timestamptz not null default now()
);
create index if not exists deals_user_idx on deals (user_id, closed_on);

alter table deals enable row level security;
drop policy if exists deals_owner_all on deals;
create policy deals_owner_all on deals for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

notify pgrst, 'reload schema';

-- 39. Webhook log retention and standard contracts (v39) ----------------------

-- Webhook deliveries carry lead contacts, so their log is kept 30 days only.
create or replace function purge_old_webhook_deliveries()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_deleted int;
begin
  delete from webhook_deliveries where created_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;
revoke all on function purge_old_webhook_deliveries() from public, anon, authenticated;

-- Contract records: a standard terms document made from an accepted quote.
-- The buyer opens it by a private link and confirms ("동의"). This is a click-agreement record,
-- not a certified electronic signature.
create table if not exists contracts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  quote_id uuid references quote_requests(id) on delete set null,
  token text not null unique default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  title text not null check (char_length(title) between 1 and 100),
  buyer_name text not null check (char_length(buyer_name) between 1 and 40),
  buyer_company text check (buyer_company is null or char_length(buyer_company) <= 60),
  body text not null check (char_length(body) <= 8000),
  amount bigint not null check (amount >= 0),
  status text not null default 'sent' check (status in ('sent', 'agreed')),
  agreed_at timestamptz,
  expires_at timestamptz not null default now() + interval '30 days',
  created_at timestamptz not null default now()
);
create index if not exists contracts_user_idx on contracts (user_id, created_at);

alter table contracts enable row level security;
drop policy if exists contracts_owner_all on contracts;
create policy contracts_owner_all on contracts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- The buyer reads one contract by its private token only.
create or replace function get_contract(p_token text)
returns table (
  title text, buyer_name text, buyer_company text, body text, amount bigint,
  status text, agreed_at timestamptz, expires_at timestamptz, seller_company text
)
language sql stable security definer set search_path = public
as $$
  select c.title, c.buyer_name, c.buyer_company, c.body, c.amount,
         c.status, c.agreed_at, c.expires_at, cu.company_name
  from contracts c
  left join customers cu on cu.user_id = c.user_id
  where c.token = p_token
  limit 1;
$$;

-- Records the buyer's confirmation once, while the link is still valid.
create or replace function agree_contract(p_token text)
returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare
  v_at timestamptz;
begin
  update contracts set status = 'agreed', agreed_at = now()
    where token = p_token and status = 'sent' and expires_at > now()
    returning agreed_at into v_at;
  if v_at is null then
    raise exception '이미 처리됐거나 만료된 계약이에요';
  end if;
  return v_at;
end $$;

grant execute on function get_contract(text), agree_contract(text) to anon, authenticated;

notify pgrst, 'reload schema';

-- 40. Products, order requests, reorder reminders (v40) ------------------------

alter table flipbooks add column if not exists order_form boolean not null default false;
alter table flipbooks add column if not exists reorder_days int;
alter table flipbooks drop constraint if exists flipbooks_reorder_days_check;
alter table flipbooks add constraint flipbooks_reorder_days_check
  check (reorder_days is null or reorder_days in (30, 60, 90, 180));

-- Products of a catalog (entered by hand or read from the pages by AI).
create table if not exists catalog_products (
  id uuid primary key default gen_random_uuid(),
  flipbook_id uuid not null references flipbooks(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  price bigint check (price is null or price >= 0),
  unit text check (unit is null or char_length(unit) <= 20),
  options text check (options is null or char_length(options) <= 300),
  description text check (description is null or char_length(description) <= 500),
  page_no int check (page_no is null or page_no >= 1),
  created_at timestamptz not null default now()
);
create index if not exists catalog_products_fb_idx on catalog_products (flipbook_id);
alter table catalog_products enable row level security;
drop policy if exists catalog_products_manage on catalog_products;
create policy catalog_products_manage on catalog_products for all to authenticated
  using (can_manage_flipbook(flipbook_id)) with check (can_manage_flipbook(flipbook_id));

-- Viewers read products of a public catalog through this function.
create or replace function get_products(p_slug text)
returns table (id uuid, name text, price bigint, unit text, options text, description text, page_no int)
language sql stable security definer set search_path = public
as $$
  select p.id, p.name, p.price, p.unit, p.options, p.description, p.page_no
  from catalog_products p
  join flipbooks f on f.id = p.flipbook_id
  where f.slug = p_slug and f.is_public and (f.expires_at is null or f.expires_at > now())
  order by p.page_no nulls last, p.created_at;
$$;

-- Order requests: the buyer's selection with a price snapshot. Nothing is charged here.
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  flipbook_id uuid not null references flipbooks(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  buyer_name text not null check (char_length(buyer_name) between 1 and 40),
  buyer_contact text not null check (char_length(buyer_contact) between 5 and 120),
  buyer_company text check (buyer_company is null or char_length(buyer_company) <= 60),
  memo text check (memo is null or char_length(memo) <= 500),
  items jsonb not null,
  total bigint check (total is null or total >= 0),
  status text not null default 'new' check (status in ('new', 'done')),
  marketing_consent boolean not null default false,
  session_id text,
  created_at timestamptz not null default now()
);
create index if not exists orders_fb_idx on orders (flipbook_id, created_at);
create index if not exists orders_contact_idx on orders (flipbook_id, buyer_contact);
alter table orders enable row level security;
drop policy if exists orders_manage_select on orders;
create policy orders_manage_select on orders for select to authenticated using (can_manage_flipbook(flipbook_id));
drop policy if exists orders_manage_update on orders;
create policy orders_manage_update on orders for update to authenticated
  using (can_manage_flipbook(flipbook_id)) with check (can_manage_flipbook(flipbook_id));
drop policy if exists orders_manage_delete on orders;
create policy orders_manage_delete on orders for delete to authenticated using (can_manage_flipbook(flipbook_id));

-- p_items: [{"product_id": "...", "qty": 2}, ...]. Names and prices are read from the catalog here.
create or replace function submit_order(
  p_flipbook uuid, p_name text, p_contact text, p_company text, p_memo text,
  p_items jsonb, p_marketing boolean, p_session text
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_owner uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_contact text := btrim(coalesce(p_contact, ''));
  v_company text := nullif(btrim(coalesce(p_company, '')), '');
  v_memo text := nullif(btrim(coalesce(p_memo, '')), '');
  v_snapshot jsonb;
  v_total bigint;
  v_priced_all boolean;
  v_count int;
begin
  select f.user_id into v_owner from flipbooks f
    where f.id = p_flipbook and f.is_public and f.order_form
      and (f.expires_at is null or f.expires_at > now());
  if v_owner is null then raise exception '지금은 주문을 받지 않는 자료예요'; end if;
  if char_length(v_name) not between 1 and 40 or char_length(v_contact) not between 5 and 120 then
    raise exception '이름과 연락처를 확인해 주세요';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception '상품을 골라 주세요';
  end if;
  if p_session is null or char_length(p_session) not between 8 and 64 then
    raise exception '잠시 후 다시 시도해 주세요';
  end if;
  if exists (select 1 from orders where flipbook_id = p_flipbook and session_id = p_session) then
    return;
  end if;
  if (select count(*) from orders where flipbook_id = p_flipbook and created_at > now() - interval '1 day') >= 200 then
    raise exception '오늘은 더 받을 수 없어요';
  end if;

  -- Snapshot the chosen products at their current names and prices.
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', p.id, 'name', p.name, 'price', p.price, 'unit', p.unit,
           'options', p.options, 'qty', least(greatest((i->>'qty')::int, 1), 999)
         )), '[]'::jsonb),
         coalesce(sum(p.price * least(greatest((i->>'qty')::int, 1), 999)), 0),
         bool_and(p.price is not null)
    into v_snapshot, v_total, v_priced_all
  from jsonb_array_elements(p_items) as i
  join catalog_products p on p.id = (i->>'product_id')::uuid and p.flipbook_id = p_flipbook;

  select jsonb_array_length(coalesce(v_snapshot, '[]'::jsonb)) into v_count;
  if v_count = 0 then raise exception '고른 상품을 찾을 수 없어요'; end if;

  insert into orders (flipbook_id, owner_id, buyer_name, buyer_contact, buyer_company, memo,
                      items, total, marketing_consent, session_id)
  values (p_flipbook, v_owner, v_name, v_contact, v_company, v_memo, v_snapshot,
          case when coalesce(v_priced_all, false) then v_total else null end,
          coalesce(p_marketing, false), p_session);

  -- Marketing consent is also kept as a lead, so the owner's notices and reorder reminders can reach them.
  if coalesce(p_marketing, false) then
    if exists (select 1 from flipbook_leads where flipbook_id = p_flipbook and contact = v_contact) then
      update flipbook_leads set marketing_consent = true
        where flipbook_id = p_flipbook and contact = v_contact;
    else
      insert into flipbook_leads (flipbook_id, owner_id, name, contact, marketing_consent, session_id)
      values (p_flipbook, v_owner, v_name, v_contact, true, p_session);
    end if;
  end if;
end $$;

revoke all on function submit_order(uuid, text, text, text, text, jsonb, boolean, text) from public;
grant execute on function submit_order(uuid, text, text, text, text, jsonb, boolean, text) to anon, authenticated;

-- Reorder reminders: one per order, so a buyer gets at most one reminder per order.
create table if not exists reorder_reminders (
  order_id uuid primary key references orders(id) on delete cascade,
  flipbook_id uuid not null references flipbooks(id) on delete cascade,
  sent_at timestamptz not null default now()
);
alter table reorder_reminders enable row level security;

-- Order events for the CRM webhook (same delivery path as leads and quotes).
create or replace function queue_order_webhooks()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into webhook_deliveries (endpoint_id, user_id, event, payload)
  select e.id, e.user_id, 'order.requested',
         jsonb_build_object(
           'event', 'order.requested',
           'created_at', new.created_at,
           'flipbook', jsonb_build_object('id', f.id, 'title', f.title),
           'order', jsonb_build_object('name', new.buyer_name, 'contact', new.buyer_contact,
                                       'company', new.buyer_company, 'memo', new.memo,
                                       'items', new.items, 'total', new.total))
  from webhook_endpoints e
  join flipbooks f on f.id = new.flipbook_id
  where e.user_id = new.owner_id and e.enabled;
  return new;
end $$;
drop trigger if exists orders_webhook on orders;
create trigger orders_webhook after insert on orders
  for each row execute function queue_order_webhooks();

-- Retention: orders follow the same 1-year rule as leads.
create or replace function purge_old_leads()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_deleted int;
begin
  delete from flipbook_leads where created_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;
  delete from quote_requests where created_at < now() - interval '365 days';
  delete from orders where created_at < now() - interval '365 days';
  return v_deleted;
end $$;

-- get_flipbook also reports order_form now.
drop function if exists get_flipbook(text);
create function get_flipbook(p_slug text)
returns table (
  id uuid, title text, slug text, pdf_url text, thumb_url text,
  page_count int, views int, created_at timestamptz, has_password boolean,
  lead_form boolean, quote_form boolean, order_form boolean
)
language sql stable security definer set search_path = public
as $$
  select f.id, f.title, f.slug, f.pdf_url, f.thumb_url, f.page_count, f.views, f.created_at,
         f.password_hash is not null, f.lead_form, f.quote_form, f.order_form
  from flipbooks f
  where f.slug = p_slug and f.is_public
    and (f.expires_at is null or f.expires_at > now())
  limit 1;
$$;
grant execute on function get_flipbook(text) to anon, authenticated;

notify pgrst, 'reload schema';

-- ============================================================
-- 41. Buyer subscriptions (order gate)
--   Viewing stays free. When a publisher turns on order_requires_subscription,
--   only buyers with an active subscription can send order requests, and
--   reorder reminders go only to them. Payment is not connected yet: rows are
--   added by an admin (service role) until Toss Payments is approved.
-- ============================================================
alter table flipbooks add column if not exists order_requires_subscription boolean not null default false;

create table if not exists buyer_subscriptions (
  id uuid primary key default gen_random_uuid(),
  flipbook_id uuid not null references flipbooks(id) on delete cascade,
  contact text not null,
  status text not null default 'active' check (status in ('active', 'canceled')),
  current_period_end timestamptz not null,
  payment_ref text,
  created_at timestamptz not null default now(),
  unique (flipbook_id, contact)
);
alter table buyer_subscriptions enable row level security;
-- No policies: only the service role (server code and admin SQL) reads or writes this table.

create or replace function buyer_has_subscription(p_flipbook uuid, p_contact text) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from buyer_subscriptions s
    where s.flipbook_id = p_flipbook
      and s.contact = lower(btrim(p_contact))
      and s.status = 'active'
      and s.current_period_end > now()
  );
$$;
revoke all on function buyer_has_subscription(uuid, text) from public;

create or replace function submit_order(
  p_flipbook uuid, p_name text, p_contact text, p_company text, p_memo text,
  p_items jsonb, p_marketing boolean, p_session text
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_owner uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_contact text := btrim(coalesce(p_contact, ''));
  v_company text := nullif(btrim(coalesce(p_company, '')), '');
  v_memo text := nullif(btrim(coalesce(p_memo, '')), '');
  v_snapshot jsonb;
  v_total bigint;
  v_priced_all boolean;
  v_count int;
begin
  select f.user_id into v_owner from flipbooks f
    where f.id = p_flipbook and f.is_public and f.order_form
      and (f.expires_at is null or f.expires_at > now());
  if v_owner is null then raise exception '지금은 주문을 받지 않는 자료예요'; end if;
  if char_length(v_name) not between 1 and 40 or char_length(v_contact) not between 5 and 120 then
    raise exception '이름과 연락처를 확인해 주세요';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception '상품을 골라 주세요';
  end if;
  if p_session is null or char_length(p_session) not between 8 and 64 then
    raise exception '잠시 후 다시 시도해 주세요';
  end if;
  if exists (select 1 from flipbooks f where f.id = p_flipbook and f.order_requires_subscription)
     and not buyer_has_subscription(p_flipbook, v_contact) then
    raise exception '이 자료의 주문은 구독자만 보낼 수 있어요';
  end if;

  if exists (select 1 from orders where flipbook_id = p_flipbook and session_id = p_session) then
    return;
  end if;
  if (select count(*) from orders where flipbook_id = p_flipbook and created_at > now() - interval '1 day') >= 200 then
    raise exception '오늘은 더 받을 수 없어요';
  end if;

  -- Snapshot the chosen products at their current names and prices.
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', p.id, 'name', p.name, 'price', p.price, 'unit', p.unit,
           'options', p.options, 'qty', least(greatest((i->>'qty')::int, 1), 999)
         )), '[]'::jsonb),
         coalesce(sum(p.price * least(greatest((i->>'qty')::int, 1), 999)), 0),
         bool_and(p.price is not null)
    into v_snapshot, v_total, v_priced_all
  from jsonb_array_elements(p_items) as i
  join catalog_products p on p.id = (i->>'product_id')::uuid and p.flipbook_id = p_flipbook;

  select jsonb_array_length(coalesce(v_snapshot, '[]'::jsonb)) into v_count;
  if v_count = 0 then raise exception '고른 상품을 찾을 수 없어요'; end if;

  insert into orders (flipbook_id, owner_id, buyer_name, buyer_contact, buyer_company, memo,
                      items, total, marketing_consent, session_id)
  values (p_flipbook, v_owner, v_name, v_contact, v_company, v_memo, v_snapshot,
          case when coalesce(v_priced_all, false) then v_total else null end,
          coalesce(p_marketing, false), p_session);

  -- Marketing consent is also kept as a lead, so the owner's notices and reorder reminders can reach them.
  if coalesce(p_marketing, false) then
    if exists (select 1 from flipbook_leads where flipbook_id = p_flipbook and contact = v_contact) then
      update flipbook_leads set marketing_consent = true
        where flipbook_id = p_flipbook and contact = v_contact;
    else
      insert into flipbook_leads (flipbook_id, owner_id, name, contact, marketing_consent, session_id)
      values (p_flipbook, v_owner, v_name, v_contact, true, p_session);
    end if;
  end if;
end $$;

revoke all on function submit_order(uuid, text, text, text, text, jsonb, boolean, text) from public;
grant execute on function submit_order(uuid, text, text, text, text, jsonb, boolean, text) to anon, authenticated;

-- ============================================================
-- 42. Order details: option, delivery date, owner alert, fee estimate
--   The platform fee is only recorded as an estimate (3%, placeholder rate).
--   It is not charged yet.
-- ============================================================
alter table orders add column if not exists delivery_date date;
alter table orders add column if not exists platform_fee bigint;
alter table orders add column if not exists owner_notified_at timestamptz;

drop function if exists submit_order(uuid, text, text, text, text, jsonb, boolean, text);

create or replace function submit_order(
  p_flipbook uuid, p_name text, p_contact text, p_company text, p_memo text,
  p_items jsonb, p_marketing boolean, p_session text, p_delivery date
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_owner uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_contact text := btrim(coalesce(p_contact, ''));
  v_company text := nullif(btrim(coalesce(p_company, '')), '');
  v_memo text := nullif(btrim(coalesce(p_memo, '')), '');
  v_snapshot jsonb;
  v_total bigint;
  v_priced_all boolean;
  v_count int;
begin
  select f.user_id into v_owner from flipbooks f
    where f.id = p_flipbook and f.is_public and f.order_form
      and (f.expires_at is null or f.expires_at > now());
  if v_owner is null then raise exception '지금은 주문을 받지 않는 자료예요'; end if;
  if char_length(v_name) not between 1 and 40 or char_length(v_contact) not between 5 and 120 then
    raise exception '이름과 연락처를 확인해 주세요';
  end if;
  if exists (select 1 from flipbooks f where f.id = p_flipbook and f.order_requires_subscription)
     and not buyer_has_subscription(p_flipbook, v_contact) then
    raise exception '이 자료의 주문은 구독자만 보낼 수 있어요';
  end if;
  if p_delivery is not null and (p_delivery < current_date or p_delivery > current_date + 365) then
    raise exception '납기일은 오늘부터 1년 안에서 골라 주세요';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception '상품을 골라 주세요';
  end if;
  if p_session is null or char_length(p_session) not between 8 and 64 then
    raise exception '잠시 후 다시 시도해 주세요';
  end if;
  if exists (select 1 from orders where flipbook_id = p_flipbook and session_id = p_session) then
    return;
  end if;
  if (select count(*) from orders where flipbook_id = p_flipbook and created_at > now() - interval '1 day') >= 200 then
    raise exception '오늘은 더 받을 수 없어요';
  end if;

  -- Snapshot the chosen products at their current names and prices, with the chosen option.
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', p.id, 'name', p.name, 'price', p.price, 'unit', p.unit,
           'options', p.options, 'option', nullif(left(btrim(coalesce(i->>'option', '')), 60), ''),
           'qty', least(greatest((i->>'qty')::int, 1), 999)
         )), '[]'::jsonb),
         coalesce(sum(p.price * least(greatest((i->>'qty')::int, 1), 999)), 0),
         bool_and(p.price is not null)
    into v_snapshot, v_total, v_priced_all
  from jsonb_array_elements(p_items) as i
  join catalog_products p on p.id = (i->>'product_id')::uuid and p.flipbook_id = p_flipbook;

  select jsonb_array_length(coalesce(v_snapshot, '[]'::jsonb)) into v_count;
  if v_count = 0 then raise exception '고른 상품을 찾을 수 없어요'; end if;

  insert into orders (flipbook_id, owner_id, buyer_name, buyer_contact, buyer_company, memo,
                      items, total, marketing_consent, session_id, delivery_date, platform_fee)
  values (p_flipbook, v_owner, v_name, v_contact, v_company, v_memo, v_snapshot,
          case when coalesce(v_priced_all, false) then v_total else null end,
          coalesce(p_marketing, false), p_session, p_delivery,
          case when coalesce(v_priced_all, false) then round(v_total * 0.03)::bigint else null end);

  if coalesce(p_marketing, false) then
    if exists (select 1 from flipbook_leads where flipbook_id = p_flipbook and contact = v_contact) then
      update flipbook_leads set marketing_consent = true
        where flipbook_id = p_flipbook and contact = v_contact;
    else
      insert into flipbook_leads (flipbook_id, owner_id, name, contact, marketing_consent, session_id)
      values (p_flipbook, v_owner, v_name, v_contact, true, p_session);
    end if;
  end if;
end $$;

revoke all on function submit_order(uuid, text, text, text, text, jsonb, boolean, text, date) from public;
grant execute on function submit_order(uuid, text, text, text, text, jsonb, boolean, text, date) to anon, authenticated;

-- ============================================================
-- 43. AI sales analysis: product interest, buyer intent, AI draft usage
--   Intent tiers: hot = ordered, asked for a quote, or priority score >= 40;
--   warm = score >= 15; cold = the rest. Viewing counts only pages held 5s or more.
-- ============================================================
create table if not exists ai_sales_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  month text not null,
  count int not null default 0,
  primary key (user_id, month)
);
alter table ai_sales_usage enable row level security;
-- No policies: only the server (service role) reads or writes this table.

create or replace function get_product_interest(p_flipbook uuid)
returns table (product_id uuid, product_name text, product_page int, product_price bigint,
               viewers int, dwell_ms bigint, ordered_qty bigint)
language sql stable security definer set search_path = public
as $$
  select p.id, p.name, p.page_no, p.price,
    (select count(distinct fv.session_id)::int from flipbook_views fv
      where fv.flipbook_id = p_flipbook and fv.page_no = p.page_no
        and fv.session_id is not null and coalesce(fv.dwell_ms, 0) >= 5000),
    (select coalesce(sum(fv.dwell_ms), 0) from flipbook_views fv
      where fv.flipbook_id = p_flipbook and fv.page_no = p.page_no),
    (select coalesce(sum((it->>'qty')::bigint), 0) from orders o, jsonb_array_elements(o.items) it
      where o.flipbook_id = p_flipbook and it->>'product_id' = p.id::text)
  from catalog_products p
  where p.flipbook_id = p_flipbook and can_manage_flipbook(p_flipbook)
  order by 5 desc, 6 desc;
$$;
revoke all on function get_product_interest(uuid) from public, anon;
grant execute on function get_product_interest(uuid) to authenticated;

create or replace function get_buyer_intent(p_flipbook uuid)
returns table (lead_id uuid, lead_name text, lead_contact text, tier text, score int,
               ordered boolean, asked boolean, dwell_ms bigint, viewed_products text[])
language sql stable security definer set search_path = public
as $$
  with pr as (select * from get_lead_priorities(p_flipbook)),
  ord as (
    select distinct l.id as lead_id from flipbook_leads l
    join orders o on o.flipbook_id = p_flipbook and lower(btrim(o.buyer_contact)) = lower(btrim(l.contact))
    where l.flipbook_id = p_flipbook
  ),
  viewed as (
    select l.id as lead_id, array_agg(distinct p.name order by p.name) as products
    from flipbook_leads l
    join flipbook_views fv on fv.flipbook_id = p_flipbook and fv.session_id = l.session_id
      and coalesce(fv.dwell_ms, 0) >= 5000
    join catalog_products p on p.flipbook_id = p_flipbook and p.page_no = fv.page_no
    where l.flipbook_id = p_flipbook
    group by l.id
  )
  select pr.lead_id, pr.name, pr.contact,
    case when (ord.lead_id is not null or pr.quote_requested or pr.score >= 40) then 'hot'
         when pr.score >= 15 then 'warm' else 'cold' end,
    pr.score, (ord.lead_id is not null), pr.quote_requested, pr.dwell_ms, coalesce(viewed.products, '{}')
  from pr
  left join ord on ord.lead_id = pr.lead_id
  left join viewed on viewed.lead_id = pr.lead_id
  order by pr.score desc;
$$;
revoke all on function get_buyer_intent(uuid) from public, anon;
grant execute on function get_buyer_intent(uuid) to authenticated;

notify pgrst, 'reload schema';

-- ============================================================
-- 44. QR codes: per-product or per-page tracking, visits and inquiries per code
--   A visit that comes through a QR link stores the code in flipbook_views.qr.
--   Leads, quotes and orders are linked to the code through their session.
-- ============================================================
alter table flipbook_views add column if not exists qr text;

create table if not exists qr_codes (
  id uuid primary key default gen_random_uuid(),
  flipbook_id uuid not null references flipbooks(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  code text not null unique check (code ~ '^[A-Za-z0-9]{6,12}$'),
  label text not null check (char_length(label) between 1 and 60),
  page_no int,
  product_id uuid references catalog_products(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists qr_codes_flipbook_idx on qr_codes (flipbook_id);
alter table qr_codes enable row level security;
drop policy if exists qr_codes_manage on qr_codes;
create policy qr_codes_manage on qr_codes for all
  using (can_manage_flipbook(flipbook_id))
  with check (can_manage_flipbook(flipbook_id) and owner_id = auth.uid());

-- Replace the 6-argument record_view with a 7-argument one (qr is optional).
drop function if exists record_view(uuid, text, int, int, text, text);

create or replace function record_view(
  p_flipbook uuid, p_session text, p_page int, p_dwell int, p_ua text,
  p_src text default null, p_qr text default null
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
  if (select count(*) from flipbook_views
       where session_id = p_session and viewed_at > now() - interval '10 minutes') >= 300 then
    return;
  end if;
  if (select count(*) from flipbook_views
       where flipbook_id = p_flipbook and viewed_at > now() - interval '1 day') >= 50000 then
    return;
  end if;
  v_is_new := not exists (
    select 1 from flipbook_views where flipbook_id = p_flipbook and session_id = p_session
  );
  insert into flipbook_views (flipbook_id, session_id, page_no, dwell_ms, user_agent, src, qr)
  values (p_flipbook, p_session, p_page,
          greatest(0, least(coalesce(p_dwell, 0), 3600000)), left(p_ua, 255),
          case when p_src ~ '^[a-z]{1,16}$' then p_src else null end,
          case when p_qr ~ '^[A-Za-z0-9]{6,12}$'
                and exists (select 1 from qr_codes q where q.code = p_qr and q.flipbook_id = p_flipbook)
               then p_qr else null end);
  if v_is_new then
    update flipbooks set views = views + 1 where id = p_flipbook;
  end if;
end $$;
revoke all on function record_view(uuid, text, int, int, text, text, text) from public;
grant execute on function record_view(uuid, text, int, int, text, text, text) to anon, authenticated;

create or replace function get_qr_stats(p_flipbook uuid)
returns table (qr_id uuid, qr_code text, qr_label text, qr_page int, qr_product text,
               visitors int, leads int, quotes int, orders int)
language sql stable security definer set search_path = public
as $$
  select q.id, q.code, q.label, q.page_no, p.name,
    (select count(distinct fv.session_id)::int from flipbook_views fv
      where fv.flipbook_id = p_flipbook and fv.qr = q.code and fv.session_id is not null),
    (select count(*)::int from flipbook_leads l
      where l.flipbook_id = p_flipbook and l.session_id in (
        select fv.session_id from flipbook_views fv where fv.flipbook_id = p_flipbook and fv.qr = q.code)),
    (select count(*)::int from quote_requests qr
      where qr.flipbook_id = p_flipbook and qr.session_id in (
        select fv.session_id from flipbook_views fv where fv.flipbook_id = p_flipbook and fv.qr = q.code)),
    (select count(*)::int from orders o
      where o.flipbook_id = p_flipbook and o.session_id in (
        select fv.session_id from flipbook_views fv where fv.flipbook_id = p_flipbook and fv.qr = q.code))
  from qr_codes q
  left join catalog_products p on p.id = q.product_id
  where q.flipbook_id = p_flipbook and can_manage_flipbook(p_flipbook)
  order by q.created_at;
$$;
revoke all on function get_qr_stats(uuid) from public, anon;
grant execute on function get_qr_stats(uuid) to authenticated;

notify pgrst, 'reload schema';

-- ============================================================
-- 45. Product photos and descriptions
--   bbox: where the product photo sits on its catalog page, as [x, y, width, height] (0..1).
--   image_url: the cropped photo, stored in the catalog's public folder.
-- ============================================================
alter table catalog_products add column if not exists image_url text;
alter table catalog_products add column if not exists bbox jsonb;
alter table catalog_products drop constraint if exists catalog_products_bbox_chk;
alter table catalog_products add constraint catalog_products_bbox_chk
  check (bbox is null or (jsonb_typeof(bbox) = 'array' and jsonb_array_length(bbox) = 4));

drop function if exists get_products(text);
create or replace function get_products(p_slug text)
returns table (id uuid, name text, price bigint, unit text, options text, description text, page_no int, image_url text)
language sql stable security definer set search_path = public
as $$
  select p.id, p.name, p.price, p.unit, p.options, p.description, p.page_no, p.image_url
  from catalog_products p
  join flipbooks f on f.id = p.flipbook_id
  where f.slug = p_slug and f.is_public and (f.expires_at is null or f.expires_at > now())
  order by p.page_no nulls last, p.created_at;
$$;
grant execute on function get_products(text) to anon, authenticated;

notify pgrst, 'reload schema';
