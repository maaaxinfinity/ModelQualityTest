const dns = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const DEFAULTS = {
  OpenAI: { baseUrl: 'https://api.openai.com', model: 'gpt-5.5', endpointType: 'openai_responses' },
  Anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-4.8', endpointType: 'anthropic_messages' },
  Google: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-3.1-pro-preview', endpointType: 'google_generate_content' },
  Sakana: { baseUrl: 'https://api.sakana.ai', model: 'fugu-ultra', endpointType: 'sakana_responses' },
  Image: { baseUrl: 'https://api.openai.com', model: 'gpt-image-2', endpointType: 'openai_images' }
};

function normalizeGroup(value) {
  const s = String(value || '').toLowerCase();
  if (s === 'openai' || s === 'oai') return 'OpenAI';
  if (s === 'anthropic' || s === 'a') return 'Anthropic';
  if (s === 'google' || s === 'gemini') return 'Google';
  if (s === 'sakana' || s === 'fugu') return 'Sakana';
  if (s === 'image' || s === 'images') return 'Image';
  return value || 'OpenAI';
}

function slashJoin(base, path) {
  return `${String(base || '').replace(/\/+$/, '')}/${String(path || '').replace(/^\/+/, '')}`;
}

function withV1(base, suffix) {
  const clean = String(base || '').replace(/\/+$/, '');
  if (/\/v\d+$/.test(clean)) return `${clean}/${suffix.replace(/^\/+/, '')}`;
  return `${clean}/v1/${suffix.replace(/^\/+/, '')}`;
}

