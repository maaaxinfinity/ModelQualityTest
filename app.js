/* global QUESTIONS */
(function () {
  'use strict';

  const GROUPS = ['OpenAI', 'Anthropic', 'Google', 'Sakana', 'Image'];
  const DEFAULTS = {
    OpenAI: { baseUrl: 'https://api.openai.com', model: 'gpt-5.5', authMode: 'bearer' },
    Anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-4.8', authMode: 'x-api-key' },
    Google: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-3.1-pro-preview', authMode: 'x-api-key' },
    Sakana: { baseUrl: 'https://api.sakana.ai', model: 'fugu-ultra', authMode: 'bearer' },
    Image: { baseUrl: 'https://api.openai.com', model: 'gpt-image-2', authMode: 'bearer' }
  };

  const el = (id) => document.getElementById(id);
  const $cfg = {
    group: el('cfg-group'),
    baseUrl: el('cfg-baseUrl'),
    apiKey: el('cfg-apiKey'),
    model: el('cfg-model'),
    authMode: el('cfg-authMode'),
    maxTokens: el('cfg-maxTokens'),
    timeout: el('cfg-timeout'),
    delay: el('cfg-delay'),
    system: el('cfg-system'),
    remember: el('cfg-remember'),
    imageN: el('cfg-image-n'),
    imageQuality: el('cfg-image-quality'),
    imageSize: el('cfg-image-size')
  };
  const $qgrid = el('qgrid');
  const $qCount = el('q-count');
  const $filterCategory = el('filter-category');
  const $runStatus = el('run-status');
  const $authStatus = el('auth-status');
  const $authCurrent = el('auth-current');
  const $authFlow = el('auth-flow');
  const $adminBox = el('admin-box');
  const $adminOutput = el('admin-output');
  const $optCollapseAfter = el('opt-collapse-after');
  const $optConcurrency = el('opt-concurrency');
  const $stop = el('stop');

  const resultsById = new Map();
  const inflight = new Set();
  let activeGroup = 'OpenAI';
  let sessionUser = null;
  let stopFlag = false;
  let batchRunning = false;

  const LS_PREFIX = 'mqt.config.';

  function boot() {
    if (!Array.isArray(window.QUESTIONS)) {
      $qgrid.innerHTML = '<div style="color:var(--danger)">questions.js 未加载或未定义 QUESTIONS</div>';
      return;
    }
    buildGroupTabs();
    bindEvents();
    applyGroup('OpenAI', true);
    loadGroupConfig();
    renderQuestions();
    refreshAuth();
  }

  function buildGroupTabs() {
    const host = el('group-tabs');
    host.innerHTML = '';
    for (const group of GROUPS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'group-tab';
      btn.dataset.group = group;
      btn.textContent = `${group} (${questionsForGroup(group).length})`;
      btn.addEventListener('click', () => applyGroup(group));
      host.appendChild(btn);
    }
  }

  function bindEvents() {
    $cfg.group.addEventListener('change', () => applyGroup($cfg.group.value));
    el('toggle-config').addEventListener('click', () => el('config-panel').classList.toggle('collapsed'));
    el('run-all').addEventListener('click', runCurrentGroup);
    $stop.addEventListener('click', stopRuns);
    el('clear-results').addEventListener('click', clearResults);
    el('export-results').addEventListener('click', exportLocalResults);
    el('expand-all').addEventListener('click', () => cards().forEach((c) => toggleCard(c, true)));
    el('collapse-all').addEventListener('click', () => cards().forEach((c) => toggleCard(c, false)));
    $filterCategory.addEventListener('change', applyCategoryFilter);
    el('create-invite').addEventListener('click', createInvite);
    el('system-status').addEventListener('click', systemStatus);
    el('sync-prices').addEventListener('click', syncPrices);
    el('refresh-logs').addEventListener('click', refreshLogs);
    el('export-logs').addEventListener('click', () => { window.location.href = '/api/admin/logs?format=csv&limit=1000'; });
    for (const node of Object.values($cfg)) {
      if (!node || node === $cfg.group) continue;
      node.addEventListener('change', saveGroupConfig);
    }
  }

  function applyGroup(group, silent) {
    activeGroup = group;
    $cfg.group.value = group;
    loadGroupConfig();
    document.body.dataset.group = group;
    document.querySelectorAll('.group-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.group === group);
    });
    document.querySelectorAll('.image-only').forEach((node) => {
      node.style.display = group === 'Image' ? '' : 'none';
    });
    renderQuestions();
    if (!silent) flashStatus(group, 'done');
  }

  function defaultConfig(group) {
    return Object.assign({
      maxTokens: 1024,
      timeout: 120000,
      delay: 300,
      system: '',
      imageN: 1,
      imageQuality: 'medium',
      imageSize: '1024x1024'
    }, DEFAULTS[group]);
  }

  function loadGroupConfig() {
    const defaults = defaultConfig(activeGroup);
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(LS_PREFIX + activeGroup) || '{}');
    } catch (e) {
      saved = {};
    }
    const cfg = Object.assign({}, defaults, saved);
    $cfg.baseUrl.value = cfg.baseUrl || defaults.baseUrl;
    $cfg.apiKey.value = cfg.apiKey || '';
    $cfg.model.value = cfg.model || defaults.model;
    $cfg.authMode.value = cfg.authMode || defaults.authMode;
    $cfg.maxTokens.value = cfg.maxTokens || 1024;
    $cfg.timeout.value = cfg.timeout || 120000;
    $cfg.delay.value = cfg.delay || 300;
    $cfg.system.value = cfg.system || '';
    $cfg.imageN.value = cfg.imageN || 1;
    $cfg.imageQuality.value = cfg.imageQuality || 'medium';
    $cfg.imageSize.value = cfg.imageSize || '1024x1024';
    $cfg.remember.checked = !!cfg.remember;
  }

  function saveGroupConfig() {
    if (!$cfg.remember.checked) {
      localStorage.removeItem(LS_PREFIX + activeGroup);
      return;
    }
    localStorage.setItem(LS_PREFIX + activeGroup, JSON.stringify(readCfg(true)));
  }

  function readCfg(includeRemember) {
    const cfg = {
      group: activeGroup,
      baseUrl: $cfg.baseUrl.value.trim(),
      apiKey: $cfg.apiKey.value.trim(),
      model: $cfg.model.value.trim() || DEFAULTS[activeGroup].model,
      authMode: $cfg.authMode.value,
      maxTokens: Number($cfg.maxTokens.value || 1024),
      timeout: Number($cfg.timeout.value || 120000),
      delay: Number($cfg.delay.value || 0),
      system: $cfg.system.value,
      image: {
        n: Number($cfg.imageN.value || 1),
        quality: $cfg.imageQuality.value,
        size: $cfg.imageSize.value.trim() || '1024x1024'
      }
    };
    if (includeRemember) {
      cfg.remember = $cfg.remember.checked;
      cfg.imageN = cfg.image.n;
      cfg.imageQuality = cfg.image.quality;
      cfg.imageSize = cfg.image.size;
    }
    return cfg;
  }

  function questionsForGroup(group) {
    return window.QUESTIONS.filter((q) => q.group === group);
  }

  function renderQuestions() {
    $qgrid.innerHTML = '';
    const qs = questionsForGroup(activeGroup);
    const cats = new Set();
    for (const q of qs) {
      cats.add(q.category);
      $qgrid.appendChild(buildCard(q));
    }
    $qCount.textContent = String(qs.length);
    $filterCategory.innerHTML = '<option value="">全部分类</option>' +
      [...cats].map((cat) => `<option value="${escapeAttr(cat)}">${escapeHtml(cat)}</option>`).join('');
  }

  function buildCard(q) {
    const card = document.createElement('div');
    card.className = 'qcard';
    card.dataset.qid = q.id;
    card.dataset.category = q.category || '';
    card.innerHTML = `
      <div class="qcard-head">
        <span class="tag">${escapeHtml(q.group)}</span>
        <span class="tag subtle">${escapeHtml(q.category || '')}</span>
        <span class="qcard-name">${escapeHtml(q.name || q.id)}</span>
        <div class="qcard-actions">
          <button type="button" class="qcard-run">▶ 运行</button>
          <button type="button" class="qcard-expand">▾</button>
        </div>
      </div>
      <div class="qcard-meta-row"></div>
      <div class="qcard-body"></div>`;
    const head = card.querySelector('.qcard-head');
    head.addEventListener('click', (e) => {
      if (!e.target.closest('button')) toggleCard(card);
    });
    card.querySelector('.qcard-expand').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCard(card);
    });
    card.querySelector('.qcard-run').addEventListener('click', (e) => {
      e.stopPropagation();
      runOne(q, card);
    });
    return card;
  }

  function ensureBody(card) {
    const body = card.querySelector('.qcard-body');
    if (body.dataset.ready === '1') return;
    const q = window.QUESTIONS.find((item) => item.id === card.dataset.qid);
    body.appendChild(makeSection('Prompt', true, (inner) => {
      const prompt = document.createElement('div');
      prompt.className = 'userprompt-box';
      prompt.textContent = previewQuestion(q);
      inner.appendChild(prompt);
    }));
    const result = document.createElement('div');
    result.className = 'qcard-result';
    body.appendChild(result);
    body.dataset.ready = '1';
  }

  function previewQuestion(q) {
    if (q.prompt) return q.prompt;
    if (q.user) return q.user;
    if (Array.isArray(q.messages)) return q.messages.map((m) => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');
    return '(empty)';
  }

  function toggleCard(card, force) {
    const open = force === true ? true : force === false ? false : !card.classList.contains('expanded');
    card.classList.toggle('expanded', open);
    card.querySelector('.qcard-expand').textContent = open ? '▴' : '▾';
    if (open) ensureBody(card);
  }

  async function api(path, options) {
    const resp = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {}));
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = { raw: text }; }
    if (!resp.ok) {
      const err = new Error((json && (json.error || json.detail)) || resp.statusText);
      err.status = resp.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  async function refreshAuth() {
    try {
      const status = await api('/api/auth/status', { method: 'GET', headers: {} });
      sessionUser = status.user;
      renderAuth(status);
    } catch (e) {
      $authStatus.textContent = '认证服务不可用';
      $authCurrent.textContent = e.message;
    }
  }

  function renderAuth(status) {
    $authStatus.textContent = status.user ? status.user.displayName : '未登录';
    document.body.classList.toggle('app-locked', !status.user);
    document.body.classList.toggle('authed', !!status.user);
    $adminBox.hidden = !(status.user && status.user.role === 'admin');
    if (status.user) {
      $authCurrent.innerHTML = `
        <div class="section-title">Session</div>
        <div>${escapeHtml(status.user.displayName)} · ${escapeHtml(status.user.role)}</div>
        <button type="button" id="logout">退出登录</button>`;
      el('logout').addEventListener('click', async () => {
        await api('/api/auth/logout', { method: 'POST', body: '{}' });
        sessionUser = null;
        refreshAuth();
      });
      $authFlow.innerHTML = '<div class="section-title">Admin</div>';
      if (status.insecureDevSecret) {
        $authFlow.innerHTML += '<div class="warn-box">SESSION_SECRET</div>';
      }
      return;
    }
    $authCurrent.innerHTML = '<div class="section-title">Session</div><div>—</div>';
    $authFlow.innerHTML = `
      <div class="section-title">${status.setupRequired ? 'Setup' : 'Login'}</div>
      <div class="auth-form">
        <input id="auth-name" type="text" placeholder="显示名 / 登录名" />
        <input id="auth-token" type="text" inputmode="numeric" placeholder="TOTP 6 位验证码（登录用）" />
        <button id="login-btn" type="button">登录</button>
      </div>
      <div class="auth-form">
        <input id="invite-code" type="text" placeholder="邀请码" />
        <button id="start-enroll" type="button">开始绑定 TOTP</button>
      </div>
      <div id="enroll-output" class="mini-log"></div>`;
    el('login-btn').addEventListener('click', login);
    el('start-enroll').addEventListener('click', startEnroll);
  }

  async function login() {
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          displayName: el('auth-name').value,
          token: el('auth-token').value
        })
      });
      sessionUser = data.user;
      refreshAuth();
    } catch (e) {
      el('enroll-output').textContent = `登录失败：${e.message}`;
    }
  }

  async function startEnroll() {
    const out = el('enroll-output');
    try {
      const data = await api('/api/auth/enroll', {
        method: 'POST',
        body: JSON.stringify({
          displayName: el('auth-name').value,
          inviteCode: el('invite-code').value
        })
      });
      out.innerHTML = `
        <div>Secret：<code>${escapeHtml(data.secret)}</code></div>
        <pre class="code">${escapeHtml(data.otpauthUrl)}</pre>
        <div class="auth-form">
          <input id="enroll-token" type="text" inputmode="numeric" placeholder="TOTP 6 位验证码" />
          <button id="finish-enroll" type="button">完成注册</button>
        </div>`;
      el('finish-enroll').addEventListener('click', async () => {
        try {
          await api('/api/auth/enroll', {
            method: 'POST',
            body: JSON.stringify({ enrollmentId: data.enrollmentId, token: el('enroll-token').value })
          });
          refreshAuth();
        } catch (e) {
          out.innerHTML += `<div class="warn-box">注册失败：${escapeHtml(e.message)}</div>`;
        }
      });
    } catch (e) {
      out.textContent = `注册初始化失败：${e.message}`;
    }
  }

  async function createInvite() {
    try {
      const data = await api('/api/admin/invites', { method: 'POST', body: JSON.stringify({ maxUses: 1, expiresHours: 168 }) });
      $adminOutput.innerHTML = `<div>邀请码：<code>${escapeHtml(data.code)}</code>，7 天有效。</div>`;
      await refreshLogs();
    } catch (e) {
      $adminOutput.textContent = `生成失败：${e.message}`;
    }
  }

  async function systemStatus() {
    try {
      const data = await api('/api/admin/system', { method: 'GET', headers: {} });
      $adminOutput.innerHTML = `<pre class="code">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
    } catch (e) {
      $adminOutput.textContent = `系统状态读取失败：${e.message}`;
    }
  }

  async function syncPrices() {
    try {
      $adminOutput.textContent = 'Syncing...';
      const data = await api('/api/admin/prices', { method: 'POST', body: '{}' });
      const sync = data.sync || {};
      const pricing = data.pricing || {};
      $adminOutput.innerHTML = `
        <div>已同步 ${escapeHtml(sync.syncedRows || 0)} 行。</div>
        <div>${escapeHtml((sync.sourceProviders || []).join(', '))}</div>
        <pre class="code">${escapeHtml(JSON.stringify(pricing.groups || [], null, 2))}</pre>`;
    } catch (e) {
      $adminOutput.textContent = `价格同步失败：${e.message}`;
    }
  }

  async function refreshLogs() {
    try {
      const data = await api(`/api/admin/logs?limit=20${activeGroup ? `&group=${encodeURIComponent(activeGroup)}` : ''}`, { method: 'GET', headers: {} });
      $adminOutput.innerHTML = renderLogTable(data.logs || []);
    } catch (e) {
      $adminOutput.textContent = `日志读取失败：${e.message}`;
    }
  }

  function renderLogTable(logs) {
    if (!logs.length) return '<div class="empty-state">—</div>';
    return `<table class="log-table"><thead><tr><th>时间</th><th>题目</th><th>模型</th><th>状态</th><th>成本</th></tr></thead><tbody>${
      logs.map((r) => `<tr><td>${escapeHtml(new Date(r.created_at).toLocaleString())}</td><td>${escapeHtml(r.question_id)}</td><td>${escapeHtml(r.routed_model_id || r.model_id)}</td><td>${r.ok ? 'OK' : 'FAIL'} ${escapeHtml(r.response_status || '')}</td><td>${formatCost(r.estimated_cost_usd)}</td></tr>`).join('')
    }</tbody></table>`;
  }

  async function runOne(q, card) {
    if (!sessionUser) {
      flashStatus('Auth required', 'error');
      return;
    }
    const cfg = readCfg(false);
    if (!cfg.apiKey) {
      flashStatus('API Key required', 'error');
      return;
    }
    saveGroupConfig();
    stopFlag = false;
    setCardBusy(card, true);
    toggleCard(card, true);
    const controller = new AbortController();
    inflight.add(controller);
    try {
      flashStatus(`运行中：${q.name}`, 'running');
      const data = await fetch('/api/run-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, cfg, batchId: makeBatchId() }),
        signal: controller.signal
      }).then(async (resp) => {
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(json.error || json.detail || resp.statusText);
        return json;
      });
      resultsById.set(q.id, data.result);
      renderResult(card, data.result);
      flashStatus(data.result.ok ? `完成：${q.name}` : `失败：${q.name}`, data.result.ok ? 'done' : 'error');
    } catch (e) {
      renderResult(card, { ok: false, error_message: e.message, question_id: q.id, question_name: q.name, model_group: q.group });
      flashStatus(`失败：${e.message}`, 'error');
    } finally {
      inflight.delete(controller);
      setCardBusy(card, false);
      refreshControls();
    }
  }

  async function runCurrentGroup() {
    if (batchRunning) return;
    if (!sessionUser) return flashStatus('Auth required', 'error');
    const cfg = readCfg(false);
    if (!cfg.apiKey) return flashStatus('API Key required', 'error');
    saveGroupConfig();
    stopFlag = false;
    batchRunning = true;
    refreshControls();
    const qs = questionsForGroup(activeGroup).filter((q) => !isHiddenByFilter(q));
    const total = qs.length;
    let next = 0;
    let done = 0;
    const concurrency = Math.max(1, Math.min(20, Number($optConcurrency.value || 1)));
    const batchId = makeBatchId();
    async function worker() {
      while (!stopFlag) {
        const idx = next++;
        if (idx >= qs.length) return;
        const q = qs[idx];
        const card = cardFor(q.id);
        if (!card) continue;
        setCardBusy(card, true);
        toggleCard(card, true);
        flashStatus(`运行中 ${done}/${total} · ${q.name}`, 'running');
        const controller = new AbortController();
        inflight.add(controller);
        try {
          const data = await fetch('/api/run-test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: q, cfg, batchId }),
            signal: controller.signal
          }).then(async (resp) => {
            const json = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(json.error || json.detail || resp.statusText);
            return json;
          });
          resultsById.set(q.id, data.result);
          renderResult(card, data.result);
          if ($optCollapseAfter.checked && data.result.ok) toggleCard(card, false);
        } catch (e) {
          renderResult(card, { ok: false, error_message: e.message, question_id: q.id, question_name: q.name, model_group: q.group });
        } finally {
          inflight.delete(controller);
          setCardBusy(card, false);
          done++;
          flashStatus(`运行中 ${done}/${total}`, 'running');
          if (!stopFlag && cfg.delay > 0) await sleep(cfg.delay);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
    batchRunning = false;
    refreshControls();
    flashStatus(stopFlag ? `已停止 ${done}/${total}` : `完成 ${done}/${total}`, stopFlag ? 'error' : 'done');
    if ($adminBox && !$adminBox.hidden) refreshLogs();
  }

  function renderResult(card, result) {
    card.classList.remove('ok', 'fail');
    card.classList.add(result.ok ? 'ok' : 'fail', 'has-result');
    const meta = card.querySelector('.qcard-meta-row');
    meta.innerHTML = [
      badge(result.ok ? 'OK' : 'FAIL', result.ok ? 'ok' : 'fail'),
      result.response_status ? badge(`HTTP ${result.response_status}`) : '',
      result.routed_model_id || result.model_id ? badge(`model=${escapeHtml(result.routed_model_id || result.model_id)}`) : '',
      result.elapsed_ms != null ? badge(`${result.elapsed_ms} ms`) : '',
      result.estimated_cost_usd != null ? badge(`$${formatCost(result.estimated_cost_usd)}`, 'info') : ''
    ].filter(Boolean).join('');
    const host = card.querySelector('.qcard-result');
    host.innerHTML = '';
    if (result.error_message) {
      const div = document.createElement('div');
      div.className = 'warn-box';
      div.textContent = result.error_message;
      host.appendChild(div);
    }
    host.appendChild(makeSection('Summary', true, (inner) => {
      inner.appendChild(makeJsonBlock({
        id: result.id,
        batch_id: result.batch_id,
        group: result.model_group,
        provider: result.provider,
        endpoint_type: result.endpoint_type,
        model_id: result.model_id,
        routed_model_id: result.routed_model_id,
        ok: result.ok,
        status: result.response_status,
        elapsed_ms: result.elapsed_ms,
        usage: result.usage_json,
        estimated_cost_usd: result.estimated_cost_usd,
        cost_source: result.cost_source
      }));
    }));
    host.appendChild(makeSection('Response', false, (inner) => inner.appendChild(makeJsonBlock(result.response_body || {}))));
    host.appendChild(makeSection('Request', false, (inner) => inner.appendChild(makeJsonBlock(result.request_body || {}))));
    host.appendChild(makeSection('Headers', false, (inner) => inner.appendChild(makeJsonBlock(result.response_headers || {}))));
  }

  function badge(text, cls) {
    return `<span class="badge ${cls || ''}">${text}</span>`;
  }

  function setCardBusy(card, busy) {
    card.classList.toggle('busy', busy);
    const btn = card.querySelector('.qcard-run');
    btn.disabled = busy || batchRunning;
    btn.classList.toggle('running', busy);
    btn.innerHTML = busy ? '<span class="busy-spinner"></span>运行中' : '▶ 运行';
  }

  function refreshControls() {
    const any = batchRunning || inflight.size > 0;
    el('run-all').disabled = any;
    $stop.disabled = !any;
    cards().forEach((card) => {
      const btn = card.querySelector('.qcard-run');
      if (!card.classList.contains('busy')) btn.disabled = batchRunning;
    });
  }

  function stopRuns() {
    stopFlag = true;
    inflight.forEach((ctl) => ctl.abort());
    inflight.clear();
    refreshControls();
  }

  function clearResults() {
    resultsById.clear();
    cards().forEach((card) => {
      card.classList.remove('ok', 'fail', 'busy', 'has-result');
      const meta = card.querySelector('.qcard-meta-row');
      if (meta) meta.innerHTML = '';
      const result = card.querySelector('.qcard-result');
      if (result) result.innerHTML = '';
    });
    flashStatus('已清空', 'done');
  }

  function exportLocalResults() {
    if (!resultsById.size) return flashStatus('无本页结果可导出', 'error');
    const blob = new Blob([JSON.stringify([...resultsById.values()], null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `model-quality-${activeGroup}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function applyCategoryFilter() {
    cards().forEach((card) => {
      card.classList.toggle('hidden-by-filter', !!$filterCategory.value && card.dataset.category !== $filterCategory.value);
    });
  }

  function isHiddenByFilter(q) {
    return !!$filterCategory.value && q.category !== $filterCategory.value;
  }

  function cardFor(qid) {
    return $qgrid.querySelector(`.qcard[data-qid="${cssEscape(qid)}"]`);
  }

  function cards() {
    return [...$qgrid.querySelectorAll('.qcard')];
  }

  function makeSection(title, open, fillFn) {
    const det = document.createElement('details');
    det.className = 'result-section';
    det.open = !!open;
    const summary = document.createElement('summary');
    summary.textContent = title;
    det.appendChild(summary);
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
    s = escapeHtml(s);
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

  function flashStatus(msg, cls) {
    $runStatus.textContent = msg;
    $runStatus.className = 'run-status ' + (cls || '');
    if (cls === 'done' || cls === 'error') {
      setTimeout(() => {
        if (!$runStatus.classList.contains('running')) {
          $runStatus.textContent = '就绪';
          $runStatus.className = 'run-status';
        }
      }, 2200);
    }
  }

  function formatCost(value) {
    if (value == null || value === '') return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    if (n === 0) return '0.000000';
    if (n < 0.000001) return n.toExponential(2);
    return n.toFixed(6);
  }

  function makeBatchId() {
    return `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
