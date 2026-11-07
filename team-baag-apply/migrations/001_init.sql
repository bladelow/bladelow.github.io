create table guild_configurations(guild_id text primary key,name text,enabled boolean default true,allow_multiple boolean default true,created_at timestamptz default now());
create table applications(
 id text primary key,guild_id text not null references guild_configurations,
 discord_user_id text not null,discord_username text not null,discord_avatar text,
 age_group text not null check(age_group in('under-13','13-15','16-17','18-20','21+')),
 country text,display_name text,skills text[] not null default '{}',other_skill text,
 experience jsonb not null,portfolio jsonb not null default '{"links":[],"files":[]}',
 status text not null default 'submitted' check(status in('draft','submitted','ai_analysing','pending_manual_review','pending_admin_approval','additional_info_requested','approved','rejected','failed_analysis')),
 submitted_at timestamptz default now(),updated_at timestamptz default now());
create unique index one_pending on applications(guild_id,discord_user_id) where status not in('approved','rejected');
create index on applications(guild_id,status);
create table ai_analyses(id bigserial primary key,application_id text references applications,confidence numeric,recommended_decision text,skills_identified text[],experience_assessment text,portfolio_assessment text,recommended_roles text[],strengths text[],missing_information text[],reasoning text,created_at timestamptz default now());
create table application_decisions(id bigserial primary key,application_id text references applications,decision text check(decision in('approved','rejected','info_requested')),decided_by text,note text,created_at timestamptz default now());
create table application_audit_logs(id bigserial primary key,application_id text,actor text,action text,meta jsonb,created_at timestamptz default now());
create table admin_users(discord_id text primary key,role text default 'admin');
create table admin_notes(id bigserial primary key,application_id text references applications,author text,note text,created_at timestamptz default now());
insert into storage.buckets(id,name,public) values('portfolio','portfolio',false) on conflict do nothing;
