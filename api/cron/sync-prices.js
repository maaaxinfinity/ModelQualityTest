const { ensureSchema } = require('../_lib/db');
const { sendJson, sendMethodNotAllowed } = require('../_lib/http');
const { syncPricesFromModelsDev } = require('../_lib/pricing');

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
  const sync = await syncPricesFromModelsDev();
  return sendJson(res, 200, { ok: true, sync });
};
