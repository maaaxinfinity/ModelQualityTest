/* global QUESTIONS */
/* ============================================================================
   Model Quality Test — front-end controller
   No bundler. Organized into internal modules under a single closure:
     Util   — pure helpers (escape, json highlight, format, dom)
     Api    — fetch wrapper
     Store  — groups/defaults, per-group config persistence, runtime state
     Theme  — light/dark switch
     Auth   — session, login, enroll, 2FA rotation, account chip
     Admin  — invites, system, prices, logs, export
     Cards  — question list + result rendering
     Runner — single + batch test execution
     boot() — wires DOM + events
   ============================================================================ */
(function () {
  'use strict';

  /* ───────────────────────── Util ───────────────────────── */
  const Util = {
    el: (id) => document.getElementById(id),
    escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
    escapeAttr(s) { return Util.escapeHtml(s).replace(/"/g, '&quot;'); },
    // Best human message from an Api.call error: prefer the server's detail,
    // then its error code, then the JS message, then the HTTP status.
    errText(e) {
      const b = e && e.body;
      const msg = (b && (b.detail || b.error)) || (e && e.message) || '';
      if (msg) return msg;
      if (e && e.status) return `请求失败 (HTTP ${e.status})`;
      return '未知错误';
    },
    cssEscape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c); },
    sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },
    makeBatchId() {
      return `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    },
    formatCost(value) {
      if (value == null || value === '') return '';
      const n = Number(value);
      if (!Number.isFinite(n)) return '';
      if (n === 0) return '0.000000';
      if (n < 0.000001) return n.toExponential(2);
      return n.toFixed(6);
    },
    highlightJson(value) {
      let s;
      try { s = JSON.stringify(value, null, 2); } catch (e) { s = String(value); }
      if (s === undefined) s = 'undefined';
      s = Util.escapeHtml(s);
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
    },
    jsonBlock(obj) {
      const pre = document.createElement('pre');
      pre.className = 'code';
      pre.innerHTML = Util.highlightJson(obj);
      return pre;
    },
    section(title, open, fillFn) {
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
    },
    badge(text, cls) { return `<span class="badge ${cls || ''}">${text}</span>`; }
  };

  /* ───────────────────────── Api ───────────────────────── */
  const Api = {
    async call(path, options) {
      const resp = await fetch(path, Object.assign(
        { headers: { 'Content-Type': 'application/json' } }, options || {}
      ));
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
    },
    // raw fetch used by the runner so it can pass an AbortController signal
    async runTest(body, signal) {
      const resp = await fetch('/api/run-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(json.error || json.detail || resp.statusText);
      return json;
    }
  };

  /* ───────────────────────── Store ───────────────────────── */
  const Store = {
    GROUPS: ['OpenAI', 'Anthropic', 'Google', 'Sakana', 'Image'],
    GROUP_DESC: {
      OpenAI: '通过 Responses 端点探测 OpenAI 模型的质量与渠道行为。',
      Anthropic: '探测 Claude 渠道、system 注入与 thinking 行为。',
      Google: '面向 Gemini models/*:generateContent 的质量探测。',
      Sakana: '以 OpenAI 兼容形态探测 Sakana / Fugu。',
      Image: '探测 gpt-image-2 的 n、quality、size 参数与小压测。'
    },
    DEFAULTS: {
      OpenAI: { baseUrl: 'https://api.openai.com', model: 'gpt-5.5', authMode: 'bearer' },
      Anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-4.8', authMode: 'x-api-key' },
      Google: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-3.1-pro-preview', authMode: 'x-api-key' },
      Sakana: { baseUrl: 'https://api.sakana.ai', model: 'fugu-ultra', authMode: 'bearer' },
      Image: { baseUrl: 'https://api.openai.com', model: 'gpt-image-2', authMode: 'bearer' }
    },
    activeGroup: 'OpenAI',
    activeView: 'test',     // test | endpoints | history | admin
    editingGroup: 'OpenAI', // group currently shown in the Endpoints editor
    editingId: null,        // endpoint id loaded in the editor; null = new endpoint
    detectedModels: null,   // full model list from the last successful detect
    enabledModels: [],      // subset ticked in the detect panel (saved on the endpoint)
    lastSyncedAt: null,     // models_synced_at shown in the detect panel header
    detectOk: false,        // has the current form passed model detection?
    configs: {},            // group -> array of endpoints loaded from the database
    selected: {},           // group -> array of selected endpoint ids (for the next run)
    selectedModels: {},     // group -> { endpointId -> [modelId] } chosen for the next run
    sessionUser: null,
    resultsById: new Map(),
    inflight: new Set(),
    stopFlag: false,
    batchRunning: false,

    defaultConfig(group) {
      return Object.assign({
        id: null, name: '', group,
        maxTokens: 1024, timeout: 120000, delay: 300, system: '',
        imageN: 1, imageQuality: 'medium', imageSize: '1024x1024', apiKey: ''
      }, Store.DEFAULTS[group]);
    },
    list(group) {
      return Store.configs[group] || [];
    },
    endpoint(group, id) {
      return Store.list(group).find((e) => e.id === id) || null;
    },
    // The endpoint ids currently selected to run for a group (defaults to first).
    selectedIds(group) {
      const list = Store.list(group);
      const chosen = (Store.selected[group] || []).filter((id) => list.some((e) => e.id === id));
      if (chosen.length) return chosen;
      return list.length ? [list[0].id] : [];
    },
    // Models chosen to run for one endpoint. Defaults to all of its enabled
    // models; always intersected with the endpoint's current enabled set so a
    // removed model never lingers in the selection.
    selectedModelIds(group, id) {
      const ep = Store.endpoint(group, id);
      const enabled = (ep && ep.enabledModels) || [];
      const map = Store.selectedModels[group] || {};
      const chosen = (map[id] || []).filter((m) => enabled.includes(m));
      return chosen.length ? chosen : enabled.slice();
    },
    setSelectedModelIds(group, id, models) {
      if (!Store.selectedModels[group]) Store.selectedModels[group] = {};
      Store.selectedModels[group][id] = models;
    },
    questionsForGroup(group) {
      return window.QUESTIONS.filter((q) => q.group === group);
    }
  };

  // cached config field refs (filled in boot)
  let $cfg = {};

  // Turn a stored config object + a chosen model into the run-test payload.
  function cfgToRunPayload(c, modelId) {
    return {
      group: c.group,
      baseUrl: (c.baseUrl || '').trim(),
      apiKey: (c.apiKey || '').trim(),
      model: (modelId || '').trim() || Store.DEFAULTS[c.group].model,
      authMode: c.authMode || 'bearer',
      maxTokens: Number(c.maxTokens || 1024),
      timeout: Number(c.timeout || 120000),
      delay: Number(c.delay || 0),
      system: c.system || '',
      image: {
        n: Number(c.imageN || 1),
        quality: c.imageQuality || 'medium',
        size: (c.imageSize || '1024x1024').trim() || '1024x1024'
      }
    };
  }

  /* ───────────────────────── Config (DB-backed, many-per-group) ───────────────────────── */
  const Config = {
    // Load every group's endpoint list from the database into Store.configs.
    async loadAll() {
      try {
        const data = await Api.call('/api/admin/endpoints', { method: 'GET', headers: {} });
        const byGroup = data.configs || {};
        Store.configs = {};
        for (const group of Store.GROUPS) {
          Store.configs[group] = (byGroup[group] || []).map((e) => Object.assign(Store.defaultConfig(group), e, { group }));
        }
      } catch (e) {
        // No session yet, or transient failure — empty lists so the UI still works.
        Store.configs = {};
        for (const group of Store.GROUPS) Store.configs[group] = [];
      }
    },

    // Populate the Endpoints editor. id=null → blank "new endpoint" form.
    fill(group, id) {
      Store.editingGroup = group;
      const list = Store.list(group);
      const target = id ? Store.endpoint(group, id) : null;
      const cfg = target || Store.defaultConfig(group);
      Store.editingId = target ? target.id : null;
      $cfg.name.value = target ? cfg.name : '';
      $cfg.baseUrl.value = cfg.baseUrl || '';
      $cfg.apiKey.value = target ? (cfg.apiKey || '') : '';
      $cfg.authMode.value = cfg.authMode || 'bearer';
      $cfg.maxTokens.value = cfg.maxTokens || 1024;
      $cfg.timeout.value = cfg.timeout || 120000;
      $cfg.delay.value = cfg.delay || 300;
      $cfg.system.value = cfg.system || '';
      $cfg.imageN.value = cfg.imageN || 1;
      $cfg.imageQuality.value = cfg.imageQuality || 'medium';
      $cfg.imageSize.value = cfg.imageSize || '1024x1024';
      Util.el('view-endpoints').classList.toggle('is-image', group === 'Image');
      Util.el('delete-endpoint').hidden = !Store.editingId;
      // A saved endpoint keeps its detected models + enabled subset; a new form
      // must detect first.
      Store.detectedModels = target && target.models && target.models.length ? target.models.slice() : null;
      Store.enabledModels = target && Array.isArray(target.enabledModels) ? target.enabledModels.slice() : [];
      Store.detectOk = !!(Store.detectedModels && Store.detectedModels.length);
      Config.buildTabs();
      Config.buildEndpointList();
      Config.summary();
      Config.renderModels(target ? target.modelsSyncedAt : null);
      Config.updateGate();
      Util.el('endpoints-output').innerHTML = list.length ? '' :
        '<div class="empty-state">该分组还没有端点，填写名称与 API Key 后点击“检测模型列表”，勾选要启用的模型即可保存。</div>';
    },

    readForm() {
      return {
        id: Store.editingId || undefined,
        group: Store.editingGroup,
        name: $cfg.name.value.trim(),
        baseUrl: $cfg.baseUrl.value.trim(),
        apiKey: $cfg.apiKey.value.trim(),
        authMode: $cfg.authMode.value,
        maxTokens: Number($cfg.maxTokens.value || 1024),
        timeout: Number($cfg.timeout.value || 120000),
        delay: Number($cfg.delay.value || 0),
        system: $cfg.system.value,
        imageN: Number($cfg.imageN.value || 1),
        imageQuality: $cfg.imageQuality.value,
        imageSize: $cfg.imageSize.value.trim() || '1024x1024'
      };
    },

    async save() {
      const out = Util.el('endpoints-output');
      const form = Config.readForm();
      if (!form.name) { out.innerHTML = '<div class="warn-box">请填写端点名称。</div>'; return; }
      if (!Store.detectOk || !Store.detectedModels || !Store.detectedModels.length) {
        out.innerHTML = '<div class="warn-box">请先点击“检测模型列表”，检测通过后才能保存。</div>';
        return;
      }
      if (!Store.enabledModels.length) {
        out.innerHTML = '<div class="warn-box">请至少勾选一个要启用的模型。</div>';
        return;
      }
      form.models = Store.detectedModels;
      form.enabledModels = Store.enabledModels;
      try {
        const data = await Api.call('/api/admin/endpoints', { method: 'POST', body: JSON.stringify(form) });
        await Config.loadAll();
        Config.fill(form.group, data.config.id);
        Picker.render();
        out.innerHTML = `<div class="ok-box">已保存端点「${Util.escapeHtml(data.config.name)}」（启用 ${data.config.enabledModels.length} / 共 ${data.config.models.length} 个模型）。</div>`;
      } catch (e) {
        out.innerHTML = `<div class="warn-box">保存失败：${Util.escapeHtml(Util.errText(e))}</div>`;
      }
    },

    // Probe the channel's model list. On success, unlock save.
    async detect() {
      const out = Util.el('endpoints-output');
      const btn = Util.el('detect-models');
      const form = Config.readForm();
      if (!form.apiKey && !Store.editingId) { out.innerHTML = '<div class="warn-box">请先填写 API Key。</div>'; return; }
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = '检测中…';
      try {
        const data = await Api.call('/api/admin/endpoints?action=detect', { method: 'POST', body: JSON.stringify(form) });
        Store.detectedModels = data.models || [];
        Store.detectOk = Store.detectedModels.length > 0;
        // Keep any previously-enabled models that still exist upstream.
        const available = new Set(Store.detectedModels);
        Store.enabledModels = (Store.enabledModels || []).filter((m) => available.has(m));
        Config.renderModels(new Date().toISOString());
        Config.updateGate();
        out.innerHTML = Store.detectOk
          ? `<div class="ok-box">检测通过，获取到 ${data.count} 个模型，请勾选要启用的模型后保存。</div>`
          : '<div class="warn-box">连接成功，但该渠道未返回任何模型。</div>';
      } catch (e) {
        Store.detectOk = false;
        Config.updateGate();
        const detail = (e.body && (e.body.detail || e.body.status)) ? `${e.body.detail || ''}${e.body.status ? ' (HTTP ' + e.body.status + ')' : ''}` : e.message;
        out.innerHTML = `<div class="warn-box">检测失败：${Util.escapeHtml(detail)}</div>`;
      } finally {
        btn.disabled = false;
        btn.textContent = prev;
      }
    },

    // Re-sync the currently saved endpoint's model list from upstream.
    async sync() {
      if (!Store.editingId) return;
      const out = Util.el('endpoints-output');
      try {
        const data = await Api.call('/api/admin/endpoints?action=sync', { method: 'POST', body: JSON.stringify({ id: Store.editingId }) });
        const r = (data.results || [])[0] || {};
        if (!r.ok) { out.innerHTML = `<div class="warn-box">同步失败：${Util.escapeHtml(r.message || '未知错误')}</div>`; return; }
        await Config.loadAll();
        Config.fill(Store.editingGroup, Store.editingId);
        Picker.render();
        out.innerHTML = `<div class="ok-box">已同步，${r.count} 个模型。</div>`;
      } catch (e) {
        out.innerHTML = `<div class="warn-box">同步失败：${Util.escapeHtml(Util.errText(e))}</div>`;
      }
    },

    // Any credential/URL change invalidates a prior detection.
    invalidateDetect() {
      if (Store.detectOk) {
        Store.detectOk = false;
        Config.updateGate();
      }
    },

    // Save is allowed only once the form has passed detection AND at least one
    // model is enabled.
    updateGate() {
      const btn = Util.el('save-endpoint');
      if (btn) btn.disabled = !(Store.detectOk && Store.enabledModels && Store.enabledModels.length);
      const sync = Util.el('sync-models');
      if (sync) sync.hidden = !Store.editingId;
    },

    // Toggle one model in the enabled subset, then refresh count + save gate.
    toggleEnabled(model, on) {
      const set = new Set(Store.enabledModels || []);
      if (on) set.add(model); else set.delete(model);
      // Preserve detected order.
      Store.enabledModels = (Store.detectedModels || []).filter((m) => set.has(m));
      Config.renderModelsHead();
      Config.updateGate();
    },

    setAllEnabled(on) {
      Store.enabledModels = on ? (Store.detectedModels || []).slice() : [];
      Config.renderModels(Store.lastSyncedAt);
      Config.updateGate();
    },

    renderModelsHead() {
      const head = Util.el('endpoints-models-head');
      if (!head) return;
      const total = (Store.detectedModels || []).length;
      const on = (Store.enabledModels || []).length;
      const when = Store.lastSyncedAt ? ` · 同步于 ${new Date(Store.lastSyncedAt).toLocaleString()}` : '';
      head.textContent = `已启用 ${on} / 共 ${total} 个模型${when}`;
    },

    // The detect panel IS the model-enabling UI: a checkbox list over the
    // detected models. Ticking a box enables that model for this endpoint.
    renderModels(syncedAt) {
      Store.lastSyncedAt = syncedAt || null;
      const node = Util.el('endpoints-models');
      if (!node) return;
      const models = Store.detectedModels || [];
      if (!models.length) {
        node.innerHTML = '<span class="models-hint">尚未检测模型列表。填写 API Key 后点击“检测模型列表”。</span>';
        return;
      }
      const enabled = new Set(Store.enabledModels || []);
      const items = models.map((m) => {
        const on = enabled.has(m) ? ' checked' : '';
        return `<label class="model-pick${on ? ' on' : ''}"><input type="checkbox" data-model="${Util.escapeAttr(m)}"${on}><span>${Util.escapeHtml(m)}</span></label>`;
      }).join('');
      node.innerHTML =
        `<div class="models-head"><span id="endpoints-models-head"></span>` +
        `<span class="models-actions"><button type="button" class="link-btn" data-all="1">全选</button>` +
        `<button type="button" class="link-btn" data-all="0">全不选</button></span></div>` +
        `<div class="models-picks">${items}</div>`;
      Config.renderModelsHead();
      node.querySelectorAll('.model-pick input').forEach((box) => {
        box.addEventListener('change', () => {
          box.closest('.model-pick').classList.toggle('on', box.checked);
          Config.toggleEnabled(box.dataset.model, box.checked);
        });
      });
      node.querySelectorAll('.models-actions .link-btn').forEach((btn) => {
        btn.addEventListener('click', () => Config.setAllEnabled(btn.dataset.all === '1'));
      });
    },

    async remove() {
      if (!Store.editingId) return;
      const out = Util.el('endpoints-output');
      const group = Store.editingGroup;
      try {
        await Api.call(`/api/admin/endpoints?id=${encodeURIComponent(Store.editingId)}`, { method: 'DELETE', headers: {} });
        // Drop it from the selection too.
        Store.selected[group] = (Store.selected[group] || []).filter((id) => id !== Store.editingId);
        await Config.loadAll();
        const next = Store.list(group)[0];
        Config.fill(group, next ? next.id : null);
        out.innerHTML = '<div class="ok-box">端点已删除。</div>';
      } catch (e) {
        out.innerHTML = `<div class="warn-box">删除失败：${Util.escapeHtml(Util.errText(e))}</div>`;
      }
    },

    // Type tabs (OpenAI / Anthropic / …) — switching resets to that group's first endpoint.
    buildTabs() {
      const host = Util.el('ep-group-tabs');
      if (!host) return;
      host.innerHTML = '';
      for (const group of Store.GROUPS) {
        const list = Store.list(group);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ep-tab' + (group === Store.editingGroup ? ' active' : '');
        btn.textContent = group;
        const count = document.createElement('span');
        count.className = 'ep-badge';
        count.textContent = String(list.length);
        btn.appendChild(count);
        btn.addEventListener('click', () => Config.fill(group, (Store.list(group)[0] || {}).id || null));
        host.appendChild(btn);
      }
    },

    // Endpoint chips for the editing group + a "new endpoint" chip.
    buildEndpointList() {
      const host = Util.el('ep-endpoint-list');
      if (!host) return;
      host.innerHTML = '';
      for (const ep of Store.list(Store.editingGroup)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ep-chip' + (ep.id === Store.editingId ? ' active' : '');
        btn.textContent = ep.name || '(未命名)';
        if (ep.hasApiKey || ep.apiKey) {
          const dot = document.createElement('span');
          dot.className = 'ep-dot';
          dot.title = '已配置 API Key';
          btn.appendChild(dot);
        }
        btn.addEventListener('click', () => Config.fill(Store.editingGroup, ep.id));
        host.appendChild(btn);
      }
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'ep-chip ep-new' + (Store.editingId ? '' : ' active');
      add.textContent = '＋ 新建端点';
      add.addEventListener('click', () => Config.fill(Store.editingGroup, null));
      host.appendChild(add);
    },

    summary() {
      const node = Util.el('endpoints-summary');
      if (!node) return;
      let host = '';
      try { host = new URL($cfg.baseUrl.value).host; } catch (e) { host = ''; }
      const label = Store.editingId ? ($cfg.name.value || '端点') : '新建端点';
      node.textContent = `· ${Store.editingGroup} · ${label}${host ? ' @ ' + host : ''}`;
    }
  };

  /* ───────────────────────── Endpoint picker (test page) ───────────────────────── */
  const Picker = {
    // Multi-select strip on the test page: which endpoints the next run targets.
    render() {
      const host = Util.el('endpoint-picker');
      if (!host) return;
      const group = Store.activeGroup;
      const list = Store.list(group);
      host.innerHTML = '';

      if (!list.length) {
        host.innerHTML = `<div class="picker-empty">该分组还没有端点。<button type="button" class="auth-link" id="picker-goto-ep">前往端点管理</button></div>`;
        Util.el('picker-goto-ep').addEventListener('click', () => Router.show('endpoints', group));
        return;
      }

      const selected = new Set(Store.selectedIds(group));
      Store.selected[group] = [...selected];

      const epRow = document.createElement('div');
      epRow.className = 'picker-row';
      const label = document.createElement('span');
      label.className = 'picker-label';
      label.textContent = '端点';
      epRow.appendChild(label);

      let modelPairs = 0;
      for (const ep of list) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pick-chip' + (selected.has(ep.id) ? ' active' : '');
        btn.textContent = ep.name || '(未命名)';
        if (!(ep.hasApiKey || ep.apiKey)) {
          const warn = document.createElement('span');
          warn.className = 'pick-warn';
          warn.title = '未配置 API Key';
          warn.textContent = '⚠';
          btn.appendChild(warn);
        }
        btn.addEventListener('click', () => Picker.toggle(ep.id));
        epRow.appendChild(btn);
      }
      host.appendChild(epRow);

      // For every selected endpoint, a sub-row of its enabled models. The chosen
      // models default to all enabled and drive the (question × endpoint × model) run.
      for (const id of selected) {
        const ep = Store.endpoint(group, id);
        if (!ep) continue;
        const enabled = ep.enabledModels || [];
        const row = document.createElement('div');
        row.className = 'picker-row picker-models';
        const tag = document.createElement('span');
        tag.className = 'picker-sublabel';
        tag.textContent = `${ep.name || '(未命名)'} · 模型`;
        row.appendChild(tag);
        if (!enabled.length) {
          const none = document.createElement('span');
          none.className = 'picker-summary';
          none.textContent = '该端点未启用任何模型';
          row.appendChild(none);
          host.appendChild(row);
          continue;
        }
        const chosen = new Set(Store.selectedModelIds(group, id));
        for (const m of enabled) {
          const on = chosen.has(m);
          if (on) modelPairs++;
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'pick-chip model-chip' + (on ? ' active' : '');
          chip.textContent = m;
          chip.addEventListener('click', () => Picker.toggleModel(id, m));
          row.appendChild(chip);
        }
        host.appendChild(row);
      }

      const summary = document.createElement('div');
      summary.className = 'picker-summary picker-total';
      summary.textContent = `已选 ${selected.size} 端点 · ${modelPairs} 个模型运行`;
      host.appendChild(summary);
    },

    toggle(id) {
      const group = Store.activeGroup;
      const set = new Set(Store.selectedIds(group));
      if (set.has(id)) set.delete(id); else set.add(id);
      Store.selected[group] = [...set];
      Picker.render();
    },

    toggleModel(id, model) {
      const group = Store.activeGroup;
      const set = new Set(Store.selectedModelIds(group, id));
      if (set.has(model)) set.delete(model); else set.add(model);
      // Preserve enabled order.
      const ep = Store.endpoint(group, id);
      const ordered = ((ep && ep.enabledModels) || []).filter((m) => set.has(m));
      Store.setSelectedModelIds(group, id, ordered);
      Picker.render();
    }
  };

  /* ───────────────────────── Theme ───────────────────────── */
  const Theme = {
    KEY: 'mqt.theme',
    init() {
      let t = 'light';
      try { t = localStorage.getItem(Theme.KEY) || 'light'; } catch (e) {}
      Theme.apply(t);
      const btn = Util.el('theme-toggle');
      if (btn) btn.addEventListener('click', Theme.toggle);
    },
    apply(t) {
      document.documentElement.dataset.theme = t;
      const ico = Util.el('theme-ico');
      if (ico) ico.textContent = t === 'dark' ? '☀' : '☾';
    },
    toggle() {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      Theme.apply(next);
      try { localStorage.setItem(Theme.KEY, next); } catch (e) {}
    }
  };

  /* ───────────────────────── Auth ───────────────────────── */
  const Auth = {
    async refresh() {
      try {
        const status = await Api.call('/api/auth/status', { method: 'GET', headers: {} });
        Store.sessionUser = status.user;
        Auth.render(status);
      } catch (e) {
        const foot = Util.el('auth-foot');
        if (foot) foot.innerHTML = `<span class="dot fail"></span>无法连接服务：${Util.escapeHtml(e.message)}`;
        document.body.classList.add('app-locked');
        document.body.classList.remove('authed');
      }
    },

    render(status) {
      const authed = !!status.user;
      document.body.classList.toggle('app-locked', !authed);
      document.body.classList.toggle('authed', authed);

      const chip = Util.el('account-chip');
      const platformSection = Util.el('platform-section');

      if (authed) {
        chip.hidden = false;
        const initial = (status.user.displayName || '?').trim().charAt(0) || '?';
        chip.innerHTML = `
          <span class="avatar">${Util.escapeHtml(initial)}</span>
          <span class="acc-text">
            <span class="acc-name">${Util.escapeHtml(status.user.displayName)}</span>
            <span class="acc-role">${Util.escapeHtml(status.user.role)}</span>
          </span>
          <span class="acc-menu">
            <button type="button" id="rotate-2fa" class="subtle" title="轮换两步验证">2FA</button>
            <button type="button" id="logout" class="subtle" title="退出登录">退出</button>
          </span>`;
        Util.el('rotate-2fa').addEventListener('click', Auth.startRotation);
        Util.el('logout').addEventListener('click', Auth.logout);

        platformSection.hidden = status.user.role !== 'admin';
        if (status.insecureDevSecret) {
          Auth.sessionPanel(`<div class="warn-box">SESSION_SECRET 使用了不安全的默认值，请在部署环境配置强随机密钥。</div>`);
        }
        // Endpoint config lives in the database; load it once authenticated.
        Config.loadAll().then(() => {
          Picker.render();
          if (Store.activeView === 'endpoints') Config.fill(Store.editingGroup, (Store.list(Store.editingGroup)[0] || {}).id || null);
        });
        return;
      }

      // locked
      chip.hidden = true;
      platformSection.hidden = true;
      Util.el('auth-output').innerHTML = '';
      if (status.setupRequired) Auth.renderSetup();
      else Auth.renderLogin();
    },

    // first-run: no users exist yet → only a name, then a QR. No invite.
    renderSetup() {
      const foot = Util.el('auth-foot');
      if (foot) foot.innerHTML = `<span class="dot accent"></span>首次设置 · 创建初始管理员`;
      Util.el('auth-flow').innerHTML = `
        <div class="auth-head">
          <span class="pill setup">首次设置</span>
          <h2>创建初始管理员</h2>
          <p>系统中尚无任何账户。设置用户名并绑定验证器，此账户将成为初始管理员。</p>
        </div>
        <div class="auth-stack">
          <label class="auth-field"><span>用户名</span>
            <input id="auth-name" type="text" placeholder="例如 admin" autocomplete="username" /></label>
          <button id="start-setup" class="primary" type="button">生成验证器二维码</button>
        </div>`;
      const go = () => Auth.beginEnroll({ displayName: Util.el('auth-name').value });
      Util.el('start-setup').addEventListener('click', go);
      Util.el('auth-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    },

    renderLogin() {
      const foot = Util.el('auth-foot');
      if (foot) foot.innerHTML = `<span class="dot ok"></span>已连接 · 请登录`;
      Util.el('auth-flow').innerHTML = `
        <div class="auth-head">
          <h2>登录</h2>
          <p>输入用户名与验证器中的 TOTP 验证码。</p>
        </div>
        <div class="auth-stack">
          <label class="auth-field"><span>用户名</span>
            <input id="auth-name" type="text" placeholder="用户名" autocomplete="username" /></label>
          <label class="auth-field"><span>TOTP 验证码</span>
            <input id="auth-token" type="text" inputmode="numeric" placeholder="8 位验证码" autocomplete="one-time-code" /></label>
          <button id="login-btn" class="primary" type="button">登录</button>
        </div>
        <div class="auth-alt">收到邀请码？<button class="auth-link" id="goto-enroll" type="button">绑定新管理员</button></div>`;
      Util.el('login-btn').addEventListener('click', Auth.login);
      Util.el('goto-enroll').addEventListener('click', Auth.renderInviteEnroll);
      const onEnter = (e) => { if (e.key === 'Enter') Auth.login(); };
      Util.el('auth-name').addEventListener('keydown', onEnter);
      Util.el('auth-token').addEventListener('keydown', onEnter);
    },

    // invited admin redeems an invite code created in the console
    renderInviteEnroll() {
      Util.el('auth-output').innerHTML = '';
      const foot = Util.el('auth-foot');
      if (foot) foot.innerHTML = `<span class="dot ok"></span>受邀加入 · 绑定验证器`;
      Util.el('auth-flow').innerHTML = `
        <div class="auth-head">
          <h2>绑定新管理员</h2>
          <p>使用管理员在控制台发放的邀请码绑定你的验证器。</p>
        </div>
        <div class="auth-stack">
          <label class="auth-field"><span>用户名</span>
            <input id="auth-name" type="text" placeholder="用户名" autocomplete="username" /></label>
          <label class="auth-field"><span>邀请码</span>
            <input id="invite-code" type="text" placeholder="邀请码" /></label>
          <button id="start-enroll" class="primary" type="button">生成验证器二维码</button>
        </div>
        <div class="auth-alt"><button class="auth-link" id="goto-login" type="button">返回登录</button></div>`;
      Util.el('start-enroll').addEventListener('click', () => Auth.beginEnroll({
        displayName: Util.el('auth-name').value,
        inviteCode: Util.el('invite-code').value
      }));
      Util.el('goto-login').addEventListener('click', Auth.renderLogin);
    },

    // session panel for 2FA rotation / warnings shown inside the workspace
    sessionPanel(html) {
      let panel = Util.el('session-panel');
      if (!panel) {
        panel = document.createElement('section');
        panel.id = 'session-panel';
        panel.className = 'block';
        panel.style.padding = '16px 18px';
        const ws = Util.el('workspace');
        const head = ws.querySelector('.page-head');
        if (head && head.nextSibling) ws.insertBefore(panel, head.nextSibling);
        else ws.appendChild(panel);
      }
      panel.hidden = false;
      panel.innerHTML = html;
      return panel;
    },

    async login() {
      const out = Util.el('auth-output');
      try {
        const data = await Api.call('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({
            displayName: Util.el('auth-name').value,
            token: Util.el('auth-token').value
          })
        });
        Store.sessionUser = data.user;
        Auth.refresh();
      } catch (e) {
        out.innerHTML = `<div class="warn-box">登录失败：${Util.escapeHtml(e.message)}</div>`;
      }
    },

    async logout() {
      await Api.call('/api/auth/logout', { method: 'POST', body: '{}' });
      Store.sessionUser = null;
      const panel = Util.el('session-panel');
      if (panel) panel.hidden = true;
      Auth.refresh();
    },

    // shared: start enrollment (bootstrap or invite) then show TOTP confirm
    async beginEnroll(payload) {
      const out = Util.el('auth-output');
      out.innerHTML = '';
      try {
        const data = await Api.call('/api/auth/enroll', { method: 'POST', body: JSON.stringify(payload) });
        Util.el('auth-flow').innerHTML = Auth.totpMarkup(
          data, 'enroll-token', 'finish-enroll', '完成绑定',
          '用 Google Authenticator / 1Password 等扫描二维码，或手动录入密钥，然后输入 8 位验证码。'
        ) + `<div class="auth-alt"><button class="auth-link" id="enroll-cancel" type="button">取消</button></div>`;
        Auth.paintQr(Util.el('auth-flow'));
        Util.el('finish-enroll').addEventListener('click', async () => {
          try {
            await Api.call('/api/auth/enroll', {
              method: 'POST',
              body: JSON.stringify({ enrollmentId: data.enrollmentId, token: Util.el('enroll-token').value })
            });
            Auth.refresh();
          } catch (e) {
            out.innerHTML = `<div class="warn-box">绑定失败：${Util.escapeHtml(e.message)}</div>`;
          }
        });
        Util.el('enroll-cancel').addEventListener('click', Auth.refresh);
      } catch (e) {
        out.innerHTML = `<div class="warn-box">${Util.escapeHtml(e.message)}</div>`;
      }
    },

    async startRotation() {
      try {
        const data = await Api.call('/api/auth/2fa', { method: 'POST', body: JSON.stringify({ action: 'start' }) });
        const panel = Auth.sessionPanel(
          `<div class="dot-label" style="margin-bottom:14px"><span class="dot accent"></span>轮换两步验证</div>
           <div id="twofa-output" style="max-width:360px">${Auth.totpMarkup(data, 'rotate-token', 'finish-rotate-2fa', '保存', '扫描新二维码并输入验证码以替换旧的验证器。')}</div>`
        );
        Auth.paintQr(panel);
        Util.el('finish-rotate-2fa').addEventListener('click', async () => {
          const out = panel.querySelector('#twofa-output');
          try {
            await Api.call('/api/auth/2fa', {
              method: 'POST',
              body: JSON.stringify({ action: 'confirm', enrollmentId: data.enrollmentId, token: Util.el('rotate-token').value })
            });
            out.innerHTML = '<div class="ok-box">两步验证已更新。</div>';
            setTimeout(() => { panel.hidden = true; }, 1800);
          } catch (e) {
            out.innerHTML += `<div class="warn-box">失败：${Util.escapeHtml(e.message)}</div>`;
          }
        });
      } catch (e) {
        Auth.sessionPanel(`<div class="warn-box">无法启动 2FA 轮换：${Util.escapeHtml(e.message)}</div>`);
      }
    },

    totpMarkup(data, inputId, finishId, finishLabel, hint) {
      // QR is rendered client-side by the qrbtf bundle (QRLine style), exactly
      // like ge2api. No server-side fallback.
      const qr = `<div class="qr-box" data-qr data-otpauth="${Util.escapeAttr(data.otpauthUrl || '')}"></div>`;
      return `
        <div class="totp-setup">
          ${qr}
          ${hint ? `<div class="totp-hint">${Util.escapeHtml(hint)}</div>` : ''}
          <code class="totp-secret">${Util.escapeHtml(data.secret || '')}</code>
          <div class="auth-stack">
            <label class="auth-field"><span>TOTP 验证码</span>
              <input id="${inputId}" type="text" inputmode="numeric" placeholder="8 位验证码" autocomplete="one-time-code" /></label>
            <button id="${finishId}" class="primary" type="button">${Util.escapeHtml(finishLabel)}</button>
          </div>
        </div>`;
    },

    // Render the QR with the qrbtf bundle (window.ge2AdminQr → QRLine).
    paintQr(root) {
      const box = (root || document).querySelector('.qr-box[data-qr]');
      if (!box) return;
      const otpauth = box.getAttribute('data-otpauth');
      window.ge2AdminQr.render(box, otpauth, { posType: 'roundRect', lineColor: '#0d0d0d', posColor: '#0d0d0d' });
    }
  };

  /* ───────────────────────── Admin ───────────────────────── */
  const Admin = {
    out() { return Util.el('admin-output'); },

    async createInvite() {
      try {
        const data = await Api.call('/api/admin/invites', { method: 'POST', body: JSON.stringify({ maxUses: 1, expiresHours: 168 }) });
        Admin.out().innerHTML = `<div class="ok-box">邀请码：<code>${Util.escapeHtml(data.code)}</code> · 有效期 7 天</div>`;
      } catch (e) { Admin.fail(e); }
    },

    async systemStatus() {
      try {
        const data = await Api.call('/api/admin/system', { method: 'GET', headers: {} });
        Admin.out().innerHTML = `<pre class="code">${Util.highlightJson(data)}</pre>`;
      } catch (e) { Admin.fail(e); }
    },

    async syncPrices() {
      try {
        Admin.out().innerHTML = '<div class="empty-state">同步中…</div>';
        const data = await Api.call('/api/admin/prices', { method: 'POST', body: '{}' });
        const sync = data.sync || {};
        const pricing = data.pricing || {};
        Admin.out().innerHTML = `
          <div class="ok-box">已同步 ${Util.escapeHtml(sync.syncedRows || 0)} 行 · 来源：${Util.escapeHtml((sync.sourceProviders || []).join(', '))}</div>
          <pre class="code">${Util.highlightJson(pricing.groups || [])}</pre>`;
      } catch (e) { Admin.fail(e); }
    },

    historyOut() { return Util.el('history-output'); },

    async refreshLogs() {
      const out = Admin.historyOut();
      try {
        const sel = Util.el('history-group');
        const group = sel ? sel.value : '';
        const g = group ? `&group=${encodeURIComponent(group)}` : '';
        const data = await Api.call(`/api/admin/logs?limit=50${g}`, { method: 'GET', headers: {} });
        out.innerHTML = Admin.logTable(data.logs || []);
      } catch (e) { out.innerHTML = `<div class="warn-box">失败：${Util.escapeHtml(e.message)}</div>`; }
    },

    logTable(logs) {
      if (!logs.length) return '<div class="empty-state">暂无日志</div>';
      return `<div class="code-scroll"><table class="log-table"><thead><tr>
        <th>时间</th><th>用例</th><th>模型</th><th>状态</th><th>成本</th>
        </tr></thead><tbody>${
        logs.map((r) => `<tr>
          <td>${Util.escapeHtml(new Date(r.created_at).toLocaleString())}</td>
          <td>${Util.escapeHtml(r.question_id)}</td>
          <td>${Util.escapeHtml(r.routed_model_id || r.model_id)}</td>
          <td class="${r.ok ? 'st-ok' : 'st-fail'}">${r.ok ? 'OK' : 'FAIL'} ${Util.escapeHtml(r.response_status || '')}</td>
          <td>${Util.formatCost(r.estimated_cost_usd)}</td>
        </tr>`).join('')
      }</tbody></table></div>`;
    },

    exportCsv() { window.location.href = '/api/admin/logs?format=csv&limit=1000'; },

    fail(e) { Admin.out().innerHTML = `<div class="warn-box">失败：${Util.escapeHtml(e.message)}</div>`; }
  };

  /* ───────────────────────── Cards ───────────────────────── */
  const Cards = {
    grid() { return Util.el('qgrid'); },
    all() { return [...Cards.grid().querySelectorAll('.qcard')]; },
    forId(qid) { return Cards.grid().querySelector(`.qcard[data-qid="${Util.cssEscape(qid)}"]`); },

    renderList() {
      const grid = Cards.grid();
      grid.innerHTML = '';
      const qs = Store.questionsForGroup(Store.activeGroup);
      const cats = new Set();
      for (const q of qs) {
        cats.add(q.category);
        grid.appendChild(Cards.build(q));
      }
      Util.el('q-count').textContent = String(qs.length);
      const filter = Util.el('filter-category');
      filter.innerHTML = '<option value="">全部分类</option>' +
        [...cats].map((c) => `<option value="${Util.escapeAttr(c)}">${Util.escapeHtml(c)}</option>`).join('');
    },

    build(q) {
      const card = document.createElement('div');
      card.className = 'qcard';
      card.dataset.qid = q.id;
      card.dataset.category = q.category || '';
      card.innerHTML = `
        <div class="qcard-head">
          <span class="qcard-status"></span>
          <span class="tag">${Util.escapeHtml(q.group)}</span>
          <span class="tag subtle">${Util.escapeHtml(q.category || '')}</span>
          <span class="qcard-name">${Util.escapeHtml(q.name || q.id)}</span>
          <div class="qcard-actions">
            <button type="button" class="qcard-run">▶ 运行</button>
            <button type="button" class="qcard-expand" aria-label="展开">▾</button>
          </div>
        </div>
        ${q.description ? `<div class="qcard-desc">${Util.escapeHtml(q.description)}</div>` : ''}
        <div class="qcard-meta-row"></div>
        <div class="qcard-body"></div>`;
      card.querySelector('.qcard-head').addEventListener('click', (e) => {
        if (!e.target.closest('button')) Cards.toggle(card);
      });
      card.querySelector('.qcard-expand').addEventListener('click', (e) => {
        e.stopPropagation(); Cards.toggle(card);
      });
      card.querySelector('.qcard-run').addEventListener('click', (e) => {
        e.stopPropagation(); Runner.runOne(q, card);
      });
      return card;
    },

    ensureBody(card) {
      const body = card.querySelector('.qcard-body');
      if (body.dataset.ready === '1') return;
      const q = window.QUESTIONS.find((item) => item.id === card.dataset.qid);
      body.appendChild(Util.section('Prompt', true, (inner) => {
        const box = document.createElement('div');
        box.className = 'userprompt-box';
        box.textContent = Cards.preview(q);
        inner.appendChild(box);
      }));
      if (q && q.observe) {
        body.appendChild(Util.section('观察点 Observe', false, (inner) => {
          const box = document.createElement('div');
          box.className = 'userprompt-box';
          box.textContent = q.observe;
          inner.appendChild(box);
        }));
      }
      const result = document.createElement('div');
      result.className = 'qcard-result';
      body.appendChild(result);
      body.dataset.ready = '1';
    },

    preview(q) {
      if (!q) return '(empty)';
      if (q.prompt) return q.prompt;
      if (q.user) return q.user;
      if (Array.isArray(q.messages)) {
        return q.messages.map((m) => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');
      }
      return '(empty)';
    },

    toggle(card, force) {
      const open = force === true ? true : force === false ? false : !card.classList.contains('expanded');
      card.classList.toggle('expanded', open);
      card.querySelector('.qcard-expand').textContent = open ? '▴' : '▾';
      if (open) Cards.ensureBody(card);
    },

    setBusy(card, busy) {
      card.classList.toggle('busy', busy);
      const btn = card.querySelector('.qcard-run');
      btn.disabled = busy || Store.batchRunning;
      btn.classList.toggle('running', busy);
      btn.innerHTML = busy ? '<span class="busy-spinner"></span>运行中' : '▶ 运行';
    },

    badgeRow(result) {
      return [
        Util.badge(result.ok ? 'OK' : 'FAIL', result.ok ? 'ok' : 'fail'),
        result.response_status ? Util.badge(`HTTP ${result.response_status}`) : '',
        (result.routed_model_id || result.model_id) ? Util.badge(`model=${Util.escapeHtml(result.routed_model_id || result.model_id)}`) : '',
        result.elapsed_ms != null ? Util.badge(`${result.elapsed_ms} ms`) : '',
        result.estimated_cost_usd != null ? Util.badge(`$${Util.formatCost(result.estimated_cost_usd)}`, 'info') : ''
      ].filter(Boolean).join('');
    },

    // Build the detail sections (Summary/Response/Request/Headers) for one result into a host.
    fillResultSections(host, result) {
      if (result.error_message) {
        const div = document.createElement('div');
        div.className = 'warn-box';
        div.textContent = result.error_message;
        host.appendChild(div);
      }
      host.appendChild(Util.section('Summary', true, (inner) => {
        inner.appendChild(Util.jsonBlock({
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
      host.appendChild(Util.section('Response', false, (inner) => inner.appendChild(Util.jsonBlock(result.response_body || {}))));
      host.appendChild(Util.section('Request', false, (inner) => inner.appendChild(Util.jsonBlock(result.request_body || {}))));
      host.appendChild(Util.section('Headers', false, (inner) => inner.appendChild(Util.jsonBlock(result.response_headers || {}))));
    },

    // Render one or more endpoint results into a card. list = [{endpoint, result}].
    renderResults(card, list) {
      const anyFail = list.some((x) => !x.result.ok);
      card.classList.remove('ok', 'fail');
      card.classList.add(anyFail ? 'fail' : 'ok', 'has-result');

      // Card-level meta = aggregate across endpoints.
      const meta = card.querySelector('.qcard-meta-row');
      if (list.length === 1) {
        meta.innerHTML = Cards.badgeRow(list[0].result);
      } else {
        const okN = list.filter((x) => x.result.ok).length;
        const cost = list.reduce((s, x) => s + Number(x.result.estimated_cost_usd || 0), 0);
        meta.innerHTML = [
          Util.badge(`${okN}/${list.length} OK`, anyFail ? 'fail' : 'ok'),
          Util.badge(`${list.length} 组运行`),
          cost ? Util.badge(`$${Util.formatCost(cost)}`, 'info') : ''
        ].filter(Boolean).join('');
      }

      Cards.ensureBody(card);
      const host = card.querySelector('.qcard-result');
      host.innerHTML = '';
      host.classList.toggle('multi', list.length > 1);

      for (const { endpoint, model, result } of list) {
        const panel = document.createElement('div');
        panel.className = 'result-endpoint ' + (result.ok ? 'ok' : 'fail');
        const head = document.createElement('div');
        head.className = 'result-ep-head';
        const modelTag = model ? `<span class="result-ep-model">${Util.escapeHtml(model)}</span>` : '';
        head.innerHTML = `<span class="result-ep-name">${Util.escapeHtml(endpoint.name || endpoint.group)}</span>${modelTag}
          <span class="result-ep-badges">${Cards.badgeRow(result)}</span>`;
        panel.appendChild(head);
        const body = document.createElement('div');
        body.className = 'result-ep-body';
        Cards.fillResultSections(body, result);
        panel.appendChild(body);
        host.appendChild(panel);
      }
    },

    isHiddenByFilter(q) {
      const v = Util.el('filter-category').value;
      return !!v && q.category !== v;
    },
    applyFilter() {
      const v = Util.el('filter-category').value;
      Cards.all().forEach((card) => {
        card.classList.toggle('hidden-by-filter', !!v && card.dataset.category !== v);
      });
    },
    clearResults() {
      Store.resultsById.clear();
      Cards.all().forEach((card) => {
        card.classList.remove('ok', 'fail', 'busy', 'has-result');
        const meta = card.querySelector('.qcard-meta-row');
        if (meta) meta.innerHTML = '';
        const result = card.querySelector('.qcard-result');
        if (result) result.innerHTML = '';
      });
      UI.flash('已清空', 'done');
    }
  };

  /* ───────────────────────── UI helpers (status + progress) ───────────────────────── */
  const UI = {
    flash(msg, cls) {
      const node = Util.el('run-status');
      node.textContent = msg;
      node.className = 'run-status ' + (cls || '');
      if (cls === 'done' || cls === 'error') {
        setTimeout(() => {
          if (!node.classList.contains('running')) {
            node.textContent = '就绪';
            node.className = 'run-status';
          }
        }, 2200);
      }
    },
    progress(done, total) {
      const wrap = Util.el('run-progress');
      const bar = Util.el('run-progress-bar');
      if (total <= 0) { wrap.hidden = true; return; }
      wrap.hidden = false;
      bar.style.width = Math.round((done / total) * 100) + '%';
    },
    hideProgress() {
      const wrap = Util.el('run-progress');
      const bar = Util.el('run-progress-bar');
      if (bar) bar.style.width = '0%';
      if (wrap) wrap.hidden = true;
    },
    refreshControls() {
      const any = Store.batchRunning || Store.inflight.size > 0;
      Util.el('run-all').disabled = any;
      Util.el('stop').disabled = !any;
      Cards.all().forEach((card) => {
        const btn = card.querySelector('.qcard-run');
        if (!card.classList.contains('busy')) btn.disabled = Store.batchRunning;
      });
    }
  };

  /* ───────────────────────── Runner ───────────────────────── */
  const Runner = {
    // Resolve the selected endpoints for the active group into {endpoint, cfg}[].
    // Endpoints missing an API key are dropped (with a warning) so a run never
    // sends an empty key. Returns null (and redirects) if nothing is runnable.
    selectedTargets() {
      const group = Store.activeGroup;
      const ids = Store.selectedIds(group);
      const targets = [];
      for (const id of ids) {
        const ep = Store.endpoint(group, id);
        if (!ep) continue;
        const models = Store.selectedModelIds(group, id);
        for (const model of models) {
          const cfg = cfgToRunPayload(ep, model);
          if (cfg.apiKey) targets.push({ endpoint: ep, model, cfg });
        }
      }
      if (!targets.length) {
        UI.flash('请先在端点管理为所选端点配置 API Key 并启用模型', 'error');
        Router.show('endpoints', group);
        return null;
      }
      return targets;
    },

    // Run one question across every selected endpoint and render them side-by-side.
    async runOne(q, card) {
      if (!Store.sessionUser) return UI.flash('需要登录', 'error');
      const targets = Runner.selectedTargets();
      if (!targets) return;
      Store.stopFlag = false;
      Cards.setBusy(card, true);
      Cards.toggle(card, true);
      UI.refreshControls();
      const batchId = Util.makeBatchId();
      try {
        UI.flash(`运行中 · ${q.name}`, 'running');
        const list = await Runner.runAcross(q, targets, batchId);
        Cards.renderResults(card, list);
        const okAll = list.every((x) => x.result.ok);
        UI.flash(okAll ? `完成 · ${q.name}` : `失败 · ${q.name}`, okAll ? 'done' : 'error');
      } finally {
        Cards.setBusy(card, false);
        UI.refreshControls();
      }
    },

    // Run a single question against all targets; store + return [{endpoint, result}].
    async runAcross(q, targets, batchId) {
      const list = [];
      for (const { endpoint, model, cfg } of targets) {
        if (Store.stopFlag) break;
        const controller = new AbortController();
        Store.inflight.add(controller);
        let result;
        try {
          const data = await Api.runTest({ question: q, cfg, batchId }, controller.signal);
          result = data.result;
        } catch (e) {
          result = { ok: false, error_message: e.message, question_id: q.id, question_name: q.name, model_group: q.group };
        } finally {
          Store.inflight.delete(controller);
        }
        list.push({ endpoint, model, result });
        Store.resultsById.set(`${q.id}::${endpoint.id}::${model}`, Object.assign({ endpoint_name: endpoint.name, model_id: model }, result));
        if (!Store.stopFlag && cfg.delay > 0) await Util.sleep(cfg.delay);
      }
      return list;
    },

    async runGroup() {
      if (Store.batchRunning) return;
      if (!Store.sessionUser) return UI.flash('需要登录', 'error');
      const targets = Runner.selectedTargets();
      if (!targets) return;
      Store.stopFlag = false;
      Store.batchRunning = true;
      UI.refreshControls();

      const qs = Store.questionsForGroup(Store.activeGroup).filter((q) => !Cards.isHiddenByFilter(q));
      const total = qs.length * targets.length; // question × (endpoint × model) pairs
      let next = 0, done = 0;
      const concurrency = Math.max(1, Math.min(20, Number(Util.el('opt-concurrency').value || 1)));
      const collapseAfter = Util.el('opt-collapse-after').checked;
      const batchId = Util.makeBatchId();
      UI.progress(0, total);

      const worker = async () => {
        while (!Store.stopFlag) {
          const idx = next++;
          if (idx >= qs.length) return;
          const q = qs[idx];
          const card = Cards.forId(q.id);
          if (!card) continue;
          Cards.setBusy(card, true);
          Cards.toggle(card, true);
          UI.flash(`${done}/${total} · ${q.name}`, 'running');
          const list = [];
          for (const { endpoint, model, cfg } of targets) {
            if (Store.stopFlag) break;
            const controller = new AbortController();
            Store.inflight.add(controller);
            let result;
            try {
              const data = await Api.runTest({ question: q, cfg, batchId }, controller.signal);
              result = data.result;
            } catch (e) {
              result = { ok: false, error_message: e.message, question_id: q.id, question_name: q.name, model_group: q.group };
            } finally {
              Store.inflight.delete(controller);
              done++;
              UI.flash(`${done}/${total}`, 'running');
              UI.progress(done, total);
            }
            list.push({ endpoint, model, result });
            Store.resultsById.set(`${q.id}::${endpoint.id}::${model}`, Object.assign({ endpoint_name: endpoint.name, model_id: model }, result));
            if (!Store.stopFlag && cfg.delay > 0) await Util.sleep(cfg.delay);
          }
          Cards.renderResults(card, list);
          if (collapseAfter && list.every((x) => x.result.ok)) Cards.toggle(card, false);
          Cards.setBusy(card, false);
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, qs.length) }, worker));
      Store.batchRunning = false;
      UI.refreshControls();
      UI.flash(Store.stopFlag ? `已停止 ${done}/${total}` : `完成 ${done}/${total}`, Store.stopFlag ? 'error' : 'done');
      setTimeout(UI.hideProgress, 1200);
      if (Store.activeView === 'history') Admin.refreshLogs();
    },

    stop() {
      Store.stopFlag = true;
      Store.inflight.forEach((ctl) => ctl.abort());
      Store.inflight.clear();
      UI.refreshControls();
    }
  };

  function exportLocalResults() {
    if (!Store.resultsById.size) return UI.flash('暂无结果', 'error');
    const blob = new Blob([JSON.stringify([...Store.resultsById.values()], null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `model-quality-${Store.activeGroup}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ───────────────────────── Router (views) ───────────────────────── */
  const VIEW_META = {
    endpoints: { title: '端点管理', desc: '配置各分组的 Base URL、模型、鉴权与 API Key，保存到数据库（全局共享）。' },
    history: { title: '测试历史', desc: '查看并导出已记录的测试运行日志。' },
    admin: { title: '管理', desc: '邀请新管理员、查看系统状态、同步模型价格。' }
  };

  const Router = {
    // view: 'test' | 'endpoints' | 'history' | 'admin'; group optional (for endpoints/test)
    show(view, group) {
      Store.activeView = view;
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
      // nav highlight
      document.querySelectorAll('#group-nav .nav-item').forEach((b) =>
        b.classList.toggle('active', view === 'test' && b.dataset.group === Store.activeGroup));
      document.querySelectorAll('#platform-nav .nav-item').forEach((b) =>
        b.classList.toggle('active', b.dataset.view === view));

      const title = Util.el('page-title');
      const desc = Util.el('page-desc');
      if (view === 'test') {
        if (title) title.textContent = Store.activeGroup;
        if (desc) desc.textContent = Store.GROUP_DESC[Store.activeGroup] || '';
      } else {
        const meta = VIEW_META[view] || {};
        if (title) title.textContent = meta.title || view;
        if (desc) desc.textContent = meta.desc || '';
      }

      if (view === 'test') Picker.render();
      if (view === 'endpoints') Config.fill(group || Store.editingGroup, (Store.list(group || Store.editingGroup)[0] || {}).id || null);
      if (view === 'history') Admin.refreshLogs();
    }
  };

  /* ───────────────────────── Group switching ───────────────────────── */
  function buildGroupNav() {
    const host = Util.el('group-nav');
    host.innerHTML = '';
    for (const group of Store.GROUPS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-item';
      btn.dataset.group = group;
      btn.innerHTML = `<span class="nav-ico">●</span><span>${Util.escapeHtml(group)}</span><span class="nav-count">${Store.questionsForGroup(group).length}</span>`;
      btn.addEventListener('click', () => applyGroup(group));
      host.appendChild(btn);
    }
  }

  function applyGroup(group, silent) {
    Store.activeGroup = group;
    document.body.dataset.group = group;
    const title = Util.el('page-title');
    const desc = Util.el('page-desc');
    if (title) title.textContent = group;
    if (desc) desc.textContent = Store.GROUP_DESC[group] || '';
    Cards.renderList();
    Picker.render();
    Router.show('test');
    if (!silent) UI.flash(group, 'done');
  }

  /* ───────────────────────── Boot ───────────────────────── */
  function boot() {
    Theme.init();

    if (!Array.isArray(window.QUESTIONS)) {
      Cards.grid().innerHTML = '<div class="warn-box">questions.js 未加载或未定义 QUESTIONS</div>';
      return;
    }

    $cfg = {
      name: Util.el('cfg-name'),
      baseUrl: Util.el('cfg-baseUrl'),
      apiKey: Util.el('cfg-apiKey'),
      authMode: Util.el('cfg-authMode'),
      maxTokens: Util.el('cfg-maxTokens'),
      timeout: Util.el('cfg-timeout'),
      delay: Util.el('cfg-delay'),
      system: Util.el('cfg-system'),
      imageN: Util.el('cfg-image-n'),
      imageQuality: Util.el('cfg-image-quality'),
      imageSize: Util.el('cfg-image-size')
    };

    buildGroupNav();
    bindEvents();
    applyGroup('OpenAI', true);
    Cards.renderList();
    Auth.refresh();
  }

  function bindEvents() {
    Util.el('run-all').addEventListener('click', Runner.runGroup);
    Util.el('stop').addEventListener('click', Runner.stop);
    Util.el('clear-results').addEventListener('click', Cards.clearResults);
    Util.el('export-results').addEventListener('click', exportLocalResults);

    Util.el('expand-all').addEventListener('click', () => Cards.all().forEach((c) => Cards.toggle(c, true)));
    Util.el('collapse-all').addEventListener('click', () => Cards.all().forEach((c) => Cards.toggle(c, false)));
    Util.el('filter-category').addEventListener('change', Cards.applyFilter);

    // Platform nav → switch views
    document.querySelectorAll('#platform-nav .nav-item').forEach((btn) => {
      btn.addEventListener('click', () => Router.show(btn.dataset.view));
    });

    // Endpoints page
    Util.el('save-endpoint').addEventListener('click', Config.save);
    Util.el('delete-endpoint').addEventListener('click', Config.remove);
    Util.el('detect-models').addEventListener('click', Config.detect);
    Util.el('sync-models').addEventListener('click', Config.sync);
    $cfg.name.addEventListener('input', Config.summary);
    // Changing the URL/key/auth invalidates a prior detection (must re-detect to save).
    $cfg.baseUrl.addEventListener('input', () => { Config.summary(); Config.invalidateDetect(); });
    $cfg.apiKey.addEventListener('input', Config.invalidateDetect);
    $cfg.authMode.addEventListener('change', Config.invalidateDetect);

    // History page
    Util.el('refresh-logs').addEventListener('click', Admin.refreshLogs);
    Util.el('export-logs').addEventListener('click', Admin.exportCsv);
    Util.el('history-group').addEventListener('change', Admin.refreshLogs);

    // Admin page
    Util.el('create-invite').addEventListener('click', Admin.createInvite);
    Util.el('system-status').addEventListener('click', Admin.systemStatus);
    Util.el('sync-prices').addEventListener('click', Admin.syncPrices);

    // Populate the history group filter from the providers
    const hist = Util.el('history-group');
    if (hist) {
      hist.innerHTML = '<option value="">全部分组</option>' +
        Store.GROUPS.map((g) => `<option value="${Util.escapeAttr(g)}">${Util.escapeHtml(g)}</option>`).join('');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
