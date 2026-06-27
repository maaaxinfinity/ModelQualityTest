const { ensureSchema, transaction } = require('../_lib/db');
const { issueSession, verifyTotpWithCounter } = require('../_lib/auth');
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
  const user = await transaction(async (client) => {
    const found = await client.query('select * from app_users where display_name=$1 for update', [displayName]);
    const row = found.rows[0];
    if (!row) return null;
    const match = verifyTotpWithCounter(row.totp_secret, token);
    if (!match) return null;
    const lastCounter = row.last_totp_counter == null ? null : Number(row.last_totp_counter);
    if (lastCounter != null && match.counter <= lastCounter) return null;
    const updated = await client.query(
      `update app_users
          set last_login_at=now(), last_totp_counter=$2
        where id=$1
        returning id, display_name, role`,
      [row.id, match.counter]
    );
    return updated.rows[0] || null;
  });
  if (!user) return sendJson(res, 401, { error: 'login_invalid' });
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
