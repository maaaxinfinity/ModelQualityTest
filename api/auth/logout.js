const { clearSessionCookie, sendJson, sendMethodNotAllowed } = require('../_lib/http');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST']);
  clearSessionCookie(req, res);
  return sendJson(res, 200, { ok: true });
};
