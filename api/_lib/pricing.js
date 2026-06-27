const { ensureSchema, query, transaction } = require('./db');
const { normalizeGroup } = require('./providers');

const MODELS_DEV_URL = 'https://models.dev/api.json';

const GROUP_SOURCE_RULES = [
  {
    group: 'OpenAI',
    sourceProviders: ['openai'],
    acceptModel: (id) => /^gpt-|^o\d|^chatgpt/i.test(id) && !/^gpt-image/i.test(id)
  },
  {
    group: 'Image',
    sourceProviders: ['openai'],
    acceptModel: (id) => /^gpt-image/i.test(id)
  },
  {
    group: 'Anthropic',
    sourceProviders: ['anthropic'],
    acceptModel: (id) => /^claude/i.test(id)
  },
  {
    group: 'Google',
    sourceProviders: ['google', 'google-vertex'],
    acceptModel: (id) => /^gemini/i.test(id)
  },
  {
    group: 'Sakana',
    sourceProviders: ['vercel'],
    acceptModel: (id) => /^sakana\/fugu/i.test(id) || /^fugu/i.test(id)
  }
];

function modelAlias(modelId) {
  const raw = String(modelId || '').trim();
  const leaf = raw.includes('/') ? raw.split('/').pop() : raw;
  return leaf
    .replace(/^openai[-.]/i, '')
    .replace(/^anthropic[-.]/i, '')
    .replace(/^google[-.]/i, '')
    .replace(/^sakana[-.]/i, '');
}

function candidatesForModel(modelId) {
  const raw = String(modelId || '').trim();
  const alias = modelAlias(raw);
  const noAtDefault = alias.replace(/@default$/i, '');
  return [...new Set([raw, alias, noAtDefault].filter(Boolean))];
}

function rowForModel(group, sourceProvider, modelId, model) {
  return {
    model_group: group,
    source_provider: sourceProvider,
    model_id: modelId,
    model_alias: modelAlias(modelId),
    model_name: model.name || modelId,
    cost_json: model.cost || {},
    limit_json: model.limit || null,
    modalities_json: model.modalities || null
  };
}

function extractAllowedRows(data) {
  const rows = [];
  for (const rule of GROUP_SOURCE_RULES) {
    const sourceEntries = Object.entries(data || {}).filter(([providerId]) => {
      return rule.sourceProviders.includes('*') || rule.sourceProviders.includes(providerId);
    });
    for (const [sourceProvider, provider] of sourceEntries) {
      for (const [modelId, model] of Object.entries(provider.models || {})) {
        if (!model || !model.cost || !Object.keys(model.cost).length) continue;
        if (!rule.acceptModel(modelId)) continue;
        rows.push(rowForModel(rule.group, sourceProvider, modelId, model));
      }
    }
  }
  return rows;
}

