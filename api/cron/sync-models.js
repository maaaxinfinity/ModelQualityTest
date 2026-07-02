const { ensureSchema, query } = require('../_lib/db');
const { sendJson, sendMethodNotAllowed } = require('../_lib/http');
const { syncEndpointModels } = require('../admin/endpoints');

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return req.headers['x-vercel-cron'] === '1' ||
      String(req.headers['user-agent'] || '').toLowerCase().includes('vercel');
  }
  const auth = String(req.headers.authorization || '');
  return auth === `Bearer ${secret}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return sendMethodNotAllowed(res, ['GET', 'POST']);
  if (!authorized(req)) return sendJson(res, 401, { error: 'cron_unauthorized' });
  await ensureSchema();
  // Best-effort: refresh every endpoint's model list; one failure never blocks others.
  const rows = (await query('select * from endpoint_configs')).rows;
  const results = [];
  for (const row of rows) results.push(await syncEndpointModels(row));
  const synced = results.filter((r) => r.ok).length;
  return sendJson(res, 200, { ok: true, endpoints: results.length, synced, results });
};
