create table if not exists app_users (
  id text primary key,
  display_name text not null unique,
  role text not null default 'admin',
  totp_secret text not null,
  last_totp_counter bigint,
  created_at timestamptz not null default now(),
  created_by text references app_users(id),
  last_login_at timestamptz
);

create table if not exists auth_enrollments (
  id text primary key,
  user_id text references app_users(id),
  display_name text not null,
  totp_secret text not null,
  invite_code text,
  mode text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists invite_codes (
  code text primary key,
  role text not null default 'admin',
  created_by text references app_users(id),
  max_uses integer not null default 1,
  used_count integer not null default 0,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists test_runs (
  id text primary key,
  batch_id text,
  user_id text references app_users(id),
  model_group text not null,
  provider text not null,
  model_id text not null,
  routed_model_id text,
  question_id text not null,
  question_name text not null,
  endpoint_type text not null,
  request_endpoint text,
  request_body jsonb,
  response_status integer,
  response_headers jsonb,
  response_body jsonb,
  ok boolean not null default false,
  elapsed_ms integer,
  usage_json jsonb,
  estimated_cost_usd double precision,
  cost_source text,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists test_runs_created_at_idx on test_runs(created_at desc);
create index if not exists test_runs_group_idx on test_runs(model_group, created_at desc);
create index if not exists test_runs_question_idx on test_runs(question_id, created_at desc);

create table if not exists model_prices (
  model_group text not null,
  source_provider text not null,
  model_id text not null,
  model_alias text not null,
  model_name text,
  cost_json jsonb not null,
  limit_json jsonb,
  modalities_json jsonb,
  synced_at timestamptz not null default now(),
  primary key (model_group, source_provider, model_id)
);

create index if not exists model_prices_lookup_idx on model_prices(model_group, model_alias);
create index if not exists model_prices_synced_at_idx on model_prices(synced_at desc);
create index if not exists auth_enrollments_user_mode_idx on auth_enrollments(user_id, mode, created_at desc);
