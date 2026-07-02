const { ensureSchema, query } = require('../_lib/db');
const { requireAdmin } = require('../_lib/auth');
const { encryptSecret, decryptSecret } = require('../_lib/secrets');
const { readJson, sendJson, sendMethodNotAllowed } = require('../_lib/http');

const GROUPS = ['OpenAI', 'Anthropic', 'Google', 'Sakana', 'Image'];

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function rowToConfig(row) {
  return {
    group: row.model_group,
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
    const result = await query('select * from endpoint_configs');
    const byGroup = {};
    for (const row of result.rows) byGroup[row.model_group] = rowToConfig(row);
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

    // Empty/omitted apiKey preserves the existing cipher so a non-key edit does
    // not wipe a saved key. Encrypt only when a new key is provided.
    const hasNewKey = typeof payload.apiKey === 'string' && payload.apiKey.trim() !== '';
    const cipher = hasNewKey ? encryptSecret(payload.apiKey.trim()) : null;

    const result = await query(
      `insert into endpoint_configs (
         model_group, base_url, model, auth_mode, max_tokens, timeout, delay,
         system_prompt, image_n, image_quality, image_size, api_key_cipher,
         updated_by, updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       on conflict (model_group) do update set
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
        group,
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
  }

  return sendMethodNotAllowed(res, ['GET', 'POST']);
};
