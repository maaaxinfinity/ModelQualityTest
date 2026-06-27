const { ensureSchema, query } = require('../_lib/db');
const { getUserFromRequest } = require('../_lib/auth');
const { sendJson, sendMethodNotAllowed } = require('../_lib/http');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET']);
  try {
    await ensureSchema();
    const count = await query('select count(*)::int as n from app_users');
    const user = await getUserFromRequest(req);
    return sendJson(res, 200, {
      ok: true,
      setupRequired: count.rows[0].n === 0,
      user: user ? {
        id: user.id,
        displayName: user.display_name,
        role: user.role,
        createdAt: user.created_at,
        lastLoginAt: user.last_login_at
      } : null,
      insecureDevSecret: !(process.env.SESSION_SECRET || process.env.AUTH_SECRET),
      productionSecretRequired: process.env.NODE_ENV === 'production' &&
        !(process.env.SESSION_SECRET || process.env.AUTH_SECRET)
    });
  } catch (e) {
    return sendJson(res, 500, { error: 'status_failed', detail: e.message });
  }
};