function questionText(question) {
  if (typeof question.prompt === 'string') return question.prompt;
  if (typeof question.user === 'string') return question.user;
  if (Array.isArray(question.messages)) {
    return question.messages
      .map((m) => `${m.role || 'user'}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n');
  }
  return 'hi';
}

function anthropicMessages(question) {
  if (Array.isArray(question.messages)) return question.messages;
  return [{ role: 'user', content: questionText(question) }];
}

function buildAnthropic(question, cfg) {
  const baseUrl = cfg.baseUrl || DEFAULTS.Anthropic.baseUrl;
  const endpoint = question.endpoint_path
    ? slashJoin(baseUrl.replace(/\/v\d+(\/messages.*)?$/, ''), question.endpoint_path)
    : withV1(baseUrl.replace(/\/v\d+\/messages$/, ''), 'messages');
  const isCountTokens = /count_tokens/.test(question.endpoint_path || '');
  const body = {
    model: question.model || cfg.model || DEFAULTS.Anthropic.model,
    messages: anthropicMessages(question)
  };
  // Stream real message generations; count_tokens is a one-shot JSON call.
  if (!isCountTokens) {
    body.max_tokens = question.max_tokens || cfg.maxTokens || 102400;
    body.stream = true;
  }
  if (question.temperature !== undefined) body.temperature = question.temperature;
  if (question.system || cfg.system) body.system = question.system || cfg.system;
  if (question.tools) body.tools = question.tools;
  if (question.tool_choice) body.tool_choice = question.tool_choice;
  if (question.thinking) {
    body.thinking = question.thinking.type
      ? question.thinking
      : { type: 'enabled', budget_tokens: question.thinking.budget_tokens || 2048 };
    if (body.max_tokens && body.max_tokens <= body.thinking.budget_tokens) {
      body.max_tokens = body.thinking.budget_tokens + 1024;
    }
    body.temperature = 1;
  }
  const headers = { 'Content-Type': 'application/json' };
  if ((cfg.authMode || 'x-api-key') === 'bearer') headers.Authorization = `Bearer ${cfg.apiKey}`;
  else if (cfg.authMode === 'both') {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
    headers['x-api-key'] = cfg.apiKey;
  } else {
    headers['x-api-key'] = cfg.apiKey;
  }
  headers['anthropic-version'] = cfg.version || '2023-06-01';
  // Impersonate the Claude CLI so a gateway keying off the UA treats these as CLI traffic.
  headers['User-Agent'] = cfg.userAgent || 'claude-cli/2.1.198 (external, cli)';
  return { endpoint, method: 'POST', headers, body, modelId: body.model, endpointType: 'anthropic_messages', stream: !!body.stream };
}

function toOpenAIInput(question) {
  if (question.input !== undefined) return question.input;
  if (Array.isArray(question.messages)) {
    return question.messages.map((m) => ({
      role: m.role || 'user',
      content: [{ type: 'input_text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
    }));
  }
  return questionText(question);
}

function convertTool(tool) {
  if (!tool) return tool;
  if (tool.type) return tool;
  return {
    type: 'function',
    name: tool.name,
    description: tool.description || '',
    parameters: tool.parameters || tool.input_schema || { type: 'object', properties: {} }
  };
}

// Sakana / Fugu rejects reasoning.effort outside ('high','xhigh','max'); the
// Responses spec value 'medium' (and lower) is invalid there. Clamp up so the
// same probe definitions work against both OpenAI and Sakana.
const SAKANA_EFFORTS = new Set(['high', 'xhigh', 'max']);
function sakanaReasoning(reasoning) {
  if (!reasoning || typeof reasoning !== 'object') return reasoning;
  if (reasoning.effort && !SAKANA_EFFORTS.has(reasoning.effort)) {
    return Object.assign({}, reasoning, { effort: 'high' });
  }
  return reasoning;
}

function buildOpenAIResponses(question, cfg, groupName) {
  const baseUrl = cfg.baseUrl || DEFAULTS[groupName].baseUrl;
  const endpoint = withV1(baseUrl, 'responses');
  const body = {
    model: question.model || cfg.model || DEFAULTS[groupName].model,
    input: toOpenAIInput(question),
    stream: true
  };
  if (question.system || cfg.system) body.instructions = question.system || cfg.system;
  if (question.max_tokens || cfg.maxTokens) body.max_output_tokens = question.max_tokens || cfg.maxTokens;
  if (question.temperature !== undefined) body.temperature = question.temperature;
  if (question.reasoning) {
    body.reasoning = groupName === 'Sakana' ? sakanaReasoning(question.reasoning) : question.reasoning;
  }
  if (question.text) body.text = question.text;
  if (question.tools) body.tools = question.tools.map(convertTool);
  if (question.tool_choice) body.tool_choice = question.tool_choice;
  if (question.include) body.include = question.include;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`
  };
  if (cfg.organization) headers['OpenAI-Organization'] = cfg.organization;
  if (cfg.project) headers['OpenAI-Project'] = cfg.project;
  return { endpoint, method: 'POST', headers, body, modelId: body.model, endpointType: groupName === 'Sakana' ? 'sakana_responses' : 'openai_responses', stream: true };
}

function buildGoogle(question, cfg) {
  const baseUrl = cfg.baseUrl || DEFAULTS.Google.baseUrl;
  const model = question.model || cfg.model || DEFAULTS.Google.model;
  const endpoint = slashJoin(baseUrl, `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`);
  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: questionText(question) }]
      }
    ],
    generationConfig: {}
  };
  if (question.system || cfg.system) {
    body.systemInstruction = { parts: [{ text: question.system || cfg.system }] };
  }
  if (question.max_tokens || cfg.maxTokens) body.generationConfig.maxOutputTokens = question.max_tokens || cfg.maxTokens;
  if (question.temperature !== undefined) body.generationConfig.temperature = question.temperature;
  if (!Object.keys(body.generationConfig).length) delete body.generationConfig;
  if (question.tools) {
    body.tools = [{
      functionDeclarations: question.tools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || tool.input_schema || { type: 'object', properties: {} }
      }))
    }];
  }
  const headers = {
    'Content-Type': 'application/json',
    'x-goog-api-key': cfg.apiKey
  };
  return { endpoint, method: 'POST', headers, body, modelId: model, endpointType: 'google_generate_content', stream: true };
}

