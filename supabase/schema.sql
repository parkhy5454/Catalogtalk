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
  v_new uuid;
begin
  if v_ref is not null then
    select id into v_referrer from customers where referral_code = v_ref limit 1;
  end if;

  insert into customers (user_id, email, company_name, name, phone, referral_code, referred_by, bonus_flipbooks)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'company_name',
    new.raw_user_meta_data ->> 'name',
    new.raw_user_meta_data ->> 'phone',
    upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)),
    v_referrer,
    case when v_referrer is not null then 1 else 0 end
  )
  on conflict (email) do nothing
  returning id into v_new;

  if v_new is not null and v_referrer is not null then
    update customers set bonus_flipbooks = bonus_flipbooks + 1 where id = v_referrer;
  end if;
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
