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

  console.log(JSON.stringify({ ok: true, prices: priceCount.rows[0].n, run: run.rows[0].id }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