function buildImage(question, cfg) {
  const baseUrl = cfg.baseUrl || DEFAULTS.Image.baseUrl;
  const endpoint = withV1(baseUrl, 'images/generations');
  const image = Object.assign({}, cfg.image || {}, question.image || {});
  const body = {
    model: question.model || cfg.model || DEFAULTS.Image.model,
    prompt: questionText(question),
    n: image.n || question.n || 1,
    quality: image.quality || question.quality || 'medium',
    size: image.size || question.size || '1024x1024'
  };
  if (image.background) body.background = image.background;
  if (image.moderation) body.moderation = image.moderation;
  if (image.output_compression) body.output_compression = Number(image.output_compression);
  if (image.output_format) body.output_format = image.output_format;
  if (image.response_format) body.response_format = image.response_format;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`
  };
  return { endpoint, method: 'POST', headers, body, modelId: body.model, endpointType: 'openai_images' };
}

const IMAGE_EDIT_ASSET_DIR = path.join(process.cwd(), 'assets', 'image-edit');

function imageEditAsset(input, index) {
  const file = String(input && input.file || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp)$/i.test(file)) {
    throw new Error(`invalid image edit fixture at input ${index + 1}`);
  }
  const filePath = path.join(IMAGE_EDIT_ASSET_DIR, file);
  if (!filePath.startsWith(`${IMAGE_EDIT_ASSET_DIR}${path.sep}`) || !fs.existsSync(filePath)) {
    throw new Error(`image edit fixture not found: ${file}`);
  }
  const ext = path.extname(file).toLowerCase();
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
  return {
    file,
    filePath,
    mimeType,
    label: String(input.label || `Image ${index + 1}`),
    role: String(input.role || (index === 0 ? 'edit target' : 'reference object'))
  };
}

function buildImageEdit(question, cfg) {
  const baseUrl = cfg.baseUrl || DEFAULTS.Image.baseUrl;
  const endpoint = withV1(baseUrl, 'images/edits');
  const image = Object.assign({}, cfg.image || {}, question.image || {});
  const rawInputs = Array.isArray(question.edit_inputs) ? question.edit_inputs : [];
  if (!rawInputs.length || rawInputs.length > 16) {
    throw new Error('image edits require between 1 and 16 input images');
  }
  const inputs = rawInputs.map(imageEditAsset);
  const body = {
    model: question.model || cfg.model || DEFAULTS.Image.model,
    prompt: questionText(question),
    n: image.n || question.n || 1,
    quality: image.quality || question.quality || 'medium',
    size: image.size || question.size || '1024x1024',
    input_image_count: inputs.length,
    input_images: inputs.map((input, index) => ({
      index: index + 1,
      file: input.file,
      label: input.label,
      role: input.role
    }))
  };
  if (image.background) body.background = image.background;
  if (image.moderation) body.moderation = image.moderation;
  if (image.output_compression) body.output_compression = Number(image.output_compression);
  if (image.output_format) body.output_format = image.output_format;
  if (image.response_format) body.response_format = image.response_format;

  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (key === 'input_image_count' || key === 'input_images') continue;
    formData.append(key, String(value));
  }
  for (const input of inputs) {
    const bytes = fs.readFileSync(input.filePath);
    formData.append('image[]', new Blob([bytes], { type: input.mimeType }), input.file);
  }
  const headers = { Authorization: `Bearer ${cfg.apiKey}` };
  return {
    endpoint,
    method: 'POST',
    headers,
    body,
    formData,
    modelId: body.model,
    endpointType: 'openai_image_edits'
  };
}

function buildUpstreamRequest(question, cfg) {
  const groupName = normalizeGroup(question.group || cfg.group);
  if (!cfg.apiKey) throw new Error('apiKey is required');
  if (groupName === 'Anthropic') return buildAnthropic(question, cfg);
  if (groupName === 'Google') return buildGoogle(question, cfg);
  if (groupName === 'Sakana') return buildOpenAIResponses(question, cfg, 'Sakana');
  if (groupName === 'Image' && question.endpoint_type === 'openai_image_edits') return buildImageEdit(question, cfg);
  if (groupName === 'Image') return buildImage(question, cfg);
  return buildOpenAIResponses(question, cfg, 'OpenAI');
}

// Build a GET request for a channel's model-list API. Mirrors the auth-header
// logic of the build* functions so detection uses the same credentials a run would.
function buildModelsRequest(group, cfg) {
  const groupName = normalizeGroup(group || cfg.group);
  if (!cfg.apiKey) throw new Error('apiKey is required');
  const baseUrl = cfg.baseUrl || (DEFAULTS[groupName] || DEFAULTS.OpenAI).baseUrl;

  if (groupName === 'Google') {
    return {
      endpoint: slashJoin(baseUrl, '/v1beta/models'),
      method: 'GET',
      headers: { 'x-goog-api-key': cfg.apiKey }
    };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (groupName === 'Anthropic') {
    const mode = cfg.authMode || 'x-api-key';
    if (mode === 'bearer') headers.Authorization = `Bearer ${cfg.apiKey}`;
    else if (mode === 'both') { headers.Authorization = `Bearer ${cfg.apiKey}`; headers['x-api-key'] = cfg.apiKey; }
    else headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = cfg.version || '2023-06-01';
  } else {
    // OpenAI / Sakana / Image — OpenAI-compatible /v1/models with Bearer.
    headers.Authorization = `Bearer ${cfg.apiKey}`;
    if (cfg.organization) headers['OpenAI-Organization'] = cfg.organization;
    if (cfg.project) headers['OpenAI-Project'] = cfg.project;
  }
  return { endpoint: withV1(baseUrl, 'models'), method: 'GET', headers };
}

// Normalize a model-list response into a sorted, de-duplicated array of model ids.
function extractModelIds(group, body) {
  if (!body || typeof body !== 'object') return [];
  const groupName = normalizeGroup(group);
  let ids = [];
  if (groupName === 'Google') {
    ids = (Array.isArray(body.models) ? body.models : [])
      .map((m) => String(m.name || '').replace(/^models\//, ''));
  } else {
    // OpenAI-compatible + Anthropic both use { data: [{ id }] }.
    const list = Array.isArray(body.data) ? body.data : (Array.isArray(body.models) ? body.models : []);
    ids = list.map((m) => (typeof m === 'string' ? m : m.id || m.name || ''));
  }
  return [...new Set(ids.filter(Boolean).map((s) => String(s)))].sort();
}

function sanitizePayload(value) {
  if (Array.isArray(value)) return value.map(sanitizePayload);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'b64_json' && typeof item === 'string') {
      out[key] = `[base64 omitted, ${item.length} chars]`;
    } else if (key === 'image_base64' && typeof item === 'string') {
      out[key] = `[base64 omitted, ${item.length} chars]`;
    } else if (typeof item === 'string' && item.length > 12000) {
      out[key] = `${item.slice(0, 12000)}\n...[truncated ${item.length - 12000} chars]`;
    } else {
      out[key] = sanitizePayload(item);
    }
  }
  return out;
}

function imageMimeType(requestBody, item) {
  const explicit = String((item && (item.mime_type || item.content_type)) || '').trim().toLowerCase();
  if (/^image\/(png|jpe?g|webp)$/.test(explicit)) return explicit.replace('image/jpg', 'image/jpeg');
  const format = String((requestBody && requestBody.output_format) || 'png').trim().toLowerCase();
  if (format === 'jpg' || format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

// Keep image bytes out of PostgreSQL logs while returning renderable artifacts
// to the current browser session. Supports the common OpenAI-compatible shapes
// used by official and proxied Images APIs.
function extractImageArtifacts(body, requestBody) {
  if (!body || typeof body !== 'object') return [];
  let items = [];
  if (Array.isArray(body.data)) items = body.data;
  else if (Array.isArray(body.images)) items = body.images;
  else if (body.url || body.b64_json || body.image_base64 || body.base64) items = [body];

  const artifacts = [];
  for (let index = 0; index < items.length; index++) {
    const raw = items[index];
    const item = typeof raw === 'string' ? { value: raw } : (raw || {});
    const value = typeof item.value === 'string' ? item.value : '';
    const url = item.url || item.image_url || item.uri || (/^https?:\/\//i.test(value) ? value : '');
    const b64 = item.b64_json || item.image_base64 || item.base64 ||
      (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length > 128 ? value : '');
    const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : null;

    if (typeof url === 'string' && url.trim()) {
      artifacts.push({
        index,
        response_format: 'url',
        src: url.trim(),
        revised_prompt: revisedPrompt
      });
      continue;
    }
    if (typeof b64 === 'string' && b64.trim()) {
      let mimeType = imageMimeType(requestBody, item);
      let clean = b64.trim();
      const dataUri = clean.match(/^data:(image\/(?:png|jpe?g|webp));base64,([\s\S]+)$/i);
      if (dataUri) {
        mimeType = dataUri[1].toLowerCase().replace('image/jpg', 'image/jpeg');
        clean = dataUri[2].trim();
      }
      artifacts.push({
        index,
        response_format: 'b64_json',
        src: `data:${mimeType};base64,${clean}`,
        mime_type: mimeType,
        base64_chars: clean.length,
        byte_estimate: Math.floor(clean.length * 3 / 4),
        revised_prompt: revisedPrompt
      });
    }
  }
  return artifacts;
}

function parseImageDimensions(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), mime_type: 'image/png' };
  }

  if (buffer.length >= 12 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      while (offset < buffer.length && buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xda || offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if (sofMarkers.has(marker) && length >= 7) {
        return {
          width: buffer.readUInt16BE(offset + 5),
          height: buffer.readUInt16BE(offset + 3),
          mime_type: 'image/jpeg'
        };
      }
      offset += length;
    }
  }

  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const chunk = buffer.toString('ascii', offset, offset + 4);
      const length = buffer.readUInt32LE(offset + 4);
      const data = offset + 8;
      if (data + length > buffer.length) break;
      if (chunk === 'VP8X' && length >= 10) {
        return {
          width: 1 + buffer.readUIntLE(data + 4, 3),
          height: 1 + buffer.readUIntLE(data + 7, 3),
          mime_type: 'image/webp'
        };
      }
      if (chunk === 'VP8L' && length >= 5 && buffer[data] === 0x2f) {
        const b1 = buffer[data + 1];
        const b2 = buffer[data + 2];
        const b3 = buffer[data + 3];
        const b4 = buffer[data + 4];
        return {
          width: 1 + (((b2 & 0x3f) << 8) | b1),
          height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
          mime_type: 'image/webp'
        };
      }
      if (chunk === 'VP8 ' && length >= 10 &&
          buffer[data + 3] === 0x9d && buffer[data + 4] === 0x01 && buffer[data + 5] === 0x2a) {
        return {
          width: buffer.readUInt16LE(data + 6) & 0x3fff,
          height: buffer.readUInt16LE(data + 8) & 0x3fff,
          mime_type: 'image/webp'
        };
      }
      offset = data + length + (length % 2);
    }
  }
  return null;
}

function isPrivateIp(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    if (value.startsWith('::ffff:')) return isPrivateIp(value.slice(7));
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
      /^fe[89ab]/.test(value) || value.startsWith('ff');
  }
  return true;
}

async function assertPublicImageUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:') throw new Error('dimension probe only permits HTTPS image URLs');
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('dimension probe rejected a private image host');
  }
  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => isPrivateIp(item.address))) {
    throw new Error('dimension probe rejected a private image address');
  }
  return parsed;
}

async function fetchImageBytes(rawUrl, timeoutMs = 30000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let current = rawUrl;
  try {
    for (let redirects = 0; redirects <= 4; redirects++) {
      const parsed = await assertPublicImageUrl(current);
      const response = await fetch(parsed, {
        headers: { Accept: 'image/png,image/jpeg,image/webp,image/*;q=0.8' },
        redirect: 'manual',
        signal: ctl.signal
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        current = new URL(response.headers.get('location'), parsed).toString();
        continue;
      }
      if (!response.ok) throw new Error(`image download returned HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > 64 * 1024 * 1024) throw new Error('image exceeds 64 MB dimension probe limit');
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 64 * 1024 * 1024) throw new Error('image exceeds 64 MB dimension probe limit');
      return buffer;
    }
    throw new Error('image URL redirected too many times');
  } finally {
    clearTimeout(timer);
  }
}

