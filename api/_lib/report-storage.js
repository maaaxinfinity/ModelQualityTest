const {
  getDownloadUrl,
  issueSignedToken,
  presignUrl,
  put
} = require('@vercel/blob');

const REPORT_URL_TTL_MS = 24 * 60 * 60 * 1000;

function safeFilename(value) {
  const name = String(value || 'image-quality-report.pdf').replace(/[^a-zA-Z0-9._-]+/g, '-');
  return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
}

async function storeImageReport(pdf, filename, client = { getDownloadUrl, issueSignedToken, presignUrl, put }) {
  if (!Buffer.isBuffer(pdf) || !pdf.length) throw new Error('Image report PDF is empty');
  const safeName = safeFilename(filename);
  const stored = await client.put(`image-reports/${safeName}`, pdf, {
    access: 'private',
    addRandomSuffix: true,
    contentType: 'application/pdf',
    multipart: true
  });
  const expiresAt = Date.now() + REPORT_URL_TTL_MS;
  const signedToken = await client.issueSignedToken({
    pathname: stored.pathname,
    operations: ['get'],
    validUntil: expiresAt
  });
  const signed = await client.presignUrl(signedToken, {
    access: 'private',
    operation: 'get',
    pathname: stored.pathname,
    validUntil: expiresAt
  });
  return {
    pathname: stored.pathname,
    url: client.getDownloadUrl(signed.presignedUrl),
    expires_at: new Date(expiresAt).toISOString(),
    filename: safeName,
    size: pdf.length
  };
}

module.exports = { REPORT_URL_TTL_MS, safeFilename, storeImageReport };
