const { ensureSchema, query } = require('../_lib/db');
const { requireAdmin, randomId } = require('../_lib/auth');
const { encryptSecret, decryptSecret } = require('../_lib/secrets');
const { buildModelsRequest, extractModelIds, fetchOnce, normalizeGroup } = require('../_lib/providers');
const { readJson, sendJson, sendMethodNotAllowed } = require('../_lib/http');

const GROUPS = ['OpenAI', 'Anthropic', 'Google', 'Sakana', 'Image'];

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function rowToConfig(row) {
  return {
    id: row.id,
    group: row.model_group,
    name: row.name,
    baseUrl: row.base_url || '',
    model: row.model || '',
    authMode: row.auth_mode || 'bearer',
    maxTokens: row.max_tokens == null ? 1024 : row.max_tokens,
    timeout: row.timeout == null ? 120000 : row.timeout,
    delay: row.delay == null ? 300 : row.delay,
    system: row.system_prompt || '',
    imageN: row.image_n == null ? 1 : row.image_n,
    imageQuality: row.image_quality || 'medium',
    imageSize: row.image_size || '1024x1024',
    apiKey: decryptSecret(row.api_key_cipher),
    hasApiKey: !!row.api_key_cipher,
    models: Array.isArray(row.models_json) ? row.models_json : [],
    enabledModels: Array.isArray(row.enabled_models_json) ? row.enabled_models_json : [],
    modelsSyncedAt: row.models_synced_at,
    updatedAt: row.updated_at
  };
}

// Fetch a channel's model list using the given credentials. Reused by detect
// (form values) and sync (stored, decrypted key). Throws on transport error;
// returns { ok, status, models, message } describing the upstream result.
async function fetchModels(group, cfg) {
  const request = buildModelsRequest(group, cfg);
  const resp = await fetchOnce(request, Number(cfg.timeout) || 30000);
  if (!resp.ok) {
    const body = resp.json || {};
    const message = (body.error && (body.error.message || body.error.type)) || resp.statusText || 'upstream_error';
    return { ok: false, status: resp.status, models: [], message };
  }
  return { ok: true, status: resp.status, models: extractModelIds(group, resp.json), message: null };
}

// Sync one stored endpoint row's model list. Best-effort: returns a summary.
async function syncEndpointModels(row) {
  const cfg = {
    group: row.model_group,
    baseUrl: row.base_url || '',
    authMode: row.auth_mode || 'bearer',
    apiKey: decryptSecret(row.api_key_cipher)
  };
  if (!cfg.apiKey) return { id: row.id, name: row.name, ok: false, message: 'no_api_key' };
  try {
    const res = await fetchModels(row.model_group, cfg);
    if (!res.ok) return { id: row.id, name: row.name, ok: false, status: res.status, message: res.message };
    // Prune the enabled subset to models that still exist upstream.
    const available = new Set(res.models);
    const prevEnabled = Array.isArray(row.enabled_models_json) ? row.enabled_models_json : [];
    const enabled = prevEnabled.filter((m) => available.has(m));
    const updated = await query(
      'update endpoint_configs set models_json=$1, enabled_models_json=$2, models_synced_at=now() where id=$3 returning models_synced_at',
      [JSON.stringify(res.models), JSON.stringify(enabled), row.id]
    );
    return { id: row.id, name: row.name, ok: true, count: res.models.length, enabled: enabled.length, syncedAt: updated.rows[0].models_synced_at };
  } catch (e) {
    return { id: row.id, name: row.name, ok: false, message: e.message };
  }
}