async function inspectImageDimensions(images) {
  const artifacts = Array.isArray(images) ? images : [];
  await Promise.all(artifacts.map(async (image) => {
    try {
      let bytes;
      if (image.response_format === 'b64_json') {
        const match = String(image.src || '').match(/^data:image\/(?:png|jpe?g|webp);base64,([\s\S]+)$/i);
        if (!match) throw new Error('invalid base64 image payload');
        bytes = Buffer.from(match[1], 'base64');
      } else {
        bytes = await fetchImageBytes(image.src);
      }
      const dimensions = parseImageDimensions(bytes);
      if (!dimensions || !dimensions.width || !dimensions.height) throw new Error('unsupported or malformed image bytes');
      image.width = dimensions.width;
      image.height = dimensions.height;
      image.mime_type = image.mime_type || dimensions.mime_type;
    } catch (error) {
      image.dimension_error = error && error.message ? error.message : String(error);
    }
  }));
  return artifacts;
}

function autoSizeIsValid(value) {
  const match = String(value || '').match(/^(\d+)x(\d+)$/);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const ratio = width / height;
  return width % 16 === 0 && height % 16 === 0 && ratio >= 1 / 3 && ratio <= 3 &&
    Math.max(width, height) <= 3840 && width * height <= 3840 * 2160;
}

