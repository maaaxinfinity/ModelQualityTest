const crypto = require('crypto');

// AES-256-GCM at-rest encryption for endpoint secrets (API keys). The key is
// derived from the same app secret that signs sessions, so rotating
// SESSION_SECRET invalidates stored ciphers (they must be re-entered) — the
// same trade-off the session cookies already make.
const VERSION = 'v1';
const SALT = 'mqt.endpoint.v1';

function appSecret() {
  const secret = process.env.SESSION_SECRET || process.env.AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET or AUTH_SECRET is required in production');
  }
  return secret || 'dev-only-change-me';
}

let cachedKey;
function deriveKey() {
  if (!cachedKey) cachedKey = crypto.scryptSync(appSecret(), SALT, 32);
  return cachedKey;
}

// Returns null for empty input so callers can store SQL NULL.
function encryptSecret(plaintext) {
  const text = plaintext == null ? '' : String(plaintext);
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64url')}:${tag.toString('base64url')}:${enc.toString('base64url')}`;
}

// Returns '' for null/malformed/undecryptable input — never throws, so a key
// stored under an old SESSION_SECRET degrades to "no key" rather than a 500.
function decryptSecret(stored) {
  if (!stored || typeof stored !== 'string') return '';
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return '';
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const data = Buffer.from(parts[3], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

module.exports = { encryptSecret, decryptSecret };
