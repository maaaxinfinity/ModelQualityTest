const { ensureSchema, query } = require('../_lib/db');
const { requireAdmin } = require('../_lib/auth');
const { sendJson, sendMethodNotAllowed } = require('../_lib/http');
const { latestPriceSync } = require('../_lib/pricing');

async function countTable(table) {
  const result = await query(`select count(*)::int as n from ${table}`);
  return result.rows[0].n;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET']);
  await ensureSchema();
  const user = await requireAdmin(req, res);
  if (!user) return;

  const [priceSync, priceGroups, runGroups] = await Promise.all([
    latestPriceSync(),
    query(
      `select model_group, source_provider, count(*)::int as rows, max(synced_at) as last_synced_at
       from model_prices
       group by model_group, source_provider
       order by model_group, source_provider`
    ),
    query(
      `select model_group, count(*)::int as runs, max(created_at) as last_run_at
       from test_runs
       group by model_group
       order by model_group`
    )
  ]);

  const [users, invites, runs] = await Promise.all([
    countTable('app_users'),
    countTable('invite_codes'),
    countTable('test_runs')
  ]);

  return sendJson(res, 200, {
    ok: true,
    env: {
      databaseUrl: !!process.env.DATABASE_URL,
      sessionSecret: !!(process.env.SESSION_SECRET || process.env.AUTH_SECRET),
      cronSecret: !!process.env.CRON_SECRET,
      nodeEnv: process.env.NODE_ENV || 'development'
    },
    database: {
      users,
      invites,
      runs,
      priceRows: priceSync.row_count,
      lastPriceSyncAt: priceSync.last_synced_at
    },
    priceGroups: priceGroups.rows,
    runGroups: runGroups.rows
  });
};
