-- Run once in the Supabase SQL editor. The app uses the service role key on the server only.
create table if not exists public.guides (
  slug            text primary key,
  name            text not null,
  website         text not null default '',
  evidence_level  text not null check (evidence_level in ('tested', 'docs', 'generated')),
  checked_on      date,
  data            jsonb not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists guides_website_idx on public.guides (lower(website));

-- Row level security on; no public policies. Only the server (service role) reads and writes.
alter table public.guides enable row level security;
