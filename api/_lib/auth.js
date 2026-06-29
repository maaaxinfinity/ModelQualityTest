const crypto = require('crypto');
const QRCode = require('qrcode-svg');
const qrbtf = require('simple-qrbtf');
const { parseCookies, sendJson, setSessionCookie } = require('./http');
const { ensureSchema, query } = require('./db');

const SESSION_TTL_SECONDS = 60 * 60 * 12;
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 8;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function appSecret() {
  const secret = process.env.SESSION_SECRET || process.env.AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET or AUTH_SECRET is required in production');
  }
  return secret || 'dev-only-change-me';
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function hmac(value) {
  return crypto.createHmac('sha256', appSecret()).update(value).digest('base64url');
}

function createSessionValue(user) {
  const payload = {
    uid: user.id,
    role: user.role,
    name: user.display_name,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${hmac(encoded)}`;
}

function verifySessionValue(value) {
  if (!value || !value.includes('.')) return null;
  const [encoded, sig] = value.split('.');
  const expected = hmac(encoded);
  if (!sig || sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function randomCode() {
  return crypto.randomBytes(9).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function generateTotpSecret() {
  const bytes = crypto.randomBytes(20);
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    out += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return out;
}

function decodeBase32(secret) {
  const clean = String(secret || '').replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = '';
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('bad base32 secret');
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpAt(secret, counter) {
  const key = decodeBase32(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  ) % (10 ** TOTP_DIGITS);
  return String(code).padStart(TOTP_DIGITS, '0');
}

function verifyTotpWithCounter(secret, token, windowSize) {
  const clean = String(token || '').replace(/\s+/g, '');
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(clean)) return null;
  const counter = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  const window = windowSize == null ? 1 : windowSize;
  for (let offset = -window; offset <= window; offset++) {
    const matchedCounter = counter + offset;
    const candidate = totpAt(secret, matchedCounter);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(clean))) {
      return { token: clean, counter: matchedCounter };
    }
  }
  return null;
}

function verifyTotp(secret, token, windowSize) {
  return !!verifyTotpWithCounter(secret, token, windowSize);
}

function otpauthUrl(displayName, secret) {
  const issuer = encodeURIComponent('ModelQualityTest');
  const label = encodeURIComponent(`ModelQualityTest:${displayName}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

// Standard fallback QR: qrcode-svg with an injected viewBox so it scales
// cleanly. Used if the styled qrbtf renderer ever throws.
function standardQrSvg(content) {
  const size = 224;
  const qr = new QRCode({ content, padding: 3, width: size, height: size, color: '#0d0d0d', background: '#ffffff', ecl: 'M' });
  return qr.svg()
    .replace(/^<\?xml[^>]*>\s*/i, '')
    .replace(
      /<svg([^>]*?)\swidth="\d+"\s+height="\d+"/i,
      `<svg$1 viewBox="0 0 ${size} ${size}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet"`
    );
}

// QRBTF "A1" dotted style with point interference (round modules + scattered
// dots). Artistic QRs survive scanning by leaning on a high error-correction
// level, and Google Authenticator needs high-contrast finder patterns — qrbtf
// renders those in light gray, so recolor every module + finder to near-black.
// ECL 'Q' (25% recovery) is used because at 'Q' the qrbtf matrix is provably
// identical to a standard encoder, so the encoding is correct.
function otpauthQrSvg(displayName, secret) {
  const content = otpauthUrl(displayName, secret);
  try {
    let svg = qrbtf.CircleQr({ text: content, correctLevel: 'Q' });
    if (typeof svg === 'string' && svg.includes('<svg')) {
      // gray finders (#999) + module fills/strokes (#000) → high-contrast near-black
      svg = svg.replace(/(['"])#(?:999|000(?:000)?)\1/gi, '$1#0d0d0d$1');
      return svg;
    }
    return standardQrSvg(content);
  } catch (e) {
    return standardQrSvg(content);
  }
}

async function getUserFromRequest(req) {
  await ensureSchema();
  const cookies = parseCookies(req);
  const payload = verifySessionValue(cookies.mqt_session);
  if (!payload) return null;
  const result = await query('select id, display_name, role, created_at, last_login_at from app_users where id=$1', [payload.uid]);
  return result.rows[0] || null;
}

async function requireUser(req, res) {
  const user = await getUserFromRequest(req);
  if (!user) {
    sendJson(res, 401, { error: 'auth_required' });
    return null;
  }
  return user;
}

async function requireAdmin(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    sendJson(res, 403, { error: 'admin_required' });
    return null;
  }
  return user;
}

function issueSession(req, res, user) {
  const value = createSessionValue(user);
  setSessionCookie(req, res, value, SESSION_TTL_SECONDS);
}

module.exports = {
  generateTotpSecret,
  getUserFromRequest,
  issueSession,
  otpauthUrl,
  otpauthQrSvg,
  randomCode,
  randomId,
  requireAdmin,
  requireUser,
  verifyTotp,
  verifyTotpWithCounter
};
