const { ensureSchema, query } = require('../_lib/db');
const {
  generateTotpSecret,
  issueSession,
  otpauthQrSvg,
  otpauthUrl,
  randomId,
  verifyTotpWithCounter
} = require('../_lib/auth');
const { readJson, sendJson, sendMethodNotAllowed } = require('../_lib/http');

async function userCount() {
  const result = await query('select count(*)::int as n from app_users');
  return result.rows[0].n;
}

async function validateInvite(code) {
  const result = await query(
    `select * from invite_codes
     where code=$1
       and revoked_at is null
       and used_count < max_uses
       and (expires_at is null or expires_at > now())`,
    [code]
  );
  return result.rows[0] || null;
}

async function startEnrollment(payload) {
  const displayName = String(payload.displayName || '').trim();
  if (!displayName) return { status: 400, body: { error: 'display_name_required' } };
  const existing = await query('select 1 from app_users where display_name=$1', [displayName]);
  if (existing.rows.length) return { status: 409, body: { error: 'display_name_taken' } };

  const count = await userCount();
  let mode = 'bootstrap';
  let invite = null;
  if (count > 0) {
    const inviteCode = String(payload.inviteCode || '').trim().toUpperCase();
    if (!inviteCode) return { status: 403, body: { error: 'invite_required' } };
    invite = await validateInvite(inviteCode);
    if (!invite) return { status: 403, body: { error: 'invite_invalid' } };
    mode = 'invite';
  }

  const secret = generateTotpSecret();
  const id = randomId('enroll');
  await query(
    `insert into auth_enrollments (id, display_name, totp_secret, invite_code, mode, expires_at)
     values ($1,$2,$3,$4,$5, now() + interval '10 minutes')`,
    [id, displayName, secret, invite ? invite.code : null, mode]
  );
  return {
    status: 200,
    body: {
      ok: true,
      enrollmentId: id,
      displayName,
      secret,
      otpauthUrl: otpauthUrl(displayName, secret),
      qrSvg: otpauthQrSvg(displayName, secret),
      mode,
      expiresInSeconds: 600
    }
  };
}

async function finishEnrollment(req, res, payload) {
  const enrollmentId = String(payload.enrollmentId || '').trim();
  const token = String(payload.token || '').trim();
  if (!enrollmentId || !token) return sendJson(res, 400, { error: 'enrollment_and_token_required' });
  const found = await query('select * from auth_enrollments where id=$1 and expires_at > now()', [enrollmentId]);
  const enrollment = found.rows[0];
  if (!enrollment) return sendJson(res, 404, { error: 'enrollment_not_found' });
  const match = verifyTotpWithCounter(enrollment.totp_secret, token);
  if (!match) return sendJson(res, 401, { error: 'totp_invalid' });

  const count = await userCount();
  if (enrollment.mode === 'bootstrap' && count > 0) return sendJson(res, 409, { error: 'bootstrap_already_claimed' });
  let createdBy = null;
  if (enrollment.mode === 'invite') {
    const invite = await validateInvite(enrollment.invite_code);
    if (!invite) return sendJson(res, 403, { error: 'invite_invalid' });
    createdBy = invite.created_by;
  }

  const userId = randomId('usr');
  const inserted = await query(
    `insert into app_users (id, display_name, role, totp_secret, last_totp_counter, created_by, last_login_at)
     values ($1,$2,'admin',$3,$4,$5,now())
     returning id, display_name, role, created_at, last_login_at`,
    [userId, enrollment.display_name, enrollment.totp_secret, match.counter, createdBy]
  );
  if (enrollment.invite_code) {
    await query('update invite_codes set used_count=used_count+1 where code=$1', [enrollment.invite_code]);
  }
  await query('delete from auth_enrollments where id=$1', [enrollmentId]);
  const user = inserted.rows[0];
  issueSession(req, res, user);
  return sendJson(res, 200, {
    ok: true,
    user: {
      id: user.id,
      displayName: user.display_name,
      role: user.role,
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at
    }
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST']);
  await ensureSchema();
  let payload;
  try {
    payload = await readJson(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'bad_json', detail: e.message });
  }
  if (payload.enrollmentId) return finishEnrollment(req, res, payload);
  const out = await startEnrollment(payload);
  return sendJson(res, out.status, out.body);
};
