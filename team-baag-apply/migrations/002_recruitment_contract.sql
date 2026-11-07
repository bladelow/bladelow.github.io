-- TEAM_BAAG recruitment (RECRUITMENT.md contract storage model reference)
-- The Node backend can run with a durable file store (data/recruitment.json) by default.
-- Use this migration when moving to PostgreSQL/Supabase for the /api/v1 contract.

create table if not exists recruitment_applications (
  id text primary key,
  guild_id text not null,
  discord_user_id text not null,
  discord_username text not null,
  age_group text,
  skills jsonb not null default '[]',
  experience text,
  portfolio_links jsonb not null default '[]',
  portfolio_evidence jsonb not null default '[]',
  answers jsonb not null default '{}',
  status text not null check (status in ('submitted','pending_analysis','review_pending','more_information_requested','approved','rejected')),
  revision integer not null default 1,
  analysis jsonb,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists recruitment_app_guild_status_idx on recruitment_applications (guild_id, status, submitted_at, id);
create index if not exists recruitment_app_guild_user_idx on recruitment_applications (guild_id, discord_user_id);
-- Authoritative duplicate prevention for active applications per (guild,user)
create unique index if not exists recruitment_one_active_per_user
  on recruitment_applications (guild_id, discord_user_id)
  where status in ('submitted','pending_analysis','review_pending','more_information_requested','approved');

create table if not exists recruitment_idempotency (
  scope_key text primary key,
  status integer not null,
  body jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists recruitment_audit_logs (
  id bigserial primary key,
  application_id text,
  actor text,
  action text,
  meta jsonb,
  created_at timestamptz not null default now()
);
