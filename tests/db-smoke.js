const assert = require('node:assert/strict');

const { ensureSchema, query } = require('../api/_lib/db');
const { estimateCostForRun, extractAllowedRows } = require('../api/_lib/pricing');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  await ensureSchema();

  await query("insert into app_users (id, display_name, role, totp_secret) values ('usr_smoke','smoke-admin','admin','JBSWY3DPEHPK3PXP') on conflict (id) do nothing");

  const rows = extractAllowedRows({
    openai: { models: { 'gpt-5.5': { name: 'GPT-5.5', cost: { input: 5, output: 30 } } } },
    anthropic: { models: { 'claude-opus-4.8': { name: 'Claude Opus 4.8', cost: { input: 5, output: 25 } } } },
    google: { models: { 'gemini-3.1-pro-preview': { name: 'Gemini 3.1 Pro', cost: { input: 2, output: 12 } } } },
    vercel: { models: { 'sakana/fugu-ultra': { name: 'Fugu Ultra', cost: { input: 5, output: 30 } } } }
  });

  await query('delete from model_prices');
  for (const row of rows) {
    await query(
      `insert into model_prices (model_group, source_provider, model_id, model_alias, model_name, cost_json, limit_json, modalities_json)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)`,
      [
        row.model_group,
        row.source_provider,
        row.model_id,
        row.model_alias,
        row.model_name,
        JSON.stringify(row.cost_json),
        JSON.stringify(row.limit_json),
        JSON.stringify(row.modalities_json)
      ]
    );
  }

  const priceCount = await query('select count(*)::int as n from model_prices');
  assert.equal(priceCount.rows[0].n, rows.length);

  const fuguCost = await estimateCostForRun('Sakana', 'fugu-ultra', { input_tokens: 1000, output_tokens: 1000 });
  assert.equal(fuguCost.estimated_cost_usd, 0.035);
  assert.equal(fuguCost.cost_source, 'price_table:vercel/sakana/fugu-ultra');

  const routedOpenAICost = await estimateCostForRun('Sakana', 'openai/gpt-5.5', { input_tokens: 1000, output_tokens: 1000 });
  assert.equal(routedOpenAICost.estimated_cost_usd, 0.035);
  assert.equal(routedOpenAICost.cost_source, 'price_table:routed:OpenAI:openai/gpt-5.5');

  await query(
    `insert into test_runs (
      id, user_id, model_group, provider, model_id, question_id, question_name,
      endpoint_type, request_body, response_headers, response_body, ok, usage_json,
      estimated_cost_usd, cost_source
    ) values (
      'run_smoke','usr_smoke','OpenAI','openai','gpt-5.5','smoke','Smoke',
      'openai_responses',$1::jsonb,$2::jsonb,$3::jsonb,true,$4::jsonb,0.035,'price_table:openai/gpt-5.5'
    ) on conflict (id) do update set created_at=now()`,
    [
      JSON.stringify({ model: 'gpt-5.5' }),
      JSON.stringify({}),
      JSON.stringify({ ok: true }),
      JSON.stringify({ input_tokens: 1000, output_tokens: 1000 })
    ]
  );
  const run = await query('select * from test_runs where id=$1', ['run_smoke']);
  assert.equal(run.rows.length, 1);
  assert.equal(run.rows[0].cost_source, 'price_table:openai/gpt-5.5');

  // Endpoint configs: multiple named endpoints per group, encrypted keys, delete, dup-name guard.
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'smoke-test-session-secret';
  const { encryptSecret, decryptSecret } = require('../api/_lib/secrets');
  await query('delete from endpoint_configs');

  const insertEp = (id, name, model, key) => query(
    `insert into endpoint_configs (id, model_group, name, base_url, model, auth_mode, api_key_cipher, updated_by)
     values ($1,'OpenAI',$2,'https://api.openai.com',$3,'bearer',$4,'usr_smoke')`,
    [id, name, model, key == null ? null : encryptSecret(key)]
  );

  // Two endpoints under one group with distinct names + keys.
  await insertEp('ep_official', '官方', 'gpt-5.5', 'sk-official');
  await insertEp('ep_proxy', '代理A', 'gpt-5.5', 'sk-proxy');
  let eps = await query('select * from endpoint_configs where model_group=$1 order by name', ['OpenAI']);
  assert.equal(eps.rows.length, 2);
  const byName = Object.fromEntries(eps.rows.map((r) => [r.name, r]));
  assert.equal(decryptSecret(byName['官方'].api_key_cipher), 'sk-official');
  assert.equal(decryptSecret(byName['代理A'].api_key_cipher), 'sk-proxy');
  assert.notEqual(byName['官方'].api_key_cipher, 'sk-official');

  // unique(model_group, name) guard rejects a duplicate name.
  await assert.rejects(() => insertEp('ep_dup', '官方', 'gpt-5.5', 'sk-x'), /duplicate|unique/i);

  // Non-key edit (cipher null) coalesces to the existing cipher.
  await query(
    `insert into endpoint_configs (id, model_group, name, base_url, model, auth_mode, api_key_cipher, updated_by)
     values ('ep_official','OpenAI','官方','https://api.openai.com','gpt-5.5-pro','bearer',$1,'usr_smoke')
     on conflict (id) do update set
       model = excluded.model,
       api_key_cipher = coalesce(excluded.api_key_cipher, endpoint_configs.api_key_cipher)`,
    [null]
  );
  let official = await query("select * from endpoint_configs where id='ep_official'");
  assert.equal(official.rows[0].model, 'gpt-5.5-pro');
  assert.equal(decryptSecret(official.rows[0].api_key_cipher), 'sk-official');

  // Model list + enabled subset round-trip as jsonb with a sync timestamp.
  await query(
    "update endpoint_configs set models_json=$1, enabled_models_json=$2, models_synced_at=now() where id='ep_official'",
    [JSON.stringify(['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.5-mini']), JSON.stringify(['gpt-5.5', 'gpt-5.5-mini'])]
  );
  official = await query("select * from endpoint_configs where id='ep_official'");
  assert.deepEqual(official.rows[0].models_json, ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.5-mini']);
  assert.deepEqual(official.rows[0].enabled_models_json, ['gpt-5.5', 'gpt-5.5-mini']);
  assert.ok(official.rows[0].models_synced_at);

  // A sync that drops a model upstream prunes it from the enabled subset
  // (intersect enabled ∩ new list) — mirrors syncEndpointModels.
  const row = official.rows[0];
  const newList = ['gpt-5.5', 'gpt-5.5-pro'];               // gpt-5.5-mini gone upstream
  const available = new Set(newList);
  const pruned = (row.enabled_models_json || []).filter((m) => available.has(m));
  await query(
    "update endpoint_configs set models_json=$1, enabled_models_json=$2 where id='ep_official'",
    [JSON.stringify(newList), JSON.stringify(pruned)]
  );
  official = await query("select * from endpoint_configs where id='ep_official'");
  assert.deepEqual(official.rows[0].enabled_models_json, ['gpt-5.5']);

  // Delete one endpoint; the other and its key survive.
  await query("delete from endpoint_configs where id='ep_proxy'");
  eps = await query('select * from endpoint_configs where model_group=$1', ['OpenAI']);
  assert.equal(eps.rows.length, 1);
  assert.equal(decryptSecret(eps.rows[0].api_key_cipher), 'sk-official');

  console.log(JSON.stringify({ ok: true, prices: priceCount.rows[0].n, run: run.rows[0].id, endpoints: eps.rows.length }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
