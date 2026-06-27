const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'smoke-test-session-secret';

const { ensureSchema, query } = require('../api/_lib/db');
const { issueSession } = require('../api/_lib/auth');

function makeReq(body, cookie) {
  const raw = JSON.stringify(body || {});
  const req = Readable.from([raw]);
  req.method = 'POST';
  req.url = '/api/run-test';
  req.headers = {
    host: 'localhost',
    cookie,
    'content-type': 'application/json'
  };
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

function sessionCookie(user) {
  const res = makeRes();
  issueSession({ headers: { host: 'localhost' } }, res, user);
  const raw = res.getHeader('Set-Cookie');
  return (Array.isArray(raw) ? raw[0] : raw).split(';')[0];
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await ensureSchema();
  await query('truncate table test_runs, model_prices, auth_enrollments, invite_codes, app_users cascade');
  await query(
    `insert into app_users (id, display_name, role, totp_secret)
     values ('usr_run_smoke','run-smoke-admin','admin','JBSWY3DPEHPK3PXP')`
  );
  await query(
    `insert into model_prices (model_group, source_provider, model_id, model_alias, model_name, cost_json)
     values ('OpenAI','openai','gpt-5.5','gpt-5.5','GPT-5.5',$1::jsonb)`,
    [JSON.stringify({ input: 5, output: 30 })]
  );

  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-5.5');
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map([['content-type', 'application/json'], ['x-request-id', 'req_smoke']]),
      async text() {
        return JSON.stringify({
          id: 'resp_smoke',
          model: 'gpt-5.5',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 1000, output_tokens: 1000, total_tokens: 2000 }
        });
      }
    };
  };

  try {
    const handler = require('../api/run-test');
    const res = makeRes();
    await handler(makeReq({
      question: {
        id: 'oai-smoke',
        name: 'OpenAI smoke',
        group: 'OpenAI',
        provider: 'openai',
        user: 'hi',
        max_tokens: 64
      },
      cfg: {
        group: 'OpenAI',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com',
        model: 'gpt-5.5',
        authMode: 'bearer',
        maxTokens: 64,
        timeout: 5000
      },
      batchId: 'batch_run_smoke'
    }, sessionCookie({ id: 'usr_run_smoke', role: 'admin', display_name: 'run-smoke-admin' })), res);

    assert.equal(res.statusCode, 200, res.body);
    const json = res.json();
    assert.equal(json.ok, true);
    assert.equal(json.result.estimated_cost_usd, 0.035);
    assert.equal(json.result.cost_source, 'price_table:openai/gpt-5.5');

    const logged = await query('select * from test_runs where question_id=$1', ['oai-smoke']);
    assert.equal(logged.rows.length, 1);
    assert.equal(logged.rows[0].estimated_cost_usd, 0.035);
    assert.equal(logged.rows[0].cost_source, 'price_table:openai/gpt-5.5');
    assert.equal(logged.rows[0].response_headers['x-request-id'], 'req_smoke');
    console.log(JSON.stringify({ ok: true, run: logged.rows[0].id, cost: logged.rows[0].estimated_cost_usd }));
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
