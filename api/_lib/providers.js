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
      body: JSON.stringify(request.body),
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
  extractRoutedModel
};
