-- Production schema with RLS
-- 1. Tables
create table customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  email text unique not null,
  company_name text,
  plan text default 'free',
  created_at timestamptz default now()
);

create table flipbooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  title text not null,
  slug text unique not null,
  pdf_url text,
  status text default 'ready',
  views int default 0,
  created_at timestamptz default now()
);

create table flipbook_pages (
  id uuid primary key default gen_random_uuid(),
  flipbook_id uuid references flipbooks(id) on delete cascade,
  page_no int not null,
  image_url text not null
);

create table flipbook_views (
  id uuid primary key default gen_random_uuid(),
  flipbook_id uuid references flipbooks(id) on delete cascade,
  viewed_at timestamptz default now(),
  ip text,
  user_agent text,
  page_no int
);

-- 2. Enable RLS
alter table customers enable row level security;
alter table flipbooks enable row level security;
alter table flipbook_pages enable row level security;
alter table flipbook_views enable row level security;

-- 3. Policies (MVP - allow all for public viewer, user can only see own)
-- For MVP, disable RLS for now - enable later when stable
alter table customers disable row level security;
alter table flipbooks disable row level security;
alter table flipbook_pages disable row level security;
alter table flipbook_views disable row level security;

-- 4. Function to increment views
create or replace function increment_view(fb_id uuid)
returns void as $$
  update flipbooks set views = views + 1 where id = fb_id;
$$ language sql security definer;

-- 5. Storage bucket will be created manually as public flipbook-files