async function handleRequest(req, res) {
  await ensureSchema();
  const user = await requireAdmin(req, res);
  if (!user) return;

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const action = url.searchParams.get('action');

  if (req.method === 'GET') {
    const result = await query('select * from endpoint_configs order by model_group, name');
    const byGroup = {};
    for (const g of GROUPS) byGroup[g] = [];
    for (const row of result.rows) (byGroup[row.model_group] || (byGroup[row.model_group] = [])).push(rowToConfig(row));
    return sendJson(res, 200, { ok: true, configs: byGroup });
  }

  if (req.method === 'POST') {
    let payload;
    try {
      payload = await readJson(req);
    } catch (e) {
      return sendJson(res, 400, { error: 'bad_json', detail: e.message });
    }

    // Probe a channel's model list without writing. Uses form apiKey, or the
    // stored (decrypted) key when only { id } is given.
    if (action === 'detect') {
      const group = normalizeGroup(payload.group);
      if (!GROUPS.includes(group)) return sendJson(res, 400, { error: 'bad_group' });
      let cfg = {
        group,
        baseUrl: String(payload.baseUrl || '').trim(),
        authMode: payload.authMode || 'bearer',
        apiKey: typeof payload.apiKey === 'string' ? payload.apiKey.trim() : ''
      };
      if (!cfg.apiKey && payload.id) {
        const stored = await query('select * from endpoint_configs where id=$1', [String(payload.id)]);
        if (stored.rows[0]) {
          cfg.apiKey = decryptSecret(stored.rows[0].api_key_cipher);
          if (!cfg.baseUrl) cfg.baseUrl = stored.rows[0].base_url || '';
        }
      }
      if (!cfg.apiKey) return sendJson(res, 400, { error: 'missing_api_key', detail: '请先填写 API Key' });
      try {
        const result = await fetchModels(group, cfg);
        if (!result.ok) return sendJson(res, 502, { error: 'detect_failed', status: result.status, detail: result.message });
        return sendJson(res, 200, { ok: true, models: result.models, count: result.models.length });
      } catch (e) {
        return sendJson(res, 502, { error: 'detect_failed', detail: e.message });
      }
    }

    // Sync stored endpoints' model lists (one via { id }, or all).
    if (action === 'sync') {
      let rows;
      if (payload.id) {
        rows = (await query('select * from endpoint_configs where id=$1', [String(payload.id)])).rows;
      } else {
        rows = (await query('select * from endpoint_configs')).rows;
      }
      const results = [];
      for (const row of rows) results.push(await syncEndpointModels(row));
      return sendJson(res, 200, { ok: true, results });
    }

    // Upsert one endpoint.
    const group = String(payload.group || '').trim();
    if (!GROUPS.includes(group)) return sendJson(res, 400, { error: 'bad_group' });
    const name = String(payload.name || '').trim();
    if (!name) return sendJson(res, 400, { error: 'missing_name' });
    // Save is gated on at least one enabled model (detected + ticked in the panel).
    const enabledModels = Array.isArray(payload.enabledModels) ? payload.enabledModels.filter((m) => typeof m === 'string' && m.trim()) : [];
    if (!enabledModels.length) return sendJson(res, 400, { error: 'no_enabled_models', detail: '请先检测并至少启用一个模型' });
    const id = String(payload.id || '').trim() || randomId('ep');

    // Empty/omitted apiKey preserves the existing cipher so a non-key edit does
    // not wipe a saved key. Encrypt only when a new key is provided.
    const hasNewKey = typeof payload.apiKey === 'string' && payload.apiKey.trim() !== '';
    const cipher = hasNewKey ? encryptSecret(payload.apiKey.trim()) : null;
    // Model list: caller may pass a detected list; null leaves the stored one.
    const models = Array.isArray(payload.models) ? JSON.stringify(payload.models) : null;
    const enabled = JSON.stringify(enabledModels);

    try {
      const result = await query(
        `insert into endpoint_configs (
           id, model_group, name, base_url, model, auth_mode, max_tokens, timeout, delay,
           system_prompt, image_n, image_quality, image_size, api_key_cipher,
           models_json, enabled_models_json, models_synced_at, updated_by, updated_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
           case when $15 is null then null else now() end, $17, now())
         on conflict (id) do update set
           model_group = excluded.model_group,
           name = excluded.name,
           base_url = excluded.base_url,
           model = excluded.model,
           auth_mode = excluded.auth_mode,
           max_tokens = excluded.max_tokens,
           timeout = excluded.timeout,
           delay = excluded.delay,
           system_prompt = excluded.system_prompt,
           image_n = excluded.image_n,
           image_quality = excluded.image_quality,
           image_size = excluded.image_size,
           api_key_cipher = coalesce(excluded.api_key_cipher, endpoint_configs.api_key_cipher),
           models_json = coalesce(excluded.models_json, endpoint_configs.models_json),
           enabled_models_json = excluded.enabled_models_json,
           models_synced_at = case when excluded.models_json is null then endpoint_configs.models_synced_at else now() end,
           updated_by = excluded.updated_by,
           updated_at = now()
         returning *`,
        [
          id,
          group,
          name,
          String(payload.baseUrl || '').trim() || null,
          null,
          String(payload.authMode || 'bearer').trim() || 'bearer',
          toInt(payload.maxTokens, 1024),
          toInt(payload.timeout, 120000),
          toInt(payload.delay, 300),
          payload.system == null ? null : String(payload.system),
          toInt(payload.imageN, 1),
          String(payload.imageQuality || 'medium').trim() || 'medium',
          String(payload.imageSize || '1024x1024').trim() || '1024x1024',
          cipher,
          models,
          enabled,
          user.id
        ]
      );
      return sendJson(res, 200, { ok: true, config: rowToConfig(result.rows[0]) });
    } catch (e) {
      if (e.code === '23505' || /duplicate/i.test(e.message)) {
        return sendJson(res, 409, { error: 'duplicate_name', detail: '该分组下已存在同名端点' });
      }
      throw e;
    }
  }

  if (req.method === 'DELETE') {
    let id = url.searchParams.get('id');
    if (!id) {
      try { id = (await readJson(req)).id; } catch (e) { id = null; }
    }
    if (!id) return sendJson(res, 400, { error: 'missing_id' });
    await query('delete from endpoint_configs where id=$1', [String(id)]);
    return sendJson(res, 200, { ok: true });
  }

  return sendMethodNotAllowed(res, ['GET', 'POST', 'DELETE']);
}

// Surface unexpected errors as JSON so the client shows a real reason instead
// of a blank 500 body ("保存失败：" with nothing after it).
module.exports = async function handler(req, res) {
  try {
    await handleRequest(req, res);
  } catch (e) {
    if (res.headersSent || res.writableEnded) throw e;
    sendJson(res, 500, { error: 'server_error', detail: e.message || String(e) });
  }
};

module.exports.syncEndpointModels = syncEndpointModels;
