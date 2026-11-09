-- Paste into Supabase → SQL Editor → Run. Creates the one table the rota uses.
create table if not exists public.rota (
  key text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.rota enable row level security;
create policy "anyone can read"   on public.rota for select using (true);
create policy "anyone can add"    on public.rota for insert with check (true);
create policy "anyone can update" on public.rota for update using (true) with check (true);
