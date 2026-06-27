const { ensureSchema, query } = require('../_lib/db');
const { requireAdmin } = require('../_lib/auth');
const { sendJson, sendMethodNotAllowed } = require('../_lib/http');

function csvCell(value) {
  if (value == null) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return `"${s.replace(/"/g, '""')}"`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET']);
  await ensureSchema();
  const user = await requireAdmin(req, res);
  if (!user) return;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), 1000));
  const group = url.searchParams.get('group');
  const format = url.searchParams.get('format') || 'json';
  const params = [];
  let where = '';
  if (group) {
    params.push(group);
    where = `where model_group=$${params.length}`;
  }
  params.push(limit);
  const result = await query(
    `select tr.*, u.display_name as user_name
     from test_runs tr
     left join app_users u on u.id = tr.user_id
     ${where}
     order by tr.created_at desc
     limit $${params.length}`,
    params
  );
  if (format === 'csv') {
    const headers = [
      'created_at', 'user_name', 'model_group', 'provider', 'model_id', 'routed_model_id',
      'question_id', 'endpoint_type', 'ok', 'response_status', 'elapsed_ms',
      'estimated_cost_usd', 'cost_source', 'error_message'
    ];
    const lines = [headers.join(',')];
    for (const row of result.rows) {
      lines.push(headers.map((h) => csvCell(row[h])).join(','));
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="model-quality-logs-${Date.now()}.csv"`);
    return res.end(lines.join('\n'));
  }
  return sendJson(res, 200, { ok: true, logs: result.rows });
};
