const { ensureSchema, query } = require('../_lib/db');
const { randomCode, requireAdmin } = require('../_lib/auth');
const { readJson, sendJson, sendMethodNotAllowed } = require('../_lib/http');

module.exports = async function handler(req, res) {
  await ensureSchema();
  const user = await requireAdmin(req, res);
  if (!user) return;
  if (req.method === 'GET') {
    const result = await query(
      `select code, role, max_uses, used_count, expires_at, revoked_at, created_at
       from invite_codes order by created_at desc limit 100`
    );
    return sendJson(res, 200, { ok: true, invites: result.rows });
  }
  if (req.method === 'POST') {
    let payload;
    try {
      payload = await readJson(req);
    } catch (e) {
      return sendJson(res, 400, { error: 'bad_json', detail: e.message });
    }
    const maxUses = Math.max(1, Math.min(Number(payload.maxUses || 1), 100));
    const expiresHours = Math.max(1, Math.min(Number(payload.expiresHours || 168), 24 * 90));
    let code;
    for (let i = 0; i < 5; i++) {
      code = randomCode();
      try {
        await query(
          `insert into invite_codes (code, role, created_by, max_uses, expires_at)
           values ($1,'admin',$2,$3, now() + ($4 || ' hours')::interval)`,
          [code, user.id, maxUses, String(expiresHours)]
        );
        break;
      } catch (e) {
        if (!/duplicate/i.test(e.message) && e.code !== '23505') throw e;
      }
    }
    return sendJson(res, 200, { ok: true, code, maxUses, expiresHours });
  }
  return sendMethodNotAllowed(res, ['GET', 'POST']);
};
