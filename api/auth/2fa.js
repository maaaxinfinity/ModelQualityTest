const { ensureSchema, query, transaction } = require('../_lib/db');
const {
  generateTotpSecret,
  otpauthUrl,
  randomId,
  requireUser,
  verifyTotpWithCounter
} = require('../_lib/auth');
const { readJson, sendJson, sendMethodNotAllowed } = require('../_lib/http');

async function startRotation(req, res, user) {
  const secret = generateTotpSecret();
  const id = randomId('rotate');
  await query('delete from auth_enrollments where user_id=$1 and mode=$2', [user.id, 'rotate']);
  await query(
    `insert into auth_enrollments (id, user_id, display_name, totp_secret, mode, expires_at)
     values ($1,$2,$3,$4,'rotate', now() + interval '10 minutes')`,
    [id, user.id, user.display_name, secret]
  );
  return sendJson(res, 200, {
    ok: true,
    enrollmentId: id,
    secret,
    otpauthUrl: otpauthUrl(user.display_name, secret),
    expiresInSeconds: 600
  });
}

async function confirmRotation(req, res, user, payload) {
  const enrollmentId = String(payload.enrollmentId || '').trim();
  const token = String(payload.token || '').trim();
  if (!enrollmentId || !token) return sendJson(res, 400, { error: 'enrollment_and_token_required' });
  const out = await transaction(async (client) => {
    const found = await client.query(
      `select * from auth_enrollments
        where id=$1 and user_id=$2 and mode='rotate' and expires_at > now()
        for update`,
      [enrollmentId, user.id]
    );
    const enrollment = found.rows[0];
    if (!enrollment) return { status: 404, body: { error: 'enrollment_not_found' } };
    const match = verifyTotpWithCounter(enrollment.totp_secret, token);
    if (!match) return { status: 401, body: { error: 'totp_invalid' } };
    const updated = await client.query(
      `update app_users
          set totp_secret=$2, last_totp_counter=$3
        where id=$1
        returning id, display_name, role, created_at, last_login_at`,
      [user.id, enrollment.totp_secret, match.counter]
    );
    await client.query('delete from auth_enrollments where id=$1', [enrollment.id]);
    return { status: 200, body: { ok: true, user: updated.rows[0] } };
  });
  if (out.status !== 200) return sendJson(res, out.status, out.body);
  const row = out.body.user;
  return sendJson(res, 200, {
    ok: true,
    user: {
      id: row.id,
      displayName: row.display_name,
      role: row.role,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at
    }
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST']);
  await ensureSchema();
  const user = await requireUser(req, res);
  if (!user) return;
  let payload;
  try {
    payload = await readJson(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'bad_json', detail: e.message });
  }
  const action = String(payload.action || 'start');
  if (action === 'start') return startRotation(req, res, user);
  if (action === 'confirm') return confirmRotation(req, res, user, payload);
  return sendJson(res, 400, { error: 'bad_action' });
};
