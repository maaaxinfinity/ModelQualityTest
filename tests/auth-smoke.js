const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'smoke-test-session-secret';

const { ensureSchema, query } = require('../api/_lib/db');
const enroll = require('../api/auth/enroll');
const twofa = require('../api/auth/2fa');
const login = require('../api/auth/login');
const invites = require('../api/admin/invites');
const system = require('../api/admin/system');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(secret) {
  const clean = String(secret || '').replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = '';
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('bad base32 secret');
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret, offset = 0) {
  const counter = Math.floor(Date.now() / 1000 / 30) + offset;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(msg).digest();
  const truncationOffset = digest[digest.length - 1] & 0x0f;
  const code = (
    ((digest[truncationOffset] & 0x7f) << 24) |
    ((digest[truncationOffset + 1] & 0xff) << 16) |
    ((digest[truncationOffset + 2] & 0xff) << 8) |
    (digest[truncationOffset + 3] & 0xff)
  ) % 100000000;
  return String(code).padStart(8, '0');
}

function makeReq(method, body, cookie) {
  const raw = body == null ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [raw] : []);
  req.method = method;
  req.url = '/';
  req.headers = { host: 'localhost' };
  if (cookie) req.headers.cookie = cookie;
  return req;
}

function makeRes() {
  const headers = {};
  return {
    statusCode: 200,
    body: '',
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
    end(value) { this.body += value || ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
    headers
  };
}

async function call(handler, method, body, cookie) {
  const req = makeReq(method, body, cookie);
  const res = makeRes();
  await handler(req, res);
  return res;
}

function cookieFrom(res) {
  const setCookie = res.getHeader('Set-Cookie');
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return first ? first.split(';')[0] : '';
}

async function enrollUser(displayName, inviteCode) {
  const start = await call(enroll, 'POST', { displayName, inviteCode });
  assert.equal(start.statusCode, 200, start.body);
  const started = start.json();
  assert(started.secret);
  assert(started.otpauthUrl.startsWith('otpauth://totp/'));
  assert.match(started.otpauthUrl, /digits=8/);

  const enrollmentToken = totp(started.secret);
  const finish = await call(enroll, 'POST', {
    enrollmentId: started.enrollmentId,
    token: enrollmentToken
  });
  assert.equal(finish.statusCode, 200, finish.body);
  return { body: finish.json(), cookie: cookieFrom(finish), secret: started.secret, enrollmentToken };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await ensureSchema();
  await query('truncate table test_runs, model_prices, auth_enrollments, invite_codes, app_users cascade');

  const admin = await enrollUser('admin-smoke');
  assert.equal(admin.body.user.role, 'admin');
  assert(admin.cookie.startsWith('mqt_session='));

  const inviteRes = await call(invites, 'POST', { maxUses: 1, expiresHours: 1 }, admin.cookie);
  assert.equal(inviteRes.statusCode, 200, inviteRes.body);
  const invite = inviteRes.json();
  assert.match(invite.code, /^[A-Z0-9]+$/);

  const second = await enrollUser('second-admin-smoke', invite.code);
  assert.equal(second.body.user.role, 'admin');

  const userRow = await query('select count(*)::int as n from app_users');
  const inviteRow = await query('select used_count from invite_codes where code=$1', [invite.code]);
  assert.equal(userRow.rows[0].n, 2);
  assert.equal(inviteRow.rows[0].used_count, 1);

  const secondSecret = (await query('select totp_secret from app_users where display_name=$1', ['second-admin-smoke'])).rows[0].totp_secret;
  const replayRes = await call(login, 'POST', {
    displayName: 'second-admin-smoke',
    token: second.enrollmentToken
  });
  assert.equal(replayRes.statusCode, 401, replayRes.body);

  const loginRes = await call(login, 'POST', {
    displayName: 'second-admin-smoke',
    token: totp(secondSecret, 1)
  });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  assert(cookieFrom(loginRes).startsWith('mqt_session='));

  const rotateStart = await call(twofa, 'POST', { action: 'start' }, second.cookie);
  assert.equal(rotateStart.statusCode, 200, rotateStart.body);
  const rotateSetup = rotateStart.json();
  assert(rotateSetup.secret);
  assert(rotateSetup.otpauthUrl.startsWith('otpauth://totp/'));
  const rotateConfirm = await call(twofa, 'POST', {
    action: 'confirm',
    enrollmentId: rotateSetup.enrollmentId,
    token: totp(rotateSetup.secret)
  }, second.cookie);
  assert.equal(rotateConfirm.statusCode, 200, rotateConfirm.body);

  const oldSecretLogin = await call(login, 'POST', {
    displayName: 'second-admin-smoke',
    token: totp(secondSecret, 1)
  });
  assert.equal(oldSecretLogin.statusCode, 401, oldSecretLogin.body);

  const newSecretLogin = await call(login, 'POST', {
    displayName: 'second-admin-smoke',
    token: totp(rotateSetup.secret, 1)
  });
  assert.equal(newSecretLogin.statusCode, 200, newSecretLogin.body);

  const systemRes = await call(system, 'GET', null, admin.cookie);
  assert.equal(systemRes.statusCode, 200, systemRes.body);
  const systemJson = systemRes.json();
  assert.equal(systemJson.env.databaseUrl, true);
  assert.equal(systemJson.database.users, 2);

  console.log(JSON.stringify({ ok: true, users: userRow.rows[0].n, invite: invite.code }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