function summarizeImageProbe(images, requestBody, elapsedMs, options = {}) {
  const artifacts = Array.isArray(images) ? images : [];
  const requestedN = Math.max(1, Number(requestBody && requestBody.n) || 1);
  const requestedFormat = (requestBody && requestBody.response_format) || null;
  const requestedSize = (requestBody && requestBody.size) || null;
  const returnedFormats = [...new Set(artifacts.map((image) => image.response_format).filter(Boolean))];
  const actualSizes = artifacts.map((image) => image.width && image.height ? `${image.width}x${image.height}` : null);
  const dimensionErrors = artifacts.map((image) => image.dimension_error || null);
  const countOk = artifacts.length === requestedN;
  const formatOk = !requestedFormat ||
    (artifacts.length > 0 && returnedFormats.length === 1 && returnedFormats[0] === requestedFormat);
  const validateSize = !!options.validateSize;
  const sizeOk = !validateSize ? null : (
    artifacts.length > 0 && actualSizes.every(Boolean) &&
    (requestedSize === 'auto'
      ? actualSizes.every(autoSizeIsValid)
      : actualSizes.every((size) => size === requestedSize))
  );
  const probe = {
    requested_n: requestedN,
    returned_n: artifacts.length,
    requested_format: requestedFormat,
    returned_formats: returnedFormats,
    quality: (requestBody && requestBody.quality) || null,
    size: (requestBody && requestBody.size) || null,
    requested_size: requestedSize,
    actual_sizes: actualSizes,
    dimension_errors: dimensionErrors,
    elapsed_ms: elapsedMs,
    dimension_probe_ms: options.dimensionProbeMs == null ? null : options.dimensionProbeMs,
    ms_per_image: artifacts.length ? Math.round(Number(elapsedMs || 0) / artifacts.length) : null,
    count_ok: countOk,
    format_ok: formatOk,
    size_ok: sizeOk
  };
  const failures = [];
  if (!countOk) failures.push(`expected ${requestedN} image(s), received ${artifacts.length}`);
  if (!formatOk) failures.push(`expected response_format=${requestedFormat}, received ${returnedFormats.join(',') || 'none'}`);
  if (validateSize && !sizeOk) {
    const received = actualSizes.map((size, index) => size || `image ${index + 1}: unverified`).join(', ') || 'none';
    failures.push(`expected size=${requestedSize}, received ${received}`);
  }
  return { probe, error: failures.length ? failures.join('; ') : null };
}

