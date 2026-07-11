const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
require('../questions.js');

const {
  buildUpstreamRequest,
  buildModelsRequest,
  extractImageArtifacts,
  extractModelIds,
  parseImageDimensions,
  sanitizePayload,
  summarizeImageProbe
} = require('../api/_lib/providers');
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
assert.equal(counts.Image, 33);
assert.deepEqual(
  [...new Set(QUESTIONS.filter((q) => q.group === 'Image').map((q) => q.category))],
  ['回图能力', 'Edit 多图输入', 'Quality × Size 矩阵', 'n 多图与耗时']
);
assert(QUESTIONS.filter((q) => q.group === 'Image').every((q) => q.model == null));

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
assert.equal(imageRequest.body.quality, 'low');
assert.equal(imageRequest.body.size, '1024x1024');
assert.equal(imageRequest.body.response_format, 'url');

const imageReturnB64 = QUESTIONS.find((q) => q.id === 'image-return-b64');
const imageReturnUrl = QUESTIONS.find((q) => q.id === 'image-return-url');
assert.equal(buildUpstreamRequest(imageReturnB64, cfgFor('Image')).body.response_format, 'b64_json');
assert.equal(buildUpstreamRequest(imageReturnUrl, cfgFor('Image')).body.response_format, 'url');

const editQuestions = QUESTIONS.filter((q) => q.category === 'Edit 多图输入');
assert.deepEqual(editQuestions.map((q) => q.edit_inputs.length), [1, 2, 4, 8]);
assert(editQuestions.every((q) =>
  q.endpoint_type === 'openai_image_edits' && q.image.n === 1 &&
  q.image.quality === 'low' && q.image.size === '1024x1024' && q.image.response_format === 'url'
));
for (const q of editQuestions) {
  const request = buildUpstreamRequest(q, cfgFor('Image'));
  assert.equal(request.endpoint, 'https://api.openai.com/v1/images/edits');
  assert.equal(request.endpointType, 'openai_image_edits');
  assert.equal(request.body.model, 'gpt-image-2');
  assert.equal(request.body.input_image_count, q.edit_inputs.length);
  assert.equal(request.body.input_images.length, q.edit_inputs.length);
  assert.equal(request.body.input_fidelity, undefined);
  assert.equal(request.headers['Content-Type'], undefined, 'multipart boundary must be set by fetch');
  const entries = [...request.formData.entries()];
  assert.equal(entries.filter(([key]) => key === 'image[]').length, q.edit_inputs.length);
  assert(entries.filter(([key]) => key === 'image[]').every(([, file]) => file instanceof Blob && file.size > 0));
}
const versionedImageCfg = Object.assign(cfgFor('Image'), { model: 'gpt-image-2-2026-04-21' });
const versionedEditRequest = buildUpstreamRequest(editQuestions[1], versionedImageCfg);
assert.equal(versionedEditRequest.body.model, 'gpt-image-2-2026-04-21', 'Edit must inherit the selected image model');

const matrixQuestions = QUESTIONS.filter((q) => q.category === 'Quality × Size 矩阵');
const expectedImageSizes = [
  '1024x1024', '1536x1024', '1024x1536', '2048x2048',
  '2048x1152', '3840x2160', '2160x3840', 'auto'
];
assert.equal(matrixQuestions.length, 24);
assert.deepEqual([...new Set(matrixQuestions.map((q) => q.image.quality))], ['low', 'medium', 'high']);
assert.deepEqual([...new Set(matrixQuestions.map((q) => q.image.size))], expectedImageSizes);
assert.deepEqual(
  matrixQuestions.map((q) => `${q.image.quality}:${q.image.size}`),
  ['low', 'medium', 'high'].flatMap((quality) => expectedImageSizes.map((size) => `${quality}:${size}`))
);
assert(matrixQuestions.every((q) => q.image.n === 1 && q.image.response_format === 'url'));
assert(matrixQuestions.every((q) => q.validate && q.validate.size === true));

const nQuestions = QUESTIONS.filter((q) => q.category === 'n 多图与耗时');
assert.deepEqual(nQuestions.map((q) => q.image.n), [2, 4, 8]);
assert(nQuestions.every((q) =>
  q.image.quality === 'low' && q.image.size === '1024x1024' && q.image.response_format === 'url'
));

