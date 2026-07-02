const { ensureSchema, query } = require('../_lib/db');
const { sendJson, sendMethodNotAllowed } = require('../_lib/http');
const { syncPricesFromModelsDev } = require('../_lib/pricing');
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

// Combined daily sync. On the Hobby plan a deployment may hold at most 12
// serverless functions, so price sync and model-list sync share one endpoint
// instead of two crons. Each half is isolated: a failure in one never blocks
// the other.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return sendMethodNotAllowed(res, ['GET', 'POST']);
  if (!authorized(req)) return sendJson(res, 401, { error: 'cron_unauthorized' });
  await ensureSchema();

  let prices = null;
  let pricesError = null;
  try {
    prices = await syncPricesFromModelsDev();
  } catch (e) {
    pricesError = e.message;
  }

  // Best-effort: refresh every endpoint's model list; one failure never blocks others.
  let models = null;
  let modelsError = null;
  try {
    const rows = (await query('select * from endpoint_configs')).rows;
    const results = [];
    for (const row of rows) results.push(await syncEndpointModels(row));
    models = { endpoints: results.length, synced: results.filter((r) => r.ok).length, results };
  } catch (e) {
    modelsError = e.message;
  }

  return sendJson(res, 200, {
    ok: !pricesError && !modelsError,
    prices: pricesError ? { error: pricesError } : prices,
    models: modelsError ? { error: modelsError } : models
  });
};
