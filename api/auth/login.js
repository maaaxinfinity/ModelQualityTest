const { ensureSchema, query } = require('../_lib/db');
const { issueSession, verifyTotp } = require('../_lib/auth');
const { readJson, sendJson, sendMethodNotAllowed } = require('../_lib/http');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST']);
  await ensureSchema();
  let payload;
  try {
    payload = await readJson(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'bad_json', detail: e.message });
  }
  const displayName = String(payload.displayName || '').trim();
  const token = String(payload.token || '').trim();
  if (!displayName || !token) return sendJson(res, 400, { error: 'display_name_and_token_required' });
  const found = await query('select * from app_users where display_name=$1', [displayName]);
  const user = found.rows[0];
  if (!user || !verifyTotp(user.totp_secret, token)) return sendJson(res, 401, { error: 'login_invalid' });
  await query('update app_users set last_login_at=now() where id=$1', [user.id]);
  issueSession(req, res, user);
  return sendJson(res, 200, {
    ok: true,
    user: {
      id: user.id,
      displayName: user.display_name,
      role: user.role
    }
  });
};