const b64 = 'A'.repeat(200);
const extractedB64 = extractImageArtifacts({ data: [{ b64_json: b64 }] }, { output_format: 'png' });
assert.equal(extractedB64.length, 1);
assert.equal(extractedB64[0].response_format, 'b64_json');
assert(extractedB64[0].src.startsWith('data:image/png;base64,'));
assert.equal(extractedB64[0].base64_chars, 200);
const extractedUrl = extractImageArtifacts({ data: [{ url: 'https://images.example.test/1.png' }] }, {});
assert.deepEqual(extractedUrl.map((item) => item.response_format), ['url']);
assert.equal(extractedUrl[0].src, 'https://images.example.test/1.png');
assert.equal(sanitizePayload({ data: [{ b64_json: b64 }] }).data[0].b64_json, '[base64 omitted, 200 chars]');
const urlProbe = summarizeImageProbe(extractedUrl, {
  n: 1,
  quality: 'low',
  size: '1024x1024',
  response_format: 'url'
}, 1200);
assert.equal(urlProbe.error, null);
assert.equal(urlProbe.probe.ms_per_image, 1200);
const badProbe = summarizeImageProbe(extractedUrl, { n: 2, response_format: 'b64_json' }, 1200);
assert.match(badProbe.error, /expected 2 image/);
assert.match(badProbe.error, /expected response_format=b64_json/);

const fixtureDimensions = parseImageDimensions(fs.readFileSync(path.join(__dirname, '..', 'assets', 'image-edit', 'scene-b.png')));
assert.deepEqual(fixtureDimensions, { width: 1024, height: 1024, mime_type: 'image/png' });
const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x11, 0x00]);
assert.deepEqual(parseImageDimensions(jpegHeader), { width: 3, height: 2, mime_type: 'image/jpeg' });
const webpHeader = Buffer.alloc(30);
webpHeader.write('RIFF', 0, 'ascii');
webpHeader.writeUInt32LE(22, 4);
webpHeader.write('WEBP', 8, 'ascii');
webpHeader.write('VP8X', 12, 'ascii');
webpHeader.writeUInt32LE(10, 16);
webpHeader.writeUIntLE(639, 24, 3);
webpHeader.writeUIntLE(479, 27, 3);
assert.deepEqual(parseImageDimensions(webpHeader), { width: 640, height: 480, mime_type: 'image/webp' });
const sizedImage = [{ response_format: 'url', src: 'https://images.example.test/1.png', width: 1536, height: 1024 }];
const exactSizeProbe = summarizeImageProbe(sizedImage, {
  n: 1,
  size: '1536x1024',
  response_format: 'url'
}, 900, { validateSize: true, dimensionProbeMs: 80 });
assert.equal(exactSizeProbe.error, null);
assert.equal(exactSizeProbe.probe.size_ok, true);
assert.deepEqual(exactSizeProbe.probe.actual_sizes, ['1536x1024']);
assert.equal(exactSizeProbe.probe.dimension_probe_ms, 80);
const wrongSizeProbe = summarizeImageProbe(sizedImage, {
  n: 1,
  size: '1024x1024',
  response_format: 'url'
}, 900, { validateSize: true });
assert.equal(wrongSizeProbe.probe.size_ok, false);
assert.match(wrongSizeProbe.error, /expected size=1024x1024, received 1536x1024/);
const autoSizeProbe = summarizeImageProbe(sizedImage, {
  n: 1,
  size: 'auto',
  response_format: 'url'
}, 900, { validateSize: true });
assert.equal(autoSizeProbe.probe.size_ok, true);

const sakanaRequest = buildUpstreamRequest(QUESTIONS.find((q) => q.id === 'sakana-fugu-basic'), cfgFor('Sakana'));
assert.equal(sakanaRequest.endpoint, 'https://api.sakana.ai/v1/responses');
assert.equal(sakanaRequest.body.model, 'fugu-ultra');
assert.equal(sakanaRequest.endpointType, 'sakana_responses');

