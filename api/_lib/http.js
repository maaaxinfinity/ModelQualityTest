function sendJson(res, status, data, headers) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(headers || {})) {
    res.setHeader(key, value);
  }
  res.end(JSON.stringify(data));
}

function sendMethodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  sendJson(res, 405, { error: 'method_not_allowed', allowed });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const item of header.split(';')) {
    const idx = item.indexOf('=');
    if (idx < 0) continue;
    const key = item.slice(0, idx).trim();
    const value = item.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function appendSetCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) {
    res.setHeader('Set-Cookie', cookie);
  } else if (Array.isArray(prev)) {
    res.setHeader('Set-Cookie', prev.concat(cookie));
  } else {
    res.setHeader('Set-Cookie', [prev, cookie]);
  }
}

function isProduction(req) {
  const host = req.headers.host || '';
  return process.env.NODE_ENV === 'production' || !/^localhost(:|$)|^127\.0\.0\.1(:|$)/.test(host);
}

function setSessionCookie(req, res, value, maxAgeSeconds) {
  const secure = isProduction(req) ? '; Secure' : '';
  appendSetCookie(
    res,
    `mqt_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`
  );
}

function clearSessionCookie(req, res) {
  const secure = isProduction(req) ? '; Secure' : '';
  appendSetCookie(res, `mqt_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

module.exports = {
  appendSetCookie,
  clearSessionCookie,
  parseCookies,
  readJson,
  sendJson,
  sendMethodNotAllowed,
  setSessionCookie
};
