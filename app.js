/* ====================================================================
 * Claude 渠道检测 - 主逻辑（卡片网格版）
 * ====================================================================
 *  - 每道题渲染成一张卡片，挂载到 #qgrid
 *  - 卡片自带运行按钮、展开/收起按钮、状态徽章
 *  - 顶部"全部运行"按钮顺序跑所有题
 *  - 无 checkbox / 无单独的"结果"面板：结果就地写入卡片
 * ==================================================================== */

(function () {
  'use strict';

  // ---------- DOM 句柄 ----------
  const el = (id) => document.getElementById(id);
  const $cfg = {
    preset: el('cfg-preset'),
    baseUrl: el('cfg-baseUrl'),
    apiKey: el('cfg-apiKey'),
    model: el('cfg-model'),
    version: el('cfg-version'),
    authMode: el('cfg-authMode'),
    transport: el('cfg-transport'),
    dangerousBrowser: el('cfg-dangerousBrowser'),
    impersonateCc: el('cfg-impersonateCc'),
    maxTokens: el('cfg-maxTokens'),
    delay: el('cfg-delay'),
    timeout: el('cfg-timeout'),
    extraHeaders: el('cfg-extraHeaders'),
    system: el('cfg-system'),
    remember: el('cfg-remember')
  };
  const $qgrid = el('qgrid');
  const $qCount = el('q-count');
  const $filterCategory = el('filter-category');
  const $runStatus = el('run-status');
  const $stop = el('stop');
  const $transportHint = el('transport-hint');
  const $optCollapseAfter = el('opt-collapse-after');
  const $optConcurrency = el('opt-concurrency');

  let PROXY_AVAILABLE = false;
  // 所有在飞的请求的 AbortController；停止按钮会把它们全部 abort
  const inflightCtls = new Set();
  let stopFlag = false;
  let batchRunning = false;       // run-all 批量是否进行中
  let activeSingleRuns = 0;       // 单卡运行计数（不在批量内的）

  const LS_KEY = 'claude-channel-probe.config.v2';

  // ============================================================
  //  配置持久化
  // ============================================================
  function loadSavedConfig() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      // 迁移：旧版默认 timeout 是 60000，对 thinking 题太短。如果存的就是旧默认值，
      // 视为"用户没专门设置过"，丢弃以让新默认值 600000 生效。
      if (obj.timeout === 60000 || obj.timeout === '60000') delete obj.timeout;
      for (const k of Object.keys($cfg)) {
        if (obj[k] === undefined || !$cfg[k]) continue;
        if ($cfg[k].type === 'checkbox') $cfg[k].checked = !!obj[k];
        else $cfg[k].value = obj[k];
      }
    } catch (e) { /* ignore */ }
  }
  function saveConfigIfRequested() {
    if (!$cfg.remember.checked) { localStorage.removeItem(LS_KEY); return; }
    const obj = {};
    for (const k of Object.keys($cfg)) {
      if (!$cfg[k]) continue;
      obj[k] = $cfg[k].type === 'checkbox' ? $cfg[k].checked : $cfg[k].value;
    }
    localStorage.setItem(LS_KEY, JSON.stringify(obj));
  }

  // ============================================================
  //  渲染：每道题一张卡
  // ============================================================
  function renderQuestions() {
    $qgrid.innerHTML = '';
    const cats = new Set();
    for (const q of window.QUESTIONS) {
      cats.add(q.category);
      $qgrid.appendChild(buildCard(q));
    }
    if ($qCount) $qCount.textContent = window.QUESTIONS.length;

    // 分类过滤下拉
    if ($filterCategory) {
      $filterCategory.innerHTML = '<option value="">全部分类</option>' +
        [...cats].map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');
    }
  }

  function buildCard(q) {
    const card = document.createElement('div');
    card.className = 'qcard';
    card.dataset.qid = q.id;
    card.dataset.category = q.category;
    card.innerHTML = `
      <div class="qcard-head">
        <span class="tag">${escapeHtml(q.category)}</span>
        <span class="qcard-name" title="${escapeAttr(q.id)}">${escapeHtml(q.name)}</span>
        <div class="qcard-actions">
          <button type="button" class="qcard-run">▶ 运行</button>
          <button type="button" class="qcard-expand" title="展开 / 收起">▾</button>
        </div>
      </div>
      <div class="qcard-meta-row"></div>
      <div class="qcard-desc">${escapeHtml(q.description || '（无说明）')}</div>
      <div class="qcard-body"></div>`;

    const head = card.querySelector('.qcard-head');
    const runBtn = card.querySelector('.qcard-run');
    const expandBtn = card.querySelector('.qcard-expand');

    // 点击头部空白处也展开（按钮自己 stopPropagation）
    head.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      toggleCard(card);
    });
    expandBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleCard(card); });
    runBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      runOneQuestion(q, card);
    });

    return card;
  }

  function toggleCard(card, force) {
    const wantOpen = force === true ? true : force === false ? false : !card.classList.contains('expanded');
    card.classList.toggle('expanded', wantOpen);
    card.querySelector('.qcard-expand').textContent = wantOpen ? '▴' : '▾';
    if (wantOpen) ensureBodyRendered(card);
  }

  // 第一次展开时把"题目 + 观察要点"渲染到 body（结果保持空）
  function ensureBodyRendered(card) {
    const body = card.querySelector('.qcard-body');
    if (body.dataset.ready === '1') return;
    const q = questionFor(card);
    if (!q) return;

    body.appendChild(makeSection('题目与观察要点', true, (inner) => {
      const up = document.createElement('div');
      up.className = 'userprompt-box';
      up.textContent = getUserPreview(q);
      inner.appendChild(up);
      if (q.observe) {
        const obs = document.createElement('div');
        obs.className = 'observe-box';
        obs.style.marginTop = '8px';
        obs.textContent = '观察要点：' + q.observe;
        inner.appendChild(obs);
      }
    }));
    const resultHost = document.createElement('div');
    resultHost.className = 'qcard-result';
    body.appendChild(resultHost);
    body.dataset.ready = '1';
  }

  function questionFor(card) {
    return window.QUESTIONS.find(q => q.id === card.dataset.qid);
  }

  // ============================================================
  //  请求构造（保持不变）
  // ============================================================
  // ============================================================
  //  Claude Code 伪装：常量 + 工具
  // ============================================================
  //  - sub2api / claude-relay-service 校验逻辑见对端 claude_code_validator.go
  //  - User-Agent 必须匹配 ^claude-cli/\d+\.\d+\.\d+
  //  - X-App / anthropic-beta / anthropic-version 必须非空
  //  - body.system 必须是数组，至少一条 text 与官方模板 Dice 系数 ≥ 0.5
  //  - body.metadata.user_id 必须合法（这里走 >=2.1.78 的 JSON 形态）
  const CC_USER_AGENT = 'claude-cli/2.1.126 (external, cli)';
  const CC_BETA_HEADER = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';
  const CC_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
  const CC_DEVICE_KEY = 'claude-channel-probe.cc.device_id';

  // 把已有 system（可能是 string / array / null）整理成数组形态供 CC 模板前置拼接
  function normalizeSystemForCc(sys) {
    if (sys === undefined || sys === null || sys === '') return [];
    if (typeof sys === 'string') return [{ type: 'text', text: sys }];
    if (Array.isArray(sys)) {
      return sys.map(it => {
        if (it && typeof it === 'object' && typeof it.text === 'string') return it;
        if (typeof it === 'string') return { type: 'text', text: it };
        return { type: 'text', text: String(it == null ? '' : it) };
      });
    }
    return [{ type: 'text', text: String(sys) }];
  }

  function mergeBetaHeader(existing, add) {
    const have = new Set(String(existing).split(',').map(s => s.trim()).filter(Boolean));
    for (const tok of String(add).split(',').map(s => s.trim()).filter(Boolean)) have.add(tok);
    return [...have].join(',');
  }

  // 随机生成 64 位十六进制（device_id 的真实形态）
  function genHex(nBytes) {
    const buf = new Uint8Array(nBytes);
    crypto.getRandomValues(buf);
    let s = '';
    for (let i = 0; i < buf.length; i++) s += buf[i].toString(16).padStart(2, '0');
    return s;
  }
  // RFC 4122 v4 UUID
  function genUUIDv4() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0'));
    return `${h.slice(0,4).join('')}-${h.slice(4,6).join('')}-${h.slice(6,8).join('')}-${h.slice(8,10).join('')}-${h.slice(10,16).join('')}`;
  }
  function getOrCreateDeviceId() {
    try {
      let id = localStorage.getItem(CC_DEVICE_KEY);
      if (id && /^[a-f0-9]{64}$/.test(id)) return id;
      id = genHex(32);
      localStorage.setItem(CC_DEVICE_KEY, id);
      return id;
    } catch (e) {
      return genHex(32);
    }
  }
  // CC >= 2.1.78 形态：JSON 字符串，account_uuid 允许为空
  function buildCcUserId() {
    return JSON.stringify({
      device_id: getOrCreateDeviceId(),
      account_uuid: '',
      session_id: genUUIDv4()
    });
  }

  function buildRequestBody(question, cfg) {
    const model = question.model || cfg.model;
    const body = {
      model,
      max_tokens: question.max_tokens || cfg.maxTokens
    };
    if (question.temperature !== undefined) body.temperature = question.temperature;
    if (Array.isArray(question.messages)) body.messages = question.messages;
    else if (typeof question.user === 'string') body.messages = [{ role: 'user', content: question.user }];
    else body.messages = [{ role: 'user', content: '(empty)' }];

    if (question.system !== undefined && question.system !== null && question.system !== '') {
      body.system = question.system;
    } else if (cfg.system && cfg.system.trim()) {
      body.system = cfg.system;
    }

    if (Array.isArray(question.tools) && question.tools.length) {
      body.tools = question.tools;
      if (question.tool_choice) body.tool_choice = question.tool_choice;
    }

    // 伪装成 Claude Code：把 system 改成数组并塞官方模板，加上合法 metadata.user_id
    // sub2api / claude-relay-service 在 /messages 路径会校验这两项
    if (cfg.impersonateCc) {
      const cleaned = normalizeSystemForCc(body.system);
      body.system = [
        { type: 'text', text: CC_SYSTEM_PROMPT },
        ...cleaned
      ];
      body.metadata = Object.assign({}, body.metadata, {
        user_id: buildCcUserId()
      });
    }

    // ── 思考模式（extended thinking）：按模型自动转写 ─────────────
    // 题目里只写 question.thinking = {effort: 'low'|'medium'|'high'|'xhigh'|'max'}
    // 这里把它翻译成具体请求结构。题目也可以直接给已经成形的 thinking 对象，那就原样透传。
    if (question.thinking) {
      const family = detectThinkingFamily(model);
      const effort = question.thinking.effort || 'medium';
      if (typeof question.thinking === 'object' && question.thinking.type) {
        // 题目自己已给完整结构，原样透传
        body.thinking = question.thinking;
      } else if (family === 'opus-4-7') {
        // 4.7：adaptive；不再支持 budget_tokens / temperature / top_p / top_k
        body.thinking = { type: 'adaptive', display: 'summarized' };
        body.output_config = { effort: effortFor47(effort) };
        delete body.temperature;
      } else if (family === 'opus-4-6' || family === 'sonnet-4-6') {
        // 4.6 系：manual extended thinking
        const budget = budgetFor46(effort);
        body.thinking = { type: 'enabled', budget_tokens: budget };
        // 协议要求 budget_tokens < max_tokens；当题目给的 max_tokens 不够时，自动抬到 budget+4096，保证 effort='max' 真正生效
        if (!body.max_tokens || body.max_tokens <= budget) body.max_tokens = budget + 4096;
        body.temperature = 1; // 用 thinking 必须 = 1
      } else if (family === 'pre-4-6') {
        // 4.5 / 4.1 / 4 / sonnet-4 等：同 4.6 形态，且需要 beta 头（在 buildHeaders 里加）
        const budget = budgetFor46(effort);
        body.thinking = { type: 'enabled', budget_tokens: budget };
        if (!body.max_tokens || body.max_tokens <= budget) body.max_tokens = budget + 4096;
        body.temperature = 1;
        body.__needsInterleavedBeta = true; // 标记给 buildHeaders 用，临时字段
      } else {
        // 不识别的模型 ID：保守按 4.6 形态发，让服务器自己拒
        const budget = budgetFor46(effort);
        body.thinking = { type: 'enabled', budget_tokens: budget };
        if (!body.max_tokens || body.max_tokens <= budget) body.max_tokens = budget + 4096;
        body.temperature = 1;
      }
    }
    return body;
  }

  // 模型家族识别（用于选 thinking 请求形态）
  function detectThinkingFamily(model) {
    const m = String(model || '').toLowerCase();
    if (m.includes('opus-4-7')) return 'opus-4-7';
    if (m.includes('opus-4-6')) return 'opus-4-6';
    if (m.includes('sonnet-4-6')) return 'sonnet-4-6';
    if (m.includes('opus-4-5') || m.includes('opus-4-1') || m.match(/opus-4(?!-\d)/) ||
        m.includes('sonnet-4-5') || m.match(/sonnet-4(?!-\d)/)) return 'pre-4-6';
    return 'unknown';
  }
  function effortFor47(e) {
    // 4.7 合法集合：low / medium / high / xhigh / max
    const ok = ['low', 'medium', 'high', 'xhigh', 'max'];
    return ok.includes(e) ? e : 'medium';
  }
  function budgetFor46(effort) {
    // 把 effort 翻译成 budget_tokens；上层会同步抬 max_tokens 以满足 budget < max_tokens
    const table = { low: 1024, medium: 2048, high: 4096, xhigh: 8000, max: 16000 };
    return table[effort] || 2048;
  }
  function buildHeaders(cfg, body) {
    const h = { 'Content-Type': 'application/json' };
    if (cfg.authMode === 'x-api-key' || cfg.authMode === 'both') h['x-api-key'] = cfg.apiKey;
    if (cfg.authMode === 'bearer' || cfg.authMode === 'both') h['Authorization'] = 'Bearer ' + cfg.apiKey;
    if (cfg.version && cfg.version.trim()) h['anthropic-version'] = cfg.version.trim();
    if (cfg.dangerousBrowser) h['anthropic-dangerous-direct-browser-access'] = 'true';

    // 早期 4.x 用 manual thinking 时，需要 interleaved-thinking beta 头
    if (body && body.__needsInterleavedBeta) {
      const cur = h['anthropic-beta'];
      h['anthropic-beta'] = cur ? (cur + ',interleaved-thinking-2025-05-14') : 'interleaved-thinking-2025-05-14';
      delete body.__needsInterleavedBeta;
    }

    // 伪装成 Claude Code：覆盖/补齐 sub2api 校验所需的头
    // （直连模式下 User-Agent 不会真正生效，浏览器禁止 fetch 改 UA）
    if (cfg.impersonateCc) {
      h['User-Agent'] = CC_USER_AGENT;
      h['X-App'] = 'cli';
      if (!h['anthropic-version']) h['anthropic-version'] = '2023-06-01';
      const existing = h['anthropic-beta'];
      h['anthropic-beta'] = existing
        ? mergeBetaHeader(existing, CC_BETA_HEADER)
        : CC_BETA_HEADER;
    }

    if (cfg.extraHeaders && cfg.extraHeaders.trim()) {
      try {
        const extra = JSON.parse(cfg.extraHeaders);
        if (extra && typeof extra === 'object') Object.assign(h, extra);
      } catch (e) { console.warn('额外请求头不是合法 JSON，忽略:', e); }
    }
    return h;
  }
  function buildEndpoint(cfg, pathOverride) {
    let base = (cfg.baseUrl || '').trim();
    if (!base) base = 'https://api.anthropic.com';
    base = base.replace(/\/+$/, '');
    if (pathOverride) {
      // 题目自定端点（例如 /v1/messages/count_tokens）：把 base 还原成"根地址"
      base = base.replace(/\/v\d+\/messages(\/[^/]+)?$/, '').replace(/\/v\d+$/, '');
      return base + (pathOverride.startsWith('/') ? pathOverride : '/' + pathOverride);
    }
    if (/\/v\d+\/messages$/.test(base)) return base;
    if (/\/v\d+$/.test(base)) return base + '/messages';
    return base + '/v1/messages';
  }

  // ============================================================
  //  实际请求
  // ============================================================
  async function callOnce(question, cfg) {
    // 自动重试一次：对 5xx 偶发抖动有效，对 4xx 客户端错误不重试
    let last = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await callOnceNoRetry(question, cfg);
      if (r.ok || r.networkError) return r;
      if (r.status >= 500 && r.status < 600 && attempt === 1) {
        last = r;
        await sleep(500);
        continue;
      }
      return r;
    }
    return last;
  }

  async function callOnceNoRetry(question, cfg) {
    const endpoint = buildEndpoint(cfg, question.endpoint_path);
    const body = buildRequestBody(question, cfg);
    if (question.endpoint_path && /count_tokens/.test(question.endpoint_path)) {
      delete body.max_tokens; // count_tokens 端点不接受 max_tokens
    }
    const headers = buildHeaders(cfg, body);  // body 可能带 __needsInterleavedBeta 标记
    const mode = pickTransport(cfg);

    // 每个请求自己的 AbortController，加入全局 Set 以便停止按钮一次性中断所有在飞请求
    const ctl = new AbortController();
    inflightCtls.add(ctl);
    const timer = setTimeout(() => ctl.abort(), cfg.timeout);
    const t0 = performance.now();

    let resp, txt, json = null, headerMap = {}, netErr = null;
    const transport = mode;

    try {
      if (mode === 'proxy') {
        const proxyResp = await fetch('/proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: endpoint, method: 'POST', headers, body, timeout_ms: cfg.timeout }),
          signal: ctl.signal
        });
        if (!proxyResp.ok) {
          const errBody = await proxyResp.text();
          clearTimeout(timer);
          inflightCtls.delete(ctl);
          return {
            ok: false, networkError: true, transport,
            message: '本地中转返回 ' + proxyResp.status + ': ' + errBody,
            endpoint, headers, body, elapsedMs: Math.round(performance.now() - t0)
          };
        }
        const wrapped = await proxyResp.json();
        resp = { ok: wrapped.status >= 200 && wrapped.status < 300, status: wrapped.status, statusText: '' };
        txt = wrapped.body || '';
        for (const [k, v] of (wrapped.headers || [])) {
          headerMap[k] = headerMap[k] === undefined ? v : (headerMap[k] + '\n' + v);
        }
      } else {
        resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
        resp.headers.forEach((v, k) => { headerMap[k] = v; });
        try { txt = await resp.text(); } catch (e) { txt = ''; }
      }
    } catch (e) { netErr = e; }
    clearTimeout(timer);
    inflightCtls.delete(ctl);
    const elapsed = Math.round(performance.now() - t0);

    if (netErr) {
      const isAbort = netErr.name === 'AbortError';
      let msg;
      if (isAbort) msg = '请求被中断 / 超时';
      else if (transport === 'proxy') msg = '本地中转请求失败：' + (netErr.message || String(netErr)) + '\n请检查 server.py 是否仍在运行。';
      else msg = '浏览器直连失败：' + (netErr.message || String(netErr)) +
                 '\n更稳定的办法：本机运行 `python server.py`，页面会自动改走本地中转，等同 curl。' +
                 '\n你也可以点开下方"完整请求体"，用"复制为 curl"在终端直接验证。';
      return { ok: false, networkError: true, transport, message: msg, endpoint, headers, body, elapsedMs: elapsed };
    }

    if (txt) { try { json = JSON.parse(txt); } catch (e) { /* 非 JSON */ } }

    return {
      ok: resp.ok, status: resp.status, statusText: resp.statusText, transport,
      endpoint, headers, body,
      respHeaders: headerMap, respText: txt, respJson: json,
      elapsedMs: elapsed
    };
  }

  function pickTransport(cfg) {
    if (cfg.transport === 'proxy') return 'proxy';
    if (cfg.transport === 'direct') return 'direct';
    return PROXY_AVAILABLE ? 'proxy' : 'direct';
  }

  async function detectProxy() {
    try {
      const r = await fetch('/proxy/ping', { method: 'GET' });
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok) {
          PROXY_AVAILABLE = true;
          updateTransportHint('✅ 检测到本地中转 v' + j.version + '：自动模式下使用中转，可看到完整响应头');
          return;
        }
      }
    } catch (e) { /* fall through */ }
    PROXY_AVAILABLE = false;
    updateTransportHint('ℹ️ 未检测到本地中转：自动模式下使用浏览器直连。如需看到全部响应头，请用 `python server.py` 启动本地中转。');
  }
  function updateTransportHint(text) { if ($transportHint) $transportHint.textContent = text; }

  // ============================================================
  //  指纹分析（保持不变）
  // ============================================================
  function analyzeFingerprint(result) {
    const r = result && result.respJson;
    const out = {};
    if (!r || typeof r !== 'object') return out;
    out.id = r.id;
    out.type = r.type;
    out.role = r.role;
    out.model = r.model;
    out.stop_reason = r.stop_reason;
    out.stop_sequence = r.stop_sequence;
    out.usage = r.usage;
    if (typeof r.id === 'string') {
      const m = r.id.match(/^([a-zA-Z]+_?)/);
      out.id_prefix = m ? m[1] : '(无可识别前缀)';
    }
    if (Array.isArray(r.content)) {
      out.text_blocks = r.content.filter(b => b && b.type === 'text').map(b => b.text);
      out.tool_uses = r.content.filter(b => b && b.type === 'tool_use').map(b => ({
        id: b.id, name: b.name, input: b.input,
        id_prefix: (b.id && b.id.match(/^([a-zA-Z]+_?)/) || [, '?'])[1],
        caller: b.caller
      }));
      // thinking / redacted_thinking 块
      out.thinking_blocks = r.content
        .filter(b => b && (b.type === 'thinking' || b.type === 'redacted_thinking'))
        .map(b => ({
          type: b.type,
          text: b.thinking || '',          // type=thinking 时是字段名 "thinking"，存放正文
          textLen: (b.thinking || '').length,
          signature: b.signature || '',
          signatureLen: (b.signature || '').length,
          data: b.data || ''               // redacted_thinking 只回这个，不回正文
        }));
    }
    out.channel_guess = guessChannel(result, r, out);
    return out;
  }

  // ── 用于在 hint 文本里做关键词高亮 ───────────────────
  //   m(txt)     → 标"关键值"（深黄底）：渠道/上游名、字段值
  //   k(txt)     → 标"字段名"（淡蓝底）：响应头名 / JSON 字段名
  //   s(txt)     → 加粗：判定结论里的核心动词/形容词
  //   e(txt)     → 仅 HTML 转义
  function e(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function m(s) { return '<mark class="hl-val">' + e(s) + '</mark>'; }
  function k(s) { return '<code class="hl-key">' + e(s) + '</code>'; }
  function st(s) { return '<strong>' + e(s) + '</strong>'; }

  function guessChannel(result, r, fp) {
    const hints = [];
    const id = r && r.id || '';
    const u = r && r.usage || {};
    const hdr = lowerKeys(result && result.respHeaders || {});
    const reqBody = (result && result.body) || {};
    const reqThinking = reqBody && reqBody.thinking;
    const askedForThinking = !!reqThinking && reqThinking.type;

    // ── id 形态 ─────────────────────────────────
    if (id.startsWith('msg_')) {
      hints.push({ level: 'signal', html: 'id 以 ' + k('msg_') + ' 开头：' + m('Anthropic Messages 协议') + '（官方 / Bedrock 透传 / Vertex 透传 / 兼容反代均可能）' });
    } else if (id.startsWith('chatcmpl-')) {
      hints.push({ level: 'warn', html: 'id 以 ' + k('chatcmpl-') + ' 开头：' + m('OpenAI 兼容层') + '（很可能不是 Claude 原生协议）' });
    } else if (id) {
      hints.push({ level: 'warn', html: 'id 形态非标准 (' + k(id.slice(0, 20) + '…') + ')：' + m('自建 / 魔改代理') });
    }

    // ── usage 字段形态 ───────────────────────────
    if ('cache_creation_input_tokens' in u || 'cache_read_input_tokens' in u) {
      hints.push({ level: 'signal', html: 'usage 含 ' + k('cache_creation_input_tokens') + ' / ' + k('cache_read_input_tokens') + '：' + m('Anthropic 原生计费结构') });
    } else if ('prompt_tokens' in u || 'completion_tokens' in u) {
      hints.push({ level: 'warn', html: 'usage 使用 ' + k('prompt_tokens') + ' / ' + k('completion_tokens') + '：' + m('OpenAI 风格，已被代理重写') });
    }
    if (u && u.cache_creation && (u.cache_creation.ephemeral_5m_input_tokens !== undefined || u.cache_creation.ephemeral_1h_input_tokens !== undefined)) {
      hints.push({ level: 'signal', html: 'usage.cache_creation 含 ' + k('ephemeral_5m') + ' / ' + k('ephemeral_1h') + '：' + m('Claude 4.x 细粒度缓存') });
    }
    if (u && u.service_tier) hints.push({ level: 'info', html: k('usage.service_tier') + '=' + m(u.service_tier) + '：Anthropic 原生字段' });
    if (u && u.inference_geo) hints.push({ level: 'info', html: k('usage.inference_geo') + '=' + m(u.inference_geo) + '：Anthropic 原生字段' });

    // ── 响应头 ──────────────────────────────────
    if (hdr['anthropic-organization-id']) {
      hints.push({ level: 'info', html: '响应头含 ' + k('anthropic-organization-id') + '：Anthropic 协议响应（' + m('多数反代会透传 / 仿造此头') + '）' });
    }
    if (hdr['request-id'] && /^req_/.test(hdr['request-id'])) {
      hints.push({ level: 'info', html: '响应头 ' + k('request-id') + ' 以 ' + k('req_') + ' 开头：Anthropic 协议风格（' + m('反代也会透传 / 仿造') + '）' });
    }
    if (hdr['anthropic-ratelimit-requests-limit']) {
      hints.push({ level: 'info', html: '响应头 ' + k('anthropic-ratelimit-*') + '：Anthropic 官方限速头透传' });
    }
    if (hdr['x-4router-version']) {
      hints.push({ level: 'strong', html: '响应头 ' + k('X-4router-Version') + '=' + m(hdr['x-4router-version']) + '：上游确认是 ' + m('4Router 中转') });
    }
    if (hdr['x-new-api-version']) {
      hints.push({ level: 'strong', html: '响应头 ' + k('X-New-Api-Version') + '=' + m(hdr['x-new-api-version']) + '：' + m('new-api / 衍生项目中转') });
    }
    if (hdr['x-oneapi-request-id']) {
      hints.push({ level: 'strong', html: '响应头 ' + k('X-Oneapi-Request-Id') + '：' + m('one-api / new-api 系中转') });
    }
    if (hdr['x-amzn-requestid'] || hdr['x-amzn-bedrock-input-token-count'] || (hdr['x-request-id'] || '').startsWith('aws_req_')) {
      hints.push({ level: 'strong', html: '出现 ' + k('x-amzn-*') + ' / ' + k('x-request-id=aws_req_…') + '：上游确认是 ' + m('AWS Bedrock') });
    }
    if (hdr['x-goog-request-id']) {
      hints.push({ level: 'strong', html: '响应头 ' + k('x-goog-request-id') + '：上游是 ' + m('Google Vertex AI') });
    }
    if (hdr['openai-organization'] || hdr['openai-version']) {
      hints.push({ level: 'strong', html: '响应头 ' + k('openai-*') + '：底层是 ' + m('OpenAI 渠道') });
    }
    if (hdr['cf-ray']) {
      hints.push({ level: 'info', html: '响应头 ' + k('cf-ray') + '=' + m(hdr['cf-ray']) + '：经过 ' + m('Cloudflare') });
    }
    if (hdr['server']) {
      hints.push({ level: 'info', html: k('Server') + '=' + m(hdr['server']) });
    }

    // ── tool_use 中的扩展字段 ──
    if (Array.isArray(r && r.content)) {
      const tu = r.content.find(b => b && b.type === 'tool_use' && b.caller);
      if (tu) {
        hints.push({ level: 'strong', html: 'tool_use 块含非标准 ' + k('caller') + ' 字段（' + m('4Router 等反代附加') + '）：' + k(JSON.stringify(tu.caller)) });
      }
    }

    // ── 上游 4xx/5xx 错误体（4Router 等会塞 {error:{type, message}}） ──
    if (result && !result.ok && r && r.error && r.error.message) {
      hints.unshift({
        level: 'verdict-warn',
        html: '⚠️ ' + st('上游错误') + '：' + k(r.error.type || '?') + ' → ' + m(r.error.message)
      });
    }

    // ── 思考模式（thinking）完整性判定 ───────────────────
    //  仅在响应本身是 200 时才做判定；非 200 时上面已经有"上游错误"那条 verdict-warn
    if (askedForThinking && result && result.ok) {
      const thinkBlocks = (fp && fp.thinking_blocks) || [];
      const hasSig = thinkBlocks.some(t => t.signature);
      const hasText = thinkBlocks.some(t => t.type === 'thinking' && t.textLen > 0);
      const hasRedacted = thinkBlocks.some(t => t.type === 'redacted_thinking');
      const reqDisplay = reqThinking.display || (reqThinking.type === 'adaptive' ? 'omitted-by-default-on-4-7' : 'summarized-by-default');

      if (!thinkBlocks.length) {
        hints.push({
          level: 'verdict-warn',
          html: '⚠️ 请求开了 ' + k('thinking.' + reqThinking.type) + '，但响应 ' + st('content[] 里完全没有 thinking 块') +
                '：' + m('反代静默丢弃了思考字段') + '（或上游模型不支持 thinking）。'
        });
      } else if (!hasSig) {
        hints.push({
          level: 'verdict-warn',
          html: '⚠️ thinking 块存在但 ' + st('signature 字段缺失') +
                '：' + m('反代可能仿造了 thinking 但没有真实签名') + '。' +
                '原生 Anthropic 一定带 base64 签名（数百字符）。'
        });
      } else {
        const longestSig = Math.max(...thinkBlocks.map(t => t.signatureLen));
        const totalText = thinkBlocks.reduce((s, t) => s + (t.textLen || 0), 0);
        if (longestSig < 50) {
          hints.push({
            level: 'warn',
            html: '⚠️ thinking signature 长度仅 ' + k(longestSig + '') + ' 字符，' +
                  m('明显短于原生形态（通常 ≥ 100）') + '：' + m('可能是反代伪造的占位签名')
          });
        } else if (hasText) {
          hints.push({
            level: 'strong',
            html: '✓ thinking 块完整：含 ' + k('signature') + '(' + m(longestSig + ' chars') +
                  ') + 正文 ' + m(totalText + ' chars') + '：' + st('原生 Claude 思考链路')
          });
        } else {
          // thinking 块存在、有真实签名，但 text 为空
          const isOpus47 = String(reqBody.model || '').includes('opus-4-7');
          const askedSummarized = reqThinking && reqThinking.display === 'summarized';
          if (isOpus47 && !askedSummarized) {
            hints.push({
              level: 'signal',
              html: 'thinking 块只回签名（' + k(longestSig + ' chars') + '），正文为空：' +
                    m('Opus 4.7 默认 display="omitted"') + '——本工具会自动加 display:"summarized"，若仍为空请重试。'
            });
          } else if (isOpus47 && askedSummarized) {
            hints.push({
              level: 'warn',
              html: '⚠️ 已请求 ' + k('display="summarized"') + '，但 Opus 4.7 仍只返回签名（' + k(longestSig + ' chars') + '）正文为空：' +
                    st('该渠道在 4.7 上未透出 summarized 正文') +
                    '（4Router 等反代在 4.7 路径上的常见行为；同一渠道的 ' + m('Sonnet/Opus 4.6') + ' 通常能拿到正文，建议跑"对照题"对比验证）。' +
                    '说明：' + m('上游 Bedrock 通道或反代实现') + ' 在 4.7 + summarized 组合上有差异，签名签验证仍有效。'
            });
          } else {
            hints.push({
              level: 'warn',
              html: '⚠️ thinking 块有签名（' + k(longestSig + ' chars') + '）但正文为空：' +
                    m('反代或上游剥离了思考正文') + '（4.6 系列原生默认应当有正文）'
            });
          }
        }
        if (hasRedacted) {
          hints.push({
            level: 'info',
            html: '含 ' + k('redacted_thinking') + ' 块（受策略加密，无法解码）：' + m('Anthropic 协议原生字段')
          });
        }
      }
    }

    // ── 综合判定 ────────────────────────────────
    const isAnthropicShape = id.startsWith('msg_') && ('cache_creation_input_tokens' in u);
    const strongUpstream =
        (hdr['x-amzn-requestid'] || (hdr['x-request-id'] || '').startsWith('aws_req_')) ? 'AWS Bedrock'
      : hdr['x-goog-request-id'] ? 'Google Vertex'
      : null;
    const strongProxy =
        hdr['x-4router-version'] ? '4Router'
      : hdr['x-new-api-version'] ? 'new-api 系'
      : hdr['x-oneapi-request-id'] ? 'one-api 系'
      : null;

    if (isAnthropicShape) {
      if (strongUpstream || strongProxy) {
        hints.unshift({
          level: 'verdict',
          html: '⮕ ' + st('综合判定') + '：上游 = ' + m(strongUpstream || '未知') +
                '；中转 = ' + m(strongProxy || '直连或未识别代理') +
                '（' + st('响应结构是真正的 Claude') + '）'
        });
      } else if (result && result.transport === 'direct') {
        hints.unshift({
          level: 'verdict',
          html: '⮕ ' + st('综合判定') + '：响应体是 ' + m('真正的 Claude') +
                '（Anthropic 协议 + ' + k('cache_*') + ' 字段齐全）。' +
                '但当前是 ' + m('浏览器直连模式') + '，' + st('只能拿到目标站允许公开的少数响应头') +
                '；无法据此区分"Anthropic 官方 / Bedrock / 4Router / new-api 等反代"。' +
                '想看到全部响应头：本机跑 ' + k('python server.py') + ' 后页面会自动改走中转，等同 curl。'
        });
      } else {
        hints.unshift({
          level: 'verdict',
          html: '⮕ ' + st('综合判定') + '：响应体是 ' + m('真正的 Claude') +
                '；已通过中转拿到完整响应头，' + st('未匹配到任何代理特征头') +
                '（' + k('X-4router-Version') + ' / ' + k('X-Amzn-Requestid') + ' / ' + k('X-New-Api-Version') + ' / ' + k('X-Oneapi-Request-Id') + ' 等）：' +
                '当前路径可能就是 ' + m('Anthropic 官方直连') + '，或代理已剥离自有头。'
        });
      }
    } else if (id.startsWith('chatcmpl-') || 'prompt_tokens' in u) {
      hints.unshift({
        level: 'verdict-warn',
        html: '⮕ ' + st('综合判定') + '：响应已被 ' + m('OpenAI 兼容层重写') +
              '，底层 ' + st('很可能不是 Claude') + '（或代理强转协议）'
      });
    }

    return hints.length ? hints : [{ level: 'info', html: '（暂无强信号 — 多跑几道题综合判定）' }];
  }

  function lowerKeys(obj) {
    const out = {};
    for (const k of Object.keys(obj)) out[k.toLowerCase()] = obj[k];
    return out;
  }

  // ============================================================
  //  把结果渲染进卡片
  // ============================================================
  function renderResultInto(card, question, result) {
    const fp = analyzeFingerprint(result);
    card.classList.remove('busy');
    card.classList.add(result.ok ? 'ok' : 'fail');
    card.classList.add('has-result');

    // 顶部 meta badges
    const metaRow = card.querySelector('.qcard-meta-row');
    const bits = [];
    if (result.status) {
      bits.push(`<span class="badge ${result.ok ? 'ok' : 'fail'}">HTTP ${result.status}</span>`);
    } else if (result.networkError) {
      bits.push(`<span class="badge fail">NETERR</span>`);
    }
    if (result.transport) {
      bits.push(`<span class="badge ${result.transport === 'proxy' ? 'ok' : ''}">${result.transport === 'proxy' ? 'via 本地中转' : 'via 浏览器直连'}</span>`);
    }
    if (fp.model) bits.push(`<span class="badge">model=${escapeHtml(fp.model)}</span>`);
    if (fp.id_prefix) bits.push(`<span class="badge info">id_prefix=${escapeHtml(fp.id_prefix)}</span>`);
    if (result.elapsedMs != null) bits.push(`<span class="badge">${result.elapsedMs} ms</span>`);
    metaRow.innerHTML = bits.join('');

    // 结果区
    const host = card.querySelector('.qcard-result');
    host.innerHTML = '';

    // 网络错误：放一个红色提示，仍保留请求体可看
    if (result.networkError) {
      const errBox = document.createElement('div');
      errBox.style.cssText = 'background:#fde7e7;border:1px solid #f0baba;color:#a01e1e;padding:8px 10px;border-radius:6px;font-size:12.5px;white-space:pre-wrap';
      errBox.textContent = result.message || '网络错误';
      host.appendChild(errBox);
    }

    // 模型思考过程（如果题目开了 thinking 或响应里出现了 thinking 块）
    if (Array.isArray(fp.thinking_blocks) && fp.thinking_blocks.length) {
      host.appendChild(makeSection('模型思考过程 (thinking)', true, (inner) => {
        for (const tk of fp.thinking_blocks) {
          const wrap = document.createElement('div');
          wrap.className = 'thinking-block';
          const tag = tk.type === 'redacted_thinking' ? '🔒 redacted_thinking（已加密，不可读）' : '🧠 thinking';
          const sigInfo = tk.signature
            ? `<span class="badge ok">signature ✓ (${tk.signatureLen} chars)</span>`
            : '<span class="badge fail">signature ✗ 缺失</span>';
          const lenInfo = `<span class="badge">正文 ${tk.textLen} chars</span>`;
          wrap.innerHTML =
            `<div class="thinking-head">${escapeHtml(tag)} ${lenInfo} ${sigInfo}</div>`;
          const txt = document.createElement('div');
          txt.className = 'thinking-text';
          if (tk.type === 'redacted_thinking') {
            txt.innerHTML = '<em>（此块加密：data=' + escapeHtml((tk.data || '').slice(0, 80)) + '…）</em>';
          } else if (tk.text) {
            txt.textContent = tk.text;
          } else {
            txt.innerHTML = '<em>正文为空 — 这是 Opus 4.7 默认 display="omitted" 的预期形态；或反代剥离了思考正文。' +
                            '本工具发请求时已自动 display:"summarized"，仍为空多半是反代行为。</em>';
          }
          wrap.appendChild(txt);
          if (tk.signature) {
            const sig = document.createElement('div');
            sig.className = 'thinking-sig';
            sig.innerHTML = '<span class="sig-label">signature</span> <code class="sig-val">' +
                            escapeHtml(tk.signature.slice(0, 200) + (tk.signature.length > 200 ? '…' : '')) + '</code>';
            wrap.appendChild(sig);
          }
          inner.appendChild(wrap);
        }
      }));
    }

    // 模型文本回答
    if (Array.isArray(fp.text_blocks) && fp.text_blocks.length) {
      host.appendChild(makeSection('模型文本回答', true, (inner) => {
        for (const t of fp.text_blocks) {
          const div = document.createElement('div');
          div.className = 'assistant-text';
          div.textContent = t || '(空)';
          inner.appendChild(div);
        }
      }));
    }

    // 工具调用
    if (Array.isArray(fp.tool_uses) && fp.tool_uses.length) {
      host.appendChild(makeSection('工具调用 (tool_use)', true, (inner) => {
        for (const tu of fp.tool_uses) {
          const kv = document.createElement('div');
          kv.className = 'kv-grid';
          let html = `
            <div class="k">tool name</div><div class="v">${escapeHtml(tu.name || '')}</div>
            <div class="k">tool id</div><div class="v"><span class="pill hl">${escapeHtml(tu.id || '')}</span></div>
            <div class="k">id prefix</div><div class="v"><span class="pill hl">${escapeHtml(tu.id_prefix || '')}</span></div>
            <div class="k">input</div><div class="v"><pre class="code" style="max-height:160px">${highlightJson(tu.input)}</pre></div>`;
          if (tu.caller !== undefined) {
            html += `<div class="k">caller（非标准 / 反代附加）</div><div class="v"><pre class="code" style="max-height:120px">${highlightJson(tu.caller)}</pre></div>`;
          }
          kv.innerHTML = html;
          inner.appendChild(kv);
        }
      }));
    }

    // 关键指纹 + 渠道猜测
    if (result.respJson) {
      host.appendChild(makeSection('关键指纹字段 & 渠道猜测', true, (inner) => {
        const kv = document.createElement('div');
        kv.className = 'kv-grid';
        kv.innerHTML = `
          <div class="k">message id</div><div class="v">${pill(fp.id, true)}</div>
          <div class="k">id 前缀</div><div class="v">${pill(fp.id_prefix, true)}</div>
          <div class="k">model</div><div class="v">${pill(fp.model, true)}</div>
          <div class="k">stop_reason</div><div class="v">${pill(fp.stop_reason)}</div>
          <div class="k">usage</div><div class="v"><pre class="code" style="max-height:140px">${highlightJson(fp.usage)}</pre></div>
          <div class="k">渠道猜测</div><div class="v"><ul class="guess-list">${
            (fp.channel_guess || []).map(t => {
              if (typeof t === 'string') return '<li class="guess-info">' + escapeHtml(t) + '</li>';
              const lvl = t.level || 'info';
              // html 字段在 guessChannel 内已自行 escape + 包裹 mark/code/strong
              return '<li class="guess-' + escapeHtml(lvl) + '">' + (t.html || '') + '</li>';
            }).join('')
          }</ul></div>`;
        inner.appendChild(kv);
      }));
    }

    // 响应头
    const hdrTitle = result.transport === 'proxy'
      ? '响应头（完整，via 本地中转）'
      : '响应头（浏览器可见部分，受目标站白名单限制）';
    host.appendChild(makeSection(hdrTitle, false, (inner) => {
      if (!result.respHeaders || !Object.keys(result.respHeaders).length) {
        inner.innerHTML = '<div style="color:var(--text-mute);font-size:12.5px">无响应头（可能是网络错误，或目标站没有公开这些头给浏览器）</div>';
        return;
      }
      inner.appendChild(makeJsonBlock(result.respHeaders));
    }));

    // 完整请求体
    host.appendChild(makeSection('完整请求体（JSON）', false, (inner) => {
      const tb = document.createElement('div');
      tb.className = 'section-toolbar';
      tb.innerHTML = `<button type="button" data-act="copy-body">复制 body</button>
                      <button type="button" data-act="copy-curl">复制为 curl</button>
                      <span class="hint">POST ${escapeHtml(result.endpoint)}</span>`;
      inner.appendChild(tb);
      inner.appendChild(makeJsonBlock(result.body));
      tb.querySelector('[data-act=copy-body]').addEventListener('click', () => copyText(JSON.stringify(result.body, null, 2)));
      tb.querySelector('[data-act=copy-curl]').addEventListener('click', () => copyText(toCurl(result)));
    }));

    // 原始响应体
    host.appendChild(makeSection('原始响应体（JSON / 文本）', false, (inner) => {
      if (result.respJson) inner.appendChild(makeJsonBlock(result.respJson));
      else if (result.respText) {
        const pre = document.createElement('pre');
        pre.className = 'code';
        pre.textContent = result.respText;
        inner.appendChild(pre);
      } else {
        inner.appendChild(document.createTextNode('(空)'));
      }
    }));
  }

  function getUserPreview(q) {
    if (typeof q.user === 'string') return q.user;
    if (Array.isArray(q.messages)) {
      try {
        return q.messages.map(m => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');
      } catch (e) { return JSON.stringify(q.messages); }
    }
    return '(无)';
  }
  function pill(v, hl) {
    if (v === undefined || v === null || v === '') return '<span class="pill">(无)</span>';
    return `<span class="pill ${hl ? 'hl' : ''}">${escapeHtml(String(v))}</span>`;
  }
  function makeSection(title, open, fillFn) {
    const det = document.createElement('details');
    det.className = 'result-section';
    if (open) det.open = true;
    const sum = document.createElement('summary');
    sum.textContent = title;
    det.appendChild(sum);
    const inner = document.createElement('div');
    inner.className = 'section-inner';
    fillFn(inner);
    det.appendChild(inner);
    return det;
  }
  function makeJsonBlock(obj) {
    const pre = document.createElement('pre');
    pre.className = 'code';
    pre.innerHTML = highlightJson(obj);
    return pre;
  }

  function highlightJson(value) {
    let s;
    try { s = JSON.stringify(value, null, 2); } catch (e) { s = String(value); }
    if (s === undefined) s = 'undefined';
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return s.replace(
      /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
      (m, key, str, bool, num) => {
        if (key) return '<span class="k">' + key + '</span>';
        if (str) return '<span class="s">' + str + '</span>';
        if (bool) return bool === 'null' ? '<span class="null">' + bool + '</span>' : '<span class="b">' + bool + '</span>';
        if (num) return '<span class="n">' + num + '</span>';
        return m;
      }
    );
  }

  // ============================================================
  //  复制 / 导出
  // ============================================================
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(
        () => flashStatus('已复制到剪贴板', 'done'),
        () => fallbackCopy(t));
    } else fallbackCopy(t);
  }
  function fallbackCopy(t) {
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); flashStatus('已复制（fallback）', 'done'); }
    catch (e) { flashStatus('复制失败', 'error'); }
    document.body.removeChild(ta);
  }
  function toCurl(result) {
    const lines = ['curl -X POST ' + shellQuote(result.endpoint), '  -H ' + shellQuote('Content-Type: application/json')];
    const hdrs = result.headers || {};
    for (const k of Object.keys(hdrs)) {
      if (k === 'Content-Type') continue;
      lines.push('  -H ' + shellQuote(`${k}: ${hdrs[k]}`));
    }
    lines.push('  -d ' + shellQuote(JSON.stringify(result.body)));
    return lines.join(' \\\n');
  }
  function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

  // ============================================================
  //  小工具
  // ============================================================
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }
  function flashStatus(msg, cls) {
    $runStatus.textContent = msg;
    $runStatus.className = 'run-status ' + (cls || '');
    if (cls === 'done' || cls === 'error') {
      setTimeout(() => { $runStatus.textContent = '就绪'; $runStatus.className = 'run-status'; }, 2200);
    }
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ============================================================
  //  运行：单卡 / 全部
  // ============================================================
  async function runOneQuestion(question, card) {
    if (batchRunning) {
      flashStatus('批量运行中，请稍候或先停止', 'error');
      return;
    }
    const cfg = readCfg();
    if (!cfg.apiKey) {
      if (!confirm('未填写 API Key，仍要继续吗？（多数渠道会直接 401）')) return;
    }
    saveConfigIfRequested();
    stopFlag = false;
    activeSingleRuns++;
    refreshControls();
    setCardBusy(card, true);
    toggleCard(card, true);

    flashStatus(`运行中：${question.name}`, 'running');
    let result;
    try { result = await callOnce(question, cfg); }
    catch (e) { result = { ok: false, networkError: true, transport: pickTransport(cfg), message: '未捕获错误: ' + e.message, endpoint: '', headers: {}, body: {}, elapsedMs: 0 }; }
    renderResultInto(card, question, result);
    setCardBusy(card, false);
    flashStatus(result.ok ? `完成：${question.name}` : `失败：${question.name}`, result.ok ? 'done' : 'error');

    activeSingleRuns--;
    refreshControls();
  }

  async function runAllQuestions() {
    const qs = [...window.QUESTIONS];
    if (!qs.length) { flashStatus('题库为空', 'error'); return; }
    const cfg = readCfg();
    if (!cfg.apiKey) {
      if (!confirm('未填写 API Key，仍要继续吗？（多数渠道会直接 401）')) return;
    }
    saveConfigIfRequested();
    stopFlag = false;
    batchRunning = true;
    refreshControls();

    const total = qs.length;
    const concurrency = Math.max(1, Math.min(20, parseInt($optConcurrency.value, 10) || 1));
    let nextIdx = 0;
    let completed = 0;
    let inflight = 0;

    function tickStatus(currentName) {
      const label = currentName ? ` · 当前 ${currentName}` : '';
      flashStatus(`运行中 ${completed}/${total}（并发 ${inflight}/${concurrency}）${label}`, 'running');
    }

    async function worker() {
      while (!stopFlag) {
        const idx = nextIdx++;
        if (idx >= qs.length) return;
        const q = qs[idx];
        const card = cardFor(q.id);
        if (!card) { completed++; tickStatus(); continue; }

        inflight++;
        setCardBusy(card, true);
        toggleCard(card, true);
        tickStatus(q.name);

        let result;
        try { result = await callOnce(q, cfg); }
        catch (e) { result = { ok: false, networkError: true, transport: pickTransport(cfg), message: '未捕获错误: ' + e.message, endpoint: '', headers: {}, body: {}, elapsedMs: 0 }; }
        renderResultInto(card, q, result);
        setCardBusy(card, false);

        if ($optCollapseAfter && $optCollapseAfter.checked && result.ok) toggleCard(card, false);

        inflight--;
        completed++;
        tickStatus();

        // 题间延迟仅在 worker 自己的相邻两题之间生效（不阻塞其它 worker）
        if (!stopFlag && cfg.delay > 0 && nextIdx < qs.length) await sleep(cfg.delay);
      }
    }

    const workerCount = Math.min(concurrency, qs.length);
    const workers = [];
    for (let i = 0; i < workerCount; i++) workers.push(worker());
    await Promise.all(workers);

    batchRunning = false;
    refreshControls();
    if (stopFlag) flashStatus(`已停止（完成 ${completed}/${total}）`, 'error');
    else flashStatus(`完成 ${total} 题`, 'done');
  }

  function setCardBusy(card, busy) {
    card.classList.toggle('busy', busy);
    const runBtn = card.querySelector('.qcard-run');
    runBtn.disabled = busy || batchRunning;
    runBtn.classList.toggle('running', busy);
    runBtn.innerHTML = busy ? '<span class="busy-spinner"></span>运行中' : '▶ 运行';
  }

  // 根据 batchRunning / activeSingleRuns 状态刷新批量控件可点击性
  function refreshControls() {
    const anyRunning = batchRunning || activeSingleRuns > 0;
    el('run-all').disabled = anyRunning;
    $stop.disabled = !anyRunning;
    $qgrid.querySelectorAll('.qcard-run').forEach(b => {
      const cardBusy = b.classList.contains('running');
      if (batchRunning) { b.disabled = true; }
      else { b.disabled = cardBusy; }
    });
  }

  function cardFor(qid) {
    return $qgrid.querySelector(`.qcard[data-qid="${cssEscape(qid)}"]`);
  }
  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c);
  }

  function clearAllResults() {
    $qgrid.querySelectorAll('.qcard').forEach(card => {
      card.classList.remove('ok', 'fail', 'busy', 'has-result');
      const meta = card.querySelector('.qcard-meta-row');
      if (meta) meta.innerHTML = '';
      const host = card.querySelector('.qcard-result');
      if (host) host.innerHTML = '';
      toggleCard(card, false);
    });
    flashStatus('已清空', 'done');
  }

  function exportResults() {
    const cards = [...$qgrid.querySelectorAll('.qcard.has-result')];
    if (!cards.length) { flashStatus('无结果可导出', 'error'); return; }
    const data = cards.map(c => ({
      id: c.dataset.qid,
      name: c.querySelector('.qcard-name')?.textContent,
      category: c.dataset.category,
      state: c.classList.contains('ok') ? 'ok' : c.classList.contains('fail') ? 'fail' : 'unknown',
      meta_text: c.querySelector('.qcard-meta-row')?.textContent.trim().replace(/\s+/g, ' ')
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `claude-probe-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
    flashStatus('已导出', 'done');
  }

  function expandAll() { $qgrid.querySelectorAll('.qcard').forEach(c => toggleCard(c, true)); }
  function collapseAll() { $qgrid.querySelectorAll('.qcard').forEach(c => toggleCard(c, false)); }
  function applyCategoryFilter() {
    const sel = $filterCategory.value;
    $qgrid.querySelectorAll('.qcard').forEach(c => {
      c.classList.toggle('hidden-by-filter', sel && c.dataset.category !== sel);
    });
  }

  // ============================================================
  //  配置读取 / 预设
  // ============================================================
  function readCfg() {
    return {
      preset: $cfg.preset ? $cfg.preset.value : 'proxy',
      baseUrl: $cfg.baseUrl.value.trim(),
      apiKey: $cfg.apiKey.value.trim(),
      model: $cfg.model.value.trim() || 'claude-opus-4-7',
      version: $cfg.version.value.trim(),
      authMode: $cfg.authMode.value,
      transport: $cfg.transport ? $cfg.transport.value : 'auto',
      dangerousBrowser: !!$cfg.dangerousBrowser.checked,
      impersonateCc: !!($cfg.impersonateCc && $cfg.impersonateCc.checked),
      maxTokens: parseInt($cfg.maxTokens.value, 10) || 1024,
      delay: parseInt($cfg.delay.value, 10) || 0,
      timeout: parseInt($cfg.timeout.value, 10) || 600000,
      extraHeaders: $cfg.extraHeaders.value,
      system: $cfg.system.value
    };
  }
  const PRESETS = {
    'proxy':         { baseUrl: 'https://4Router.net',     authMode: 'bearer',    version: '',           dangerousBrowser: false },
    'anthropic':     { baseUrl: 'https://api.anthropic.com', authMode: 'x-api-key', version: '2023-06-01', dangerousBrowser: true  },
    'openai-compat': { baseUrl: 'https://api.openai.com',  authMode: 'bearer',    version: '',           dangerousBrowser: false },
    'custom': null
  };
  function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    $cfg.baseUrl.value = p.baseUrl;
    $cfg.authMode.value = p.authMode;
    $cfg.version.value = p.version;
    $cfg.dangerousBrowser.checked = p.dangerousBrowser;
  }

  // ============================================================
  //  事件绑定 / 启动
  // ============================================================
  function bindEvents() {
    el('run-all').addEventListener('click', runAllQuestions);
    $stop.addEventListener('click', () => {
      stopFlag = true;
      for (const c of inflightCtls) {
        try { c.abort(); } catch (e) { /* ignore */ }
      }
      inflightCtls.clear();
    });
    el('clear-results').addEventListener('click', clearAllResults);
    el('export-results').addEventListener('click', exportResults);

    el('expand-all').addEventListener('click', expandAll);
    el('collapse-all').addEventListener('click', collapseAll);
    if ($filterCategory) $filterCategory.addEventListener('change', applyCategoryFilter);

    el('toggle-config').addEventListener('click', () =>
      el('config-panel').classList.toggle('collapsed'));

    $cfg.preset.addEventListener('change', () => applyPreset($cfg.preset.value));
  }

  function boot() {
    if (!window.QUESTIONS || !Array.isArray(window.QUESTIONS)) {
      $qgrid.innerHTML = '<div style="color:var(--danger)">questions.js 未加载或未定义 QUESTIONS</div>';
      return;
    }
    renderQuestions();
    loadSavedConfig();
    bindEvents();
    detectProxy();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
