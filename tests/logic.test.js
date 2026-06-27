const assert = require('node:assert/strict');

global.window = global;
require('../questions.js');

const { buildUpstreamRequest } = require('../api/_lib/providers');
const { extractAllowedRows } = require('../api/_lib/pricing');
const { issueSession } = require('../api/_lib/auth');

function fakeModelsDev() {
  return {
    openai: {
      models: {
        'gpt-5.5': { name: 'GPT-5.5', cost: { input: 5, output: 30 } },
        'gpt-image-2': { name: 'GPT Image 2', cost: { input: 5, output: 30 } },
        'not-related-image-router': { name: 'Nope', cost: { input: 1, output: 1 } }
      }
    },
    anthropic: {
      models: {
        'claude-opus-4.8': { name: 'Claude Opus 4.8', cost: { input: 5, output: 25 } }
      }
    },
    google: {
      models: {
        'gemini-3.1-pro-preview': { name: 'Gemini 3.1 Pro', cost: { input: 2, output: 12 } }
      }
    },
    'google-vertex': {
      models: {
        'gemini-3-flash-preview': { name: 'Gemini 3 Flash', cost: { input: 0.5, output: 3 } }
      }
    },
    vercel: {
      models: {
        'sakana/fugu-ultra': { name: 'Fugu Ultra', cost: { input: 5, output: 30 } },
        'openai/gpt-5.5': { name: 'Should not sync', cost: { input: 5, output: 30 } }
      }
    },
    openrouter: {
      models: {
        'sakana/fugu-ultra': { name: 'Should not sync', cost: { input: 5, output: 30 } },
        'anthropic/claude-opus-4.8': { name: 'Should not sync', cost: { input: 5, output: 25 } }
      }
    }
  };
}

function cfgFor(group) {
  return {
    group,
    apiKey: 'test',
    baseUrl: {
      OpenAI: 'https://api.openai.com',
      Anthropic: 'https://api.anthropic.com',
      Google: 'https://generativelanguage.googleapis.com',
      Sakana: 'https://api.sakana.ai',
      Image: 'https://api.openai.com'
    }[group],
    model: {
      OpenAI: 'gpt-5.5',
      Anthropic: 'claude-opus-4.8',
      Google: 'gemini-3.1-pro-preview',
      Sakana: 'fugu-ultra',
      Image: 'gpt-image-2'
    }[group],
    authMode: group === 'Anthropic' ? 'x-api-key' : 'bearer',
    maxTokens: 256,
    image: { n: 1, quality: 'medium', size: '1024x1024' }
  };
}

const counts = QUESTIONS.reduce((acc, q) => {
  acc[q.group] = (acc[q.group] || 0) + 1;
  return acc;
}, {});
assert.deepEqual(Object.keys(counts).sort(), ['Anthropic', 'Google', 'Image', 'OpenAI', 'Sakana']);
assert.equal(counts.OpenAI, 4);
assert.equal(counts.Anthropic, 25);
assert.equal(counts.Google, 4);
assert.equal(counts.Sakana, 4);
assert.equal(counts.Image, 5);

const endpointTypes = {};
for (const group of Object.keys(counts)) {
  const q = QUESTIONS.find((item) => item.group === group);
  endpointTypes[group] = buildUpstreamRequest(q, cfgFor(group)).endpointType;
}
assert.deepEqual(endpointTypes, {
  OpenAI: 'openai_responses',
  Anthropic: 'anthropic_messages',
  Google: 'google_generate_content',
  Sakana: 'sakana_responses',
  Image: 'openai_images'
});

assert(QUESTIONS.filter((q) => q.group === 'OpenAI').every((q) => {
  return buildUpstreamRequest(q, cfgFor('OpenAI')).endpointType === 'openai_responses';
}));

const imageN2 = QUESTIONS.find((q) => q.id === 'image-n-2');
const imageRequest = buildUpstreamRequest(imageN2, cfgFor('Image'));
assert.equal(imageRequest.endpoint, 'https://api.openai.com/v1/images/generations');
assert.equal(imageRequest.body.model, 'gpt-image-2');
assert.equal(imageRequest.body.n, 2);
assert.equal(imageRequest.body.quality, 'medium');
assert.equal(imageRequest.body.size, '1024x1024');
assert.deepEqual(QUESTIONS.find((q) => q.id === 'image-load-burst').load, { requests: 5, concurrency: 2 });

const sakanaRequest = buildUpstreamRequest(QUESTIONS.find((q) => q.id === 'sakana-fugu-basic'), cfgFor('Sakana'));
assert.equal(sakanaRequest.endpoint, 'https://api.sakana.ai/v1/responses');
assert.equal(sakanaRequest.body.model, 'fugu-ultra');
assert.equal(sakanaRequest.endpointType, 'sakana_responses');

const rows = extractAllowedRows(fakeModelsDev());
const key = (row) => `${row.model_group}:${row.source_provider}:${row.model_id}`;
assert(rows.some((row) => key(row) === 'OpenAI:openai:gpt-5.5'));
assert(rows.some((row) => key(row) === 'Image:openai:gpt-image-2'));
assert(rows.some((row) => key(row) === 'Anthropic:anthropic:claude-opus-4.8'));
assert(rows.some((row) => key(row) === 'Google:google:gemini-3.1-pro-preview'));
assert(rows.some((row) => key(row) === 'Google:google-vertex:gemini-3-flash-preview'));
assert(rows.some((row) => key(row) === 'Sakana:vercel:sakana/fugu-ultra'));
assert(!rows.some((row) => row.source_provider === 'openrouter'));
assert(!rows.some((row) => row.source_provider === 'vercel' && row.model_group !== 'Sakana'));

const oldNodeEnv = process.env.NODE_ENV;
const oldSessionSecret = process.env.SESSION_SECRET;
const oldAuthSecret = process.env.AUTH_SECRET;
delete process.env.SESSION_SECRET;
delete process.env.AUTH_SECRET;
process.env.NODE_ENV = 'production';
assert.throws(() => {
  issueSession({ headers: { host: 'example.com' } }, { setHeader() {}, getHeader() {} }, {
    id: 'usr_test',
    role: 'admin',
    display_name: 'admin'
  });
}, /SESSION_SECRET/);
process.env.NODE_ENV = oldNodeEnv;
if (oldSessionSecret === undefined) delete process.env.SESSION_SECRET;
else process.env.SESSION_SECRET = oldSessionSecret;
if (oldAuthSecret === undefined) delete process.env.AUTH_SECRET;
else process.env.AUTH_SECRET = oldAuthSecret;

console.log('logic tests ok');