async function syncPricesFromModelsDev() {
  await ensureSchema();
  const resp = await fetch(MODELS_DEV_URL);
  if (!resp.ok) throw new Error(`models.dev returned HTTP ${resp.status}`);
  const data = await resp.json();
  const rows = extractAllowedRows(data);

  await transaction(async (client) => {
    await client.query('delete from model_prices');
    for (const row of rows) {
      await client.query(
        `insert into model_prices (
          model_group, source_provider, model_id, model_alias, model_name,
          cost_json, limit_json, modalities_json, synced_at
        ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,now())
        on conflict (model_group, source_provider, model_id) do update set
          model_alias=excluded.model_alias,
          model_name=excluded.model_name,
          cost_json=excluded.cost_json,
          limit_json=excluded.limit_json,
          modalities_json=excluded.modalities_json,
          synced_at=excluded.synced_at`,
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
  });

  const counts = rows.reduce((acc, row) => {
    acc[row.model_group] = (acc[row.model_group] || 0) + 1;
    return acc;
  }, {});
  const providers = [...new Set(rows.map((row) => row.source_provider))].sort();
  return {
    ok: true,
    source: MODELS_DEV_URL,
    syncedRows: rows.length,
    counts,
    sourceProviders: providers,
    syncedAt: new Date().toISOString()
  };
}

async function latestPriceSync() {
  await ensureSchema();
  const result = await query(
    `select max(synced_at) as last_synced_at, count(*)::int as row_count
     from model_prices`
  );
  return result.rows[0] || { last_synced_at: null, row_count: 0 };
}

function sourcePriority(groupName) {
  const group = normalizeGroup(groupName);
  if (group === 'OpenAI' || group === 'Image') return ['openai'];
  if (group === 'Anthropic') return ['anthropic'];
  if (group === 'Google') return ['google', 'google-vertex'];
  if (group === 'Sakana') return ['vercel', 'openrouter', 'llmgateway'];
  return [];
}

function inferRoutedPriceGroup(modelId) {
  const raw = String(modelId || '').trim().toLowerCase();
  const alias = modelAlias(raw).toLowerCase();
  const providerPrefix = raw.includes('/') ? raw.split('/')[0] : '';
  if (providerPrefix === 'openai' || /^gpt-|^o\d|^chatgpt/.test(alias)) return 'OpenAI';
  if (providerPrefix === 'anthropic' || /^claude/.test(alias)) return 'Anthropic';
  if (providerPrefix === 'google' || providerPrefix === 'google-vertex' || /^gemini/.test(alias)) return 'Google';
  if (providerPrefix === 'sakana' || /^fugu/.test(alias)) return 'Sakana';
  return null;
}

async function findPrice(groupName, modelId) {
  await ensureSchema();
  const group = normalizeGroup(groupName);
  const candidates = candidatesForModel(modelId);
  if (!candidates.length) return null;
  const result = await query(
    `select *
     from model_prices
     where model_group=$1 and (model_id = any($2::text[]) or model_alias = any($2::text[]))
     order by synced_at desc`,
    [group, candidates]
  );
  if (!result.rows.length) return null;
  const priority = sourcePriority(group);
  return result.rows.sort((a, b) => {
    const ai = priority.indexOf(a.source_provider);
    const bi = priority.indexOf(b.source_provider);
    const av = ai < 0 ? 999 : ai;
    const bv = bi < 0 ? 999 : bi;
    return av - bv;
  })[0];
}

async function findPriceForRun(groupName, modelId) {
  const group = normalizeGroup(groupName);
  const direct = await findPrice(group, modelId);
  if (direct) return { price: direct, routed: false };
  if (group !== 'Sakana') return { price: null, routed: false };
  const routedGroup = inferRoutedPriceGroup(modelId);
  if (!routedGroup || routedGroup === 'Sakana') return { price: null, routed: false };
  const routedPrice = await findPrice(routedGroup, modelId);
  return { price: routedPrice, routed: !!routedPrice };
}

function computeCost(cost, usage) {
  const usageSafe = usage || {};
  const input = Number(usageSafe.input_tokens || 0);
  const output = Number(usageSafe.output_tokens || 0);
  const cacheRead = Number(usageSafe.cache_read_input_tokens || usageSafe.cached_tokens || 0);
  const cacheWrite = Number(usageSafe.cache_creation_input_tokens || 0);
  const estimated = (
    input * Number(cost.input || 0) +
    output * Number(cost.output || 0) +
    cacheRead * Number(cost.cache_read || 0) +
    cacheWrite * Number(cost.cache_write || 0)
  ) / 1000000;
  return Number.isFinite(estimated) ? estimated : null;
}

async function estimateCostForRun(groupName, modelId, usage) {
  const found = await findPriceForRun(groupName, modelId);
  const price = found.price;
  if (!price) {
    const sync = await latestPriceSync();
    return {
      estimated_cost_usd: null,
      cost_source: sync.row_count > 0 ? `price_table:no_match:${normalizeGroup(groupName)}/${modelId}` : 'price_table:missing_sync'
    };
  }
  return {
    estimated_cost_usd: computeCost(price.cost_json || {}, usage),
    cost_source: found.routed
      ? `price_table:routed:${price.model_group}:${price.source_provider}/${price.model_id}`
      : `price_table:${price.source_provider}/${price.model_id}`
  };
}

module.exports = {
  extractAllowedRows,
  estimateCostForRun,
  latestPriceSync,
  syncPricesFromModelsDev
};
