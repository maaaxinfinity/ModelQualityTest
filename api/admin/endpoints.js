const { ensureSchema, query } = require('../_lib/db');
const { requireAdmin, randomId } = require('../_lib/auth');
const { encryptSecret, decryptSecret } = require('../_lib/secrets');
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
    updatedAt: row.updated_at
  };
}

module.exports = async function handler(req, res) {
  await ensureSchema();
  const user = await requireAdmin(req, res);
  if (!user) return;

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
    const group = String(payload.group || '').trim();
    if (!GROUPS.includes(group)) return sendJson(res, 400, { error: 'bad_group' });
    const name = String(payload.name || '').trim();
    if (!name) return sendJson(res, 400, { error: 'missing_name' });
    const id = String(payload.id || '').trim() || randomId('ep');

    // Empty/omitted apiKey preserves the existing cipher so a non-key edit does
    // not wipe a saved key. Encrypt only when a new key is provided.
    const hasNewKey = typeof payload.apiKey === 'string' && payload.apiKey.trim() !== '';
    const cipher = hasNewKey ? encryptSecret(payload.apiKey.trim()) : null;

    try {
      const result = await query(
        `insert into endpoint_configs (
           id, model_group, name, base_url, model, auth_mode, max_tokens, timeout, delay,
           system_prompt, image_n, image_quality, image_size, api_key_cipher,
           updated_by, updated_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
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
           updated_by = excluded.updated_by,
           updated_at = now()
         returning *`,
        [
          id,
          group,
          name,
          String(payload.baseUrl || '').trim() || null,
          String(payload.model || '').trim() || null,
          String(payload.authMode || 'bearer').trim() || 'bearer',
          toInt(payload.maxTokens, 1024),
          toInt(payload.timeout, 120000),
          toInt(payload.delay, 300),
          payload.system == null ? null : String(payload.system),
          toInt(payload.imageN, 1),
          String(payload.imageQuality || 'medium').trim() || 'medium',
          String(payload.imageSize || '1024x1024').trim() || '1024x1024',
          cipher,
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
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let id = url.searchParams.get('id');
    if (!id) {
      try { id = (await readJson(req)).id; } catch (e) { id = null; }
    }
    if (!id) return sendJson(res, 400, { error: 'missing_id' });
    await query('delete from endpoint_configs where id=$1', [String(id)]);
    return sendJson(res, 200, { ok: true });
  }

  return sendMethodNotAllowed(res, ['GET', 'POST', 'DELETE']);
};