function parseJsonMaybe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function headerObject(headers) {
  const out = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

// Read an SSE response body and yield { event, data } records. `event` is the
// last `event:` label (may be ''); `data` is one `data:` payload string. Blank
// line delimits records; `data: [DONE]` is a sentinel and is not yielded.
async function* readSse(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  let data = [];
  const flush = function* () {
    if (data.length) {
      const payload = data.join('\n');
      if (payload !== '[DONE]') yield { event, data: payload };
    }
    event = '';
    data = [];
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') { yield* flush(); continue; }
        if (line.startsWith(':')) continue; // comment / keep-alive
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }
  yield* flush();
}

// Aggregate parsed SSE events into the same JSON object the non-streaming
// endpoint would have returned, so downstream usage/model/cost logic is unchanged.
function aggregateStream(endpointType, events) {
  if (endpointType === 'anthropic_messages') {
    let message = null;
    const blocks = [];
    for (const ev of events) {
      const d = parseJsonMaybe(ev.data);
      if (!d) continue;
      const type = d.type || ev.event;
      if (type === 'message_start' && d.message) {
        message = d.message;
        message.content = Array.isArray(message.content) ? message.content : [];
      } else if (type === 'content_block_start') {
        blocks[d.index] = d.content_block || { type: 'text', text: '' };
        if (blocks[d.index].type === 'text' && blocks[d.index].text == null) blocks[d.index].text = '';
      } else if (type === 'content_block_delta' && d.delta) {
        const b = blocks[d.index] || (blocks[d.index] = { type: 'text', text: '' });
        if (d.delta.type === 'text_delta') b.text = (b.text || '') + (d.delta.text || '');
        else if (d.delta.type === 'thinking_delta') b.thinking = (b.thinking || '') + (d.delta.thinking || '');
        else if (d.delta.type === 'input_json_delta') b.partial_json = (b.partial_json || '') + (d.delta.partial_json || '');
      } else if (type === 'message_delta') {
        if (!message) message = { type: 'message', content: [] };
        if (d.delta) Object.assign(message, d.delta);
        if (d.usage) message.usage = Object.assign({}, message.usage, d.usage);
      }
    }
    if (!message) return null;
    if (blocks.length) message.content = blocks.filter(Boolean);
    return message;
  }

  if (endpointType === 'google_generate_content') {
    const out = { candidates: [{ content: { role: 'model', parts: [{ text: '' }] } }] };
    let text = '';
    for (const ev of events) {
      const d = parseJsonMaybe(ev.data);
      if (!d) continue;
      const parts = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
      if (Array.isArray(parts)) for (const p of parts) if (typeof p.text === 'string') text += p.text;
      if (d.candidates && d.candidates[0] && d.candidates[0].finishReason) out.candidates[0].finishReason = d.candidates[0].finishReason;
      if (d.usageMetadata) out.usageMetadata = d.usageMetadata;
      if (d.modelVersion) out.modelVersion = d.modelVersion;
    }
    out.candidates[0].content.parts[0].text = text;
    return out;
  }

  // openai_responses / sakana_responses
  let completed = null;
  let text = '';
  let usage = null;
  let model = null;
  for (const ev of events) {
    const d = parseJsonMaybe(ev.data);
    if (!d) continue;
    const type = d.type || ev.event;
    if (type === 'response.output_text.delta' && typeof d.delta === 'string') text += d.delta;
    if (d.response) {
      if (type === 'response.completed') completed = d.response;
      if (d.response.usage) usage = d.response.usage;
      if (d.response.model) model = d.response.model;
    }
  }
  if (completed) return completed;
  const built = { object: 'response', output_text: text };
  if (usage) built.usage = usage;
  if (model) built.model = model;
  if (text) {
    built.output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }];
  }
  return built;
}

