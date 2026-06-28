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
    DEFAULTS: {
      OpenAI: { baseUrl: 'https://api.openai.com', model: 'gpt-5.5', authMode: 'bearer' },
      Anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-4.8', authMode: 'x-api-key' },
      Google: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-3.1-pro-preview', authMode: 'x-api-key' },
      Sakana: { baseUrl: 'https://api.sakana.ai', model: 'fugu-ultra', authMode: 'bearer' },
      Image: { baseUrl: 'https://api.openai.com', model: 'gpt-image-2', authMode: 'bearer' }
    },
    LS_PREFIX: 'mqt.config.',
    activeGroup: 'OpenAI',
    sessionUser: null,
    resultsById: new Map(),
    inflight: new Set(),
    stopFlag: false,
    batchRunning: false,

    defaultConfig(group) {
      return Object.assign({
        maxTokens: 1024, timeout: 120000, delay: 300, system: '',
        imageN: 1, imageQuality: 'medium', imageSize: '1024x1024'
      }, Store.DEFAULTS[group]);
    },
    questionsForGroup(group) {
      return window.QUESTIONS.filter((q) => q.group === group);
    }
  };

  // cached config field refs (filled in boot)
  let $cfg = {};

  function loadGroupConfig() {
    const defaults = Store.defaultConfig(Store.activeGroup);
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(Store.LS_PREFIX + Store.activeGroup) || '{}'); }
    catch (e) { saved = {}; }
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
    updateConfigSummary();
  }

  function saveGroupConfig() {
    if (!$cfg.remember.checked) {
      localStorage.removeItem(Store.LS_PREFIX + Store.activeGroup);
      updateConfigSummary();
      return;
    }
    localStorage.setItem(Store.LS_PREFIX + Store.activeGroup, JSON.stringify(readCfg(true)));
    updateConfigSummary();
  }

  function readCfg(includeRemember) {
    const cfg = {
      group: Store.activeGroup,
      baseUrl: $cfg.baseUrl.value.trim(),
      apiKey: $cfg.apiKey.value.trim(),
      model: $cfg.model.value.trim() || Store.DEFAULTS[Store.activeGroup].model,
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

  function updateConfigSummary() {
    const node = Util.el('config-summary');
    if (!node) return;
    let host = '';
    try { host = new URL($cfg.baseUrl.value).host; } catch (e) { host = ''; }
    node.textContent = `· ${$cfg.model.value || ''}${host ? ' @ ' + host : ''}`;
  }

  /* ───────────────────────── Theme ───────────────────────── */
  const Theme = {
    KEY: 'mqt.theme',
    init() {
      let t = 'dark';
      try { t = localStorage.getItem(Theme.KEY) || 'dark'; } catch (e) {}
      Theme.apply(t);
      const btn = Util.el('theme-toggle');
      if (btn) btn.addEventListener('click', Theme.toggle);
    },
    apply(t) {
      document.documentElement.dataset.theme = t;
      const btn = Util.el('theme-toggle');
      if (btn) btn.textContent = t === 'dark' ? '◐' : '☀';
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
      const adminBar = Util.el('admin-bar');

      if (authed) {
        chip.hidden = false;
        chip.innerHTML = `
          <span class="who">${Util.escapeHtml(status.user.displayName)}</span>
          <span class="role ${status.user.role === 'admin' ? 'admin' : ''}">${Util.escapeHtml(status.user.role)}</span>
          <button type="button" id="rotate-2fa" class="ghost" style="min-height:28px;padding:3px 10px;font-size:12px">2FA</button>
          <button type="button" id="logout" class="ghost" style="min-height:28px;padding:3px 10px;font-size:12px">退出</button>`;
        Util.el('rotate-2fa').addEventListener('click', Auth.startRotation);
        Util.el('logout').addEventListener('click', Auth.logout);

        adminBar.hidden = status.user.role !== 'admin';
        if (status.insecureDevSecret) {
          Auth.sessionPanel(`<div class="warn-box">SESSION_SECRET 使用了不安全的默认值，请在部署环境配置强随机密钥。</div>`);
        }
        return;
      }

      // locked
      chip.hidden = true;
      adminBar.hidden = true;
      const foot = Util.el('auth-foot');
      if (foot) foot.innerHTML = `<span class="dot ok"></span>已连接 · 使用 TOTP 登录或绑定邀请码`;
      const flow = Util.el('auth-flow');
      flow.innerHTML = `
        <div class="auth-form">
          <input id="auth-name" type="text" placeholder="用户名" autocomplete="username" />
          <input id="auth-token" class="short" type="text" inputmode="numeric" placeholder="TOTP" autocomplete="one-time-code" />
          <button id="login-btn" class="primary" type="button">登录</button>
        </div>
        <div class="auth-divider">首次使用 / 受邀加入</div>
        <div class="auth-form subtle">
          <input id="invite-code" type="text" placeholder="邀请码" />
          <button id="start-enroll" type="button">绑定 2FA</button>
        </div>`;
      Util.el('auth-output').innerHTML = '';
      Util.el('login-btn').addEventListener('click', Auth.login);
      Util.el('start-enroll').addEventListener('click', Auth.startEnroll);
      const onEnter = (e) => { if (e.key === 'Enter') Auth.login(); };
      Util.el('auth-name').addEventListener('keydown', onEnter);
      Util.el('auth-token').addEventListener('keydown', onEnter);
    },

    // session panel for 2FA rotation / warnings shown inside the workspace
    sessionPanel(html) {
      let panel = Util.el('session-panel');
      if (!panel) {
        panel = document.createElement('section');
        panel.id = 'session-panel';
        panel.className = 'card';
        panel.style.padding = '14px 16px';
        const ws = Util.el('workspace');
        ws.insertBefore(panel, ws.firstChild);
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

    async startEnroll() {
      const out = Util.el('auth-output');
      try {
        const data = await Api.call('/api/auth/enroll', {
          method: 'POST',
          body: JSON.stringify({
            displayName: Util.el('auth-name').value,
            inviteCode: Util.el('invite-code').value
          })
        });
        out.innerHTML = Auth.totpSetupHtml(data, 'enroll-token', 'finish-enroll', '完成绑定');
        Util.el('finish-enroll').addEventListener('click', async () => {
          try {
            await Api.call('/api/auth/enroll', {
              method: 'POST',
              body: JSON.stringify({ enrollmentId: data.enrollmentId, token: Util.el('enroll-token').value })
            });
            Auth.refresh();
          } catch (e) {
            out.innerHTML += `<div class="warn-box">绑定失败：${Util.escapeHtml(e.message)}</div>`;
          }
        });
      } catch (e) {
        out.innerHTML = `<div class="warn-box">绑定失败：${Util.escapeHtml(e.message)}</div>`;
      }
    },

    async startRotation() {
      try {
        const data = await Api.call('/api/auth/2fa', { method: 'POST', body: JSON.stringify({ action: 'start' }) });
        const panel = Auth.sessionPanel(
          `<div class="dot-label" style="margin-bottom:12px"><span class="dot accent"></span>轮换两步验证</div>
           <div id="twofa-output"></div>`
        );
        panel.querySelector('#twofa-output').innerHTML =
          Auth.totpSetupHtml(data, 'rotate-token', 'finish-rotate-2fa', '保存');
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

    totpSetupHtml(data, inputId, buttonId, buttonText) {
      const qr = data.qrSvg ? `<div class="qr-box">${data.qrSvg}</div>` : '';
      return `
        <div class="totp-setup">
          ${qr}
          <code>${Util.escapeHtml(data.secret || '')}</code>
          <pre class="code" style="width:100%">${Util.escapeHtml(data.otpauthUrl || '')}</pre>
          <div class="auth-form" style="box-shadow:none">
            <input id="${inputId}" type="text" inputmode="numeric" placeholder="TOTP 验证码" autocomplete="one-time-code" />
            <button id="${buttonId}" class="primary" type="button">${Util.escapeHtml(buttonText)}</button>
          </div>
        </div>`;
    }
  };

  /* ───────────────────────── Admin ───────────────────────── */
  const Admin = {
    out() { return Util.el('admin-output'); },

    async createInvite() {
      try {
        const data = await Api.call('/api/admin/invites', { method: 'POST', body: JSON.stringify({ maxUses: 1, expiresHours: 168 }) });
        Admin.out().innerHTML = `<div class="ok-box">邀请码：<code>${Util.escapeHtml(data.code)}</code></div>`;
        await Admin.refreshLogs();
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

    async refreshLogs() {
      try {
        const g = Store.activeGroup ? `&group=${encodeURIComponent(Store.activeGroup)}` : '';
        const data = await Api.call(`/api/admin/logs?limit=20${g}`, { method: 'GET', headers: {} });
        Admin.out().innerHTML = Admin.logTable(data.logs || []);
      } catch (e) { Admin.fail(e); }
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

    renderResult(card, result) {
      card.classList.remove('ok', 'fail');
      card.classList.add(result.ok ? 'ok' : 'fail', 'has-result');
      const meta = card.querySelector('.qcard-meta-row');
      meta.innerHTML = [
        Util.badge(result.ok ? 'OK' : 'FAIL', result.ok ? 'ok' : 'fail'),
        result.response_status ? Util.badge(`HTTP ${result.response_status}`) : '',
        (result.routed_model_id || result.model_id) ? Util.badge(`model=${Util.escapeHtml(result.routed_model_id || result.model_id)}`) : '',
        result.elapsed_ms != null ? Util.badge(`${result.elapsed_ms} ms`) : '',
        result.estimated_cost_usd != null ? Util.badge(`$${Util.formatCost(result.estimated_cost_usd)}`, 'info') : ''
      ].filter(Boolean).join('');

      Cards.ensureBody(card);
      const host = card.querySelector('.qcard-result');
      host.innerHTML = '';
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
    async runOne(q, card) {
      if (!Store.sessionUser) return UI.flash('需要登录', 'error');
      const cfg = readCfg(false);
      if (!cfg.apiKey) return UI.flash('缺少 API Key', 'error');
      saveGroupConfig();
      Store.stopFlag = false;
      Cards.setBusy(card, true);
      Cards.toggle(card, true);
      const controller = new AbortController();
      Store.inflight.add(controller);
      UI.refreshControls();
      try {
        UI.flash(`运行中 · ${q.name}`, 'running');
        const data = await Api.runTest({ question: q, cfg, batchId: Util.makeBatchId() }, controller.signal);
        Store.resultsById.set(q.id, data.result);
        Cards.renderResult(card, data.result);
        UI.flash(data.result.ok ? `完成 · ${q.name}` : `失败 · ${q.name}`, data.result.ok ? 'done' : 'error');
      } catch (e) {
        Cards.renderResult(card, { ok: false, error_message: e.message, question_id: q.id, question_name: q.name, model_group: q.group });
        UI.flash(`失败 · ${e.message}`, 'error');
      } finally {
        Store.inflight.delete(controller);
        Cards.setBusy(card, false);
        UI.refreshControls();
      }
    },

    async runGroup() {
      if (Store.batchRunning) return;
      if (!Store.sessionUser) return UI.flash('需要登录', 'error');
      const cfg = readCfg(false);
      if (!cfg.apiKey) return UI.flash('缺少 API Key', 'error');
      saveGroupConfig();
      Store.stopFlag = false;
      Store.batchRunning = true;
      UI.refreshControls();

      const qs = Store.questionsForGroup(Store.activeGroup).filter((q) => !Cards.isHiddenByFilter(q));
      const total = qs.length;
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
          const controller = new AbortController();
          Store.inflight.add(controller);
          try {
            const data = await Api.runTest({ question: q, cfg, batchId }, controller.signal);
            Store.resultsById.set(q.id, data.result);
            Cards.renderResult(card, data.result);
            if (collapseAfter && data.result.ok) Cards.toggle(card, false);
          } catch (e) {
            Cards.renderResult(card, { ok: false, error_message: e.message, question_id: q.id, question_name: q.name, model_group: q.group });
          } finally {
            Store.inflight.delete(controller);
            Cards.setBusy(card, false);
            done++;
            UI.flash(`${done}/${total}`, 'running');
            UI.progress(done, total);
            if (!Store.stopFlag && cfg.delay > 0) await Util.sleep(cfg.delay);
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
      Store.batchRunning = false;
      UI.refreshControls();
      UI.flash(Store.stopFlag ? `已停止 ${done}/${total}` : `完成 ${done}/${total}`, Store.stopFlag ? 'error' : 'done');
      setTimeout(UI.hideProgress, 1200);
      const adminBar = Util.el('admin-bar');
      if (adminBar && !adminBar.hidden) Admin.refreshLogs();
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

  /* ───────────────────────── Group switching ───────────────────────── */
  function buildGroupTabs() {
    const host = Util.el('group-tabs');
    host.innerHTML = '';
    for (const group of Store.GROUPS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'group-tab';
      btn.dataset.group = group;
      btn.innerHTML = `${Util.escapeHtml(group)} <span class="gt-count">${Store.questionsForGroup(group).length}</span>`;
      btn.addEventListener('click', () => applyGroup(group));
      host.appendChild(btn);
    }
  }

  function applyGroup(group, silent) {
    Store.activeGroup = group;
    $cfg.group.value = group;
    loadGroupConfig();
    document.body.dataset.group = group;
    document.querySelectorAll('.group-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.group === group);
    });
    Cards.renderList();
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
      group: Util.el('cfg-group'),
      baseUrl: Util.el('cfg-baseUrl'),
      apiKey: Util.el('cfg-apiKey'),
      model: Util.el('cfg-model'),
      authMode: Util.el('cfg-authMode'),
      maxTokens: Util.el('cfg-maxTokens'),
      timeout: Util.el('cfg-timeout'),
      delay: Util.el('cfg-delay'),
      system: Util.el('cfg-system'),
      remember: Util.el('cfg-remember'),
      imageN: Util.el('cfg-image-n'),
      imageQuality: Util.el('cfg-image-quality'),
      imageSize: Util.el('cfg-image-size')
    };

    buildGroupTabs();
    bindEvents();
    applyGroup('OpenAI', true);
    loadGroupConfig();
    Cards.renderList();
    Auth.refresh();
  }

  function bindEvents() {
    $cfg.group.addEventListener('change', () => applyGroup($cfg.group.value));
    Util.el('config-toggle').addEventListener('click', () => Util.el('config-panel').classList.toggle('collapsed'));

    Util.el('run-all').addEventListener('click', Runner.runGroup);
    Util.el('stop').addEventListener('click', Runner.stop);
    Util.el('clear-results').addEventListener('click', Cards.clearResults);
    Util.el('export-results').addEventListener('click', exportLocalResults);

    Util.el('expand-all').addEventListener('click', () => Cards.all().forEach((c) => Cards.toggle(c, true)));
    Util.el('collapse-all').addEventListener('click', () => Cards.all().forEach((c) => Cards.toggle(c, false)));
    Util.el('filter-category').addEventListener('change', Cards.applyFilter);

    Util.el('create-invite').addEventListener('click', Admin.createInvite);
    Util.el('system-status').addEventListener('click', Admin.systemStatus);
    Util.el('sync-prices').addEventListener('click', Admin.syncPrices);
    Util.el('refresh-logs').addEventListener('click', Admin.refreshLogs);
    Util.el('export-logs').addEventListener('click', Admin.exportCsv);

    for (const node of Object.values($cfg)) {
      if (!node || node === $cfg.group) continue;
      node.addEventListener('change', saveGroupConfig);
    }
    $cfg.baseUrl.addEventListener('input', updateConfigSummary);
    $cfg.model.addEventListener('input', updateConfigSummary);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