// Sakana/Fugu only accepts reasoning.effort in ('high','xhigh','max'); 'medium' from
// the Responses spec must be clamped up, while OpenAI keeps the original value.
const sakanaReasoningReq = buildUpstreamRequest(QUESTIONS.find((q) => q.id === 'sakana-route-anthropic-thinking'), cfgFor('Sakana'));
assert.equal(sakanaReasoningReq.body.reasoning.effort, 'high', 'Sakana medium effort must clamp to high');
const oaiReasoningReq = buildUpstreamRequest(QUESTIONS.find((q) => q.id === 'oai-reasoning-effort'), cfgFor('OpenAI'));
assert.equal(oaiReasoningReq.body.reasoning.effort, 'medium', 'OpenAI effort must pass through unchanged');

// Streaming: every text provider streams (body.stream + request.stream); Image does not.
const oaiReq = buildUpstreamRequest(QUESTIONS.find((q) => q.group === 'OpenAI'), cfgFor('OpenAI'));
const antReq = buildUpstreamRequest(QUESTIONS.find((q) => q.group === 'Anthropic' && !/count_tokens/.test(q.endpoint_path || '')), cfgFor('Anthropic'));
const gReq = buildUpstreamRequest(QUESTIONS.find((q) => q.group === 'Google'), cfgFor('Google'));
// OpenAI/Anthropic/Sakana carry stream in the body; Google signals it via the URL verb.
for (const req of [oaiReq, antReq, sakanaRequest]) {
  assert.equal(req.body.stream, true, `${req.endpointType} body.stream must be true`);
}
for (const req of [oaiReq, antReq, gReq, sakanaRequest]) {
  assert.equal(req.stream, true, `${req.endpointType} request.stream must be true`);
}
assert.ok(gReq.endpoint.endsWith(':streamGenerateContent?alt=sse'), 'Google must use streamGenerateContent SSE');
assert.equal(antReq.headers['User-Agent'], 'claude-cli/2.1.198 (external, cli)');
assert.equal(imageRequest.body.stream, undefined, 'Image must not stream');
assert.notEqual(imageRequest.stream, true);

// Model-list detection: request shape per provider + response normalization.
const oaiModels = buildModelsRequest('OpenAI', { apiKey: 'sk-x', baseUrl: 'https://proxy.example.com' });
assert.equal(oaiModels.endpoint, 'https://proxy.example.com/v1/models');
assert.equal(oaiModels.method, 'GET');
assert.equal(oaiModels.headers.Authorization, 'Bearer sk-x');

const antModels = buildModelsRequest('Anthropic', { apiKey: 'sk-a' });
assert.equal(antModels.endpoint, 'https://api.anthropic.com/v1/models');
assert.equal(antModels.headers['x-api-key'], 'sk-a');
assert.equal(antModels.headers['anthropic-version'], '2023-06-01');

const gModels = buildModelsRequest('Google', { apiKey: 'sk-g' });
assert.equal(gModels.endpoint, 'https://generativelanguage.googleapis.com/v1beta/models');
assert.equal(gModels.headers['x-goog-api-key'], 'sk-g');

assert.throws(() => buildModelsRequest('OpenAI', { baseUrl: 'https://x' }), /apiKey/);

assert.deepEqual(extractModelIds('OpenAI', { data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'gpt-a' }] }), ['gpt-a', 'gpt-b']);
assert.deepEqual(extractModelIds('Anthropic', { data: [{ id: 'claude-2' }] }), ['claude-2']);
assert.deepEqual(extractModelIds('Google', { models: [{ name: 'models/gemini-3' }, { name: 'models/gemini-2' }] }), ['gemini-2', 'gemini-3']);
assert.deepEqual(extractModelIds('OpenAI', {}), []);

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

// Endpoint secret encryption round-trips and degrades gracefully.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'logic-test-secret';
const { encryptSecret, decryptSecret } = require('../api/_lib/secrets');
const cipher = encryptSecret('sk-super-secret-key');
assert(typeof cipher === 'string' && cipher.startsWith('v1:'));
assert.notEqual(cipher, 'sk-super-secret-key');
assert.equal(decryptSecret(cipher), 'sk-super-secret-key');
assert.equal(encryptSecret(''), null);
assert.equal(encryptSecret(null), null);
assert.equal(decryptSecret(null), '');
assert.equal(decryptSecret('garbage'), '');
assert.equal(decryptSecret('v1:bad:bad:bad'), '');

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