async function fetchOnce(request, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 600000);
  const t0 = Date.now();
  try {
    const resp = await fetch(request.endpoint, {
      method: request.method || 'POST',
      headers: request.headers,
      body: request.formData || JSON.stringify(request.body),
      signal: ctl.signal
    });

    // Stream + aggregate only when the request asked for it AND the upstream
    // actually returned an OK SSE stream. Errors (non-OK) come back as ordinary
    // JSON, so fall through to the buffered path for identical error handling.
    const contentType = resp.headers.get('content-type') || '';
    if (request.stream && resp.ok && resp.body && /text\/event-stream/i.test(contentType)) {
      const events = [];
      for await (const ev of readSse(resp)) events.push(ev);
      const raw = events.map((e) => (e.event ? `event: ${e.event}\n` : '') + `data: ${e.data}`).join('\n\n');
      const json = aggregateStream(request.endpointType, events);
      return {
        ok: true,
        status: resp.status,
        statusText: resp.statusText,
        headers: headerObject(resp.headers),
        text: raw,
        json,
        elapsedMs: Date.now() - t0
      };
    }

    const text = await resp.text();
    const json = parseJsonMaybe(text);
    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      headers: headerObject(resp.headers),
      text,
      json,
      elapsedMs: Date.now() - t0
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUsage(body, groupName, question, requestBody) {
  const usage = {};
  if (!body || typeof body !== 'object') return usage;
  if (body.usage) {
    Object.assign(usage, body.usage);
    if (body.usage.input_tokens != null) usage.input_tokens = body.usage.input_tokens;
    if (body.usage.output_tokens != null) usage.output_tokens = body.usage.output_tokens;
    if (body.usage.prompt_tokens != null) usage.input_tokens = body.usage.prompt_tokens;
    if (body.usage.completion_tokens != null) usage.output_tokens = body.usage.completion_tokens;
    if (body.usage.total_tokens != null) usage.total_tokens = body.usage.total_tokens;
  }
  if (body.usageMetadata) {
    usage.input_tokens = body.usageMetadata.promptTokenCount || 0;
    usage.output_tokens = body.usageMetadata.candidatesTokenCount || 0;
    usage.total_tokens = body.usageMetadata.totalTokenCount || usage.input_tokens + usage.output_tokens;
  }
  if (groupName === 'Image') {
    const n = Number(requestBody && requestBody.n) || 1;
    usage.image_count = n;
    usage.input_tokens = usage.input_tokens || estimateTextTokens(requestBody && requestBody.prompt);
    usage.output_tokens = usage.output_tokens || 0;
  }
  return usage;
}

function extractRoutedModel(body, headers, fallback) {
  if (!body || typeof body !== 'object') return headers['x-model'] || fallback;
  return body.model ||
    body.response?.model ||
    body.provider_model ||
    body.routed_model ||
    body.router?.model ||
    headers['x-model'] ||
    headers['x-sakana-model'] ||
    fallback;
}

function estimateTextTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

module.exports = {
  DEFAULTS,
  buildUpstreamRequest,
  buildModelsRequest,
  extractModelIds,
  fetchOnce,
  normalizeGroup,
  normalizeUsage,
  sanitizePayload,
  extractImageArtifacts,
  inspectImageDimensions,
  parseImageDimensions,
  summarizeImageProbe,
  extractRoutedModel
};
