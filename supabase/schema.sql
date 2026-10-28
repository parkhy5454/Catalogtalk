
-- Supabase SQL - SQL Editor에 붙여넣기
-- 1. 테이블 생성
create table customers (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  company_name text,
  plan text default 'free',
  created_at timestamp with time zone default now()
);

create table flipbooks (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete cascade,
  title text not null,
  slug text unique not null, -- ex: cool-auto-2024
  pdf_url text, -- supabase storage url
  status text default 'ready',
  views int default 0,
  created_at timestamp with time zone default now()
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
  viewed_at timestamp with time zone default now(),
  ip text,
  user_agent text,
  page_no int
);

-- 2. Storage 버킷 생성 (Supabase Dashboard > Storage 에서 수동으로 flipbook-files 버킷 public으로 생성, 또는 SQL)
insert into storage.buckets (id, name, public) values ('flipbook-files', 'flipbook-files', true)
on conflict (id) do nothing;

-- 3. RLS 비활성화 (MVP용 - 나중에 활성화)
alter table customers disable row level security;
alter table flipbooks disable row level security;
alter table flipbook_pages disable row level security;
alter table flipbook_views disable row level security;

-- 4. 조회수 증가 함수
create or replace function increment_view(fb_id uuid)
returns void as $$
  update flipbooks set views = views + 1 where id = fb_id;
$$ language sql;
