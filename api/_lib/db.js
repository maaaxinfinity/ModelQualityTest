const { Pool } = require('pg');

let pool;
let schemaReady;

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for auth, logs, and exports');
  }
  if (!pool) {
    const ssl = process.env.PGSSLMODE === 'disable' || process.env.PGSSL === 'disable'
      ? false
      : { rejectUnauthorized: false };
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl,
      max: Number(process.env.PG_POOL_MAX || 3),
      allowExitOnIdle: true
    });
  }
  return pool;
}

async function query(text, params) {
  const client = getPool();
  return client.query(text, params);
}

async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await query(`
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

      create table if not exists endpoint_configs (
        id text primary key,
        model_group text not null,
        name text not null,
        base_url text,
        model text,
        auth_mode text,
        max_tokens integer,
        timeout integer,
        delay integer,
        system_prompt text,
        image_n integer,
        image_quality text,
        image_size text,
        api_key_cipher text,
        updated_by text references app_users(id),
        updated_at timestamptz not null default now(),
        unique (model_group, name)
      );
      create index if not exists endpoint_configs_group_idx on endpoint_configs(model_group);
    `);
    // Migrate the original one-row-per-group shape (model_group PRIMARY KEY) to
    // many-per-group (id PRIMARY KEY, named endpoints). No-op on a fresh DB.
    await query('alter table endpoint_configs add column if not exists id text');
    await query('alter table endpoint_configs add column if not exists name text');
    await query("update endpoint_configs set id = 'ep_' || model_group where id is null");
    await query("update endpoint_configs set name = '默认' where name is null");
    await query(`
      do $$ begin
        if exists (
          select 1 from information_schema.table_constraints tc
          join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
          where tc.table_name = 'endpoint_configs' and tc.constraint_type = 'PRIMARY KEY'
            and kcu.column_name = 'model_group'
        ) then
          alter table endpoint_configs drop constraint endpoint_configs_pkey;
          alter table endpoint_configs add primary key (id);
          alter table endpoint_configs add constraint endpoint_configs_group_name_key unique (model_group, name);
        end if;
      end $$;
    `);
    await query('alter table app_users add column if not exists last_totp_counter bigint');
    await query('alter table auth_enrollments add column if not exists user_id text references app_users(id)');
    await query('create index if not exists auth_enrollments_user_mode_idx on auth_enrollments(user_id, mode, created_at desc)');
  })();
  return schemaReady;
}

module.exports = { ensureSchema, query, transaction };
