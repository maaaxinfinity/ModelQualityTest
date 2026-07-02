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
  const body = {
    model: question.model || cfg.model || DEFAULTS.Anthropic.model,
    messages: anthropicMessages(question)
  };
  if (!/count_tokens/.test(question.endpoint_path || '')) {
    body.max_tokens = question.max_tokens || cfg.maxTokens || 1024;
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
  return { endpoint, method: 'POST', headers, body, modelId: body.model, endpointType: 'anthropic_messages' };
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

function buildOpenAIResponses(question, cfg, groupName) {
  const baseUrl = cfg.baseUrl || DEFAULTS[groupName].baseUrl;
  const endpoint = withV1(baseUrl, 'responses');
  const body = {
    model: question.model || cfg.model || DEFAULTS[groupName].model,
    input: toOpenAIInput(question)
  };
  if (question.system || cfg.system) body.instructions = question.system || cfg.system;
  if (question.max_tokens || cfg.maxTokens) body.max_output_tokens = question.max_tokens || cfg.maxTokens;
  if (question.temperature !== undefined) body.temperature = question.temperature;
  if (question.reasoning) body.reasoning = question.reasoning;
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
  return { endpoint, method: 'POST', headers, body, modelId: body.model, endpointType: groupName === 'Sakana' ? 'sakana_responses' : 'openai_responses' };
}

function buildGoogle(question, cfg) {
  const baseUrl = cfg.baseUrl || DEFAULTS.Google.baseUrl;
  const model = question.model || cfg.model || DEFAULTS.Google.model;
  const endpoint = slashJoin(baseUrl, `/v1beta/models/${encodeURIComponent(model)}:generateContent`);
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
  return { endpoint, method: 'POST', headers, body, modelId: model, endpointType: 'google_generate_content' };
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
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`
  };
  return { endpoint, method: 'POST', headers, body, modelId: body.model, endpointType: 'openai_images' };
}

function buildUpstreamRequest(question, cfg) {
  const groupName = normalizeGroup(question.group || cfg.group);
  if (!cfg.apiKey) throw new Error('apiKey is required');
  if (groupName === 'Anthropic') return buildAnthropic(question, cfg);
  if (groupName === 'Google') return buildGoogle(question, cfg);
  if (groupName === 'Sakana') return buildOpenAIResponses(question, cfg, 'Sakana');
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

async function fetchOnce(request, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 120000);
  const t0 = Date.now();
  try {
    const resp = await fetch(request.endpoint, {
      method: request.method || 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: ctl.signal
    });
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
  extractRoutedModel
};
