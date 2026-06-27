const { ensureSchema, query } = require('../_lib/db');
const { requireAdmin } = require('../_lib/auth');
const { sendJson, sendMethodNotAllowed } = require('../_lib/http');
const { latestPriceSync, syncPricesFromModelsDev } = require('../_lib/pricing');

async function priceSummary() {
  const latest = await latestPriceSync();
  const groups = await query(
    `select model_group, source_provider, count(*)::int as rows, max(synced_at) as synced_at
     from model_prices
     group by model_group, source_provider
     order by model_group, source_provider`
  );
  return { latest, groups: groups.rows };
}

module.exports = async function handler(req, res) {
  await ensureSchema();
  const user = await requireAdmin(req, res);
  if (!user) return;
  if (req.method === 'GET') {
    return sendJson(res, 200, { ok: true, pricing: await priceSummary() });
  }
  if (req.method === 'POST') {
    const sync = await syncPricesFromModelsDev();
    return sendJson(res, 200, { ok: true, sync, pricing: await priceSummary() });
  }
  return sendMethodNotAllowed(res, ['GET', 'POST']);
};
