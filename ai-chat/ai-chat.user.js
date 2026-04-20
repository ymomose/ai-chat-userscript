// ==UserScript==
// @name         AI Chat Overlay
// @name:ja      AI チャット オーバーレイ
// @namespace    https://github.com/ym/userscripts/ai-chat
// @version      0.1.0
// @description  Floating AI chat (Gemini) with page context, per-domain history, templates, and Google Drive backup. Optimized for iOS Safari.
// @description:ja Webページの内容を文脈として Gemini と対話できるオーバーレイ AI チャット。ドメインごとの履歴・テンプレート・Google Drive バックアップ対応。iOS Safari 最適化。
// @author       ym
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.listValues
// @grant        GM_openInTab
// @grant        GM.openInTab
// @connect      generativelanguage.googleapis.com
// @connect      www.googleapis.com
// @connect      oauth2.googleapis.com
// @require      https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js
// @require      https://cdn.jsdelivr.net/npm/dompurify@3.0.11/dist/purify.min.js
// @require      https://cdn.tailwindcss.com/3.4.16
// @require      https://cdn.jsdelivr.net/npm/@mozilla/readability@0.5.0/Readability.js
// @noframes
// ==/UserScript==

/* global marked, DOMPurify, Readability */
(() => {
  'use strict';
  if (window.top !== window.self) return; // ignore iframes
  if (window.__AICX_LOADED__) return;
  window.__AICX_LOADED__ = true;

  // =========================================================================
  // 1. GM API shim  (works across Tampermonkey / Violentmonkey / Userscripts iOS)
  // =========================================================================
  const hasGM = typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function';
  const hasGMlegacy = typeof GM_getValue === 'function';
  const KV_PREFIX = 'aicx:';
  const KV = {
    async get(key, def) {
      try {
        if (hasGM) return (await GM.getValue(key, def));
        if (hasGMlegacy) return GM_getValue(key, def);
      } catch (e) { /* fall through */ }
      try {
        const raw = localStorage.getItem(KV_PREFIX + key);
        return raw == null ? def : JSON.parse(raw);
      } catch { return def; }
    },
    async set(key, val) {
      try {
        if (hasGM) return await GM.setValue(key, val);
        if (hasGMlegacy) return GM_setValue(key, val);
      } catch (e) { /* fall through */ }
      try { localStorage.setItem(KV_PREFIX + key, JSON.stringify(val)); } catch {}
    },
    async del(key) {
      try {
        if (hasGM) return await GM.deleteValue(key);
        if (typeof GM_deleteValue === 'function') return GM_deleteValue(key);
      } catch {}
      try { localStorage.removeItem(KV_PREFIX + key); } catch {}
    }
  };

  // =========================================================================
  // 2. Utilities
  // =========================================================================
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const now = () => Date.now();
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };
  const fmtDate = (ts) => {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const getDomain = () => location.hostname || 'unknown';
  const el = (tag, props = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(n.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === false || v == null) continue;
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null || c === false) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  };
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
  const copyToClipboard = async (text) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch { return false; }
  };

  // =========================================================================
  // 3. Storage + data model
  // =========================================================================
  const DEFAULT_SETTINGS = {
    apiKey: '',
    model: 'gemini-2.5-flash',
    globalSystemPrompt: 'You are a helpful AI assistant. The user is viewing a webpage; use its content as context. Respond in the same language as the user.',
    theme: 'system', // light | dark | system
    autoBackup: false,
    driveClientId: '',
    driveToken: '',
    driveTokenExp: 0,
    driveFileId: '',
    lastBackupAt: 0,
    buttonPos: null, // { x, y } fraction of viewport
    chatHeightPct: 70, // chat sheet height as percentage of viewport
    globalTemplates: [], // array of { id, name, prompt } usable on any domain
    // How to extract page text for AI context:
    //   'auto'  : Mozilla Readability → falls back to 'clean' if it yields nothing
    //   'clean' : heuristic — strip header/footer/nav/aside/[aria-hidden]/[hidden]
    //   'raw'   : legacy — strip only script/style/svg/iframe/video/audio/canvas
    pageExtractMode: 'auto'
  };

  const Store = {
    settings: { ...DEFAULT_SETTINGS },
    domains: {}, // { [host]: { systemPrompt?, templates: [], conversations: [] } }
    async load() {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, await KV.get('settings', {}));
      this.domains = await KV.get('domains', {});
    },
    async saveSettings() { await KV.set('settings', this.settings); },
    async saveDomains() { await KV.set('domains', this.domains); },
    async saveAll() { await this.saveSettings(); await this.saveDomains(); },
    getDomain(host) {
      host = host || getDomain();
      if (!this.domains[host]) {
        this.domains[host] = { systemPrompt: '', templates: [], conversations: [] };
      }
      return this.domains[host];
    },
    usedDomains() {
      return Object.entries(this.domains)
        .filter(([, d]) => (d.conversations && d.conversations.length) || (d.templates && d.templates.length) || (d.systemPrompt && d.systemPrompt.trim()))
        .map(([host]) => host)
        .sort();
    },
    newConversation(host) {
      const d = this.getDomain(host);
      const c = { id: uid(), title: '', createdAt: now(), updatedAt: now(), messages: [] };
      d.conversations.unshift(c);
      return c;
    },
    upsertConversation(host, conv) {
      const d = this.getDomain(host);
      const idx = d.conversations.findIndex((x) => x.id === conv.id);
      conv.updatedAt = now();
      if (idx >= 0) d.conversations[idx] = conv; else d.conversations.unshift(conv);
    },
    removeConversation(host, id) {
      const d = this.getDomain(host);
      d.conversations = d.conversations.filter((c) => c.id !== id);
    },
    resolveSystemPrompt(host) {
      host = host || getDomain();
      const d = this.domains[host];
      const override = d && d.systemPrompt && d.systemPrompt.trim();
      return override || this.settings.globalSystemPrompt || '';
    },
    resolvePageExtractMode(host) {
      host = host || getDomain();
      const d = this.domains[host];
      const dMode = d && d.pageExtractMode;
      if (dMode && dMode !== 'inherit') return dMode;
      return this.settings.pageExtractMode || 'auto';
    }
  };

  // =========================================================================
  // 4. Gemini API client
  // =========================================================================
  const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const Gemini = {
    async listModels(apiKey) {
      if (!apiKey) throw new Error('API key is required.');
      const res = await fetch(`${API_BASE}/models?pageSize=200&key=${encodeURIComponent(apiKey)}`);
      if (!res.ok) throw new Error(`Gemini listModels failed: ${res.status} ${await res.text()}`);
      const data = await res.json();
      const models = (data.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'));
      models.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      return models.map((m) => ({
        id: (m.name || '').replace(/^models\//, ''),
        display: m.displayName || m.name,
        desc: m.description || '',
        inputTokens: m.inputTokenLimit,
        outputTokens: m.outputTokenLimit
      }));
    },

    // Build Gemini "contents" array from our message history
    buildContents(messages) {
      const contents = [];
      for (const m of messages) {
        if (m.role === 'system') continue;
        const role = m.role === 'assistant' ? 'model' : 'user';
        const parts = [];
        if (m.attachments) {
          for (const a of m.attachments) {
            // dataUrl -> inlineData
            const match = /^data:([^;]+);base64,(.*)$/.exec(a.dataUrl || '');
            if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          }
        }
        if (m.content && m.content.trim()) parts.push({ text: m.content });
        if (parts.length) contents.push({ role, parts });
      }
      return contents;
    },

    async *streamGenerate({ apiKey, model, messages, systemPrompt, tools, onMetadata, signal }) {
      if (!apiKey) throw new Error('API キーが設定されていません。設定画面から登録してください。');
      if (!model) throw new Error('モデルが選択されていません。');
      const url = `${API_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
      const body = {
        contents: this.buildContents(messages),
        generationConfig: { temperature: 0.7 }
      };
      if (systemPrompt && systemPrompt.trim()) {
        body.systemInstruction = { role: 'user', parts: [{ text: systemPrompt }] };
      }
      if (tools && tools.length) body.tools = tools;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });
      if (!res.ok || !res.body) {
        const t = await res.text();
        throw new Error(`Gemini request failed: ${res.status} ${t}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE: split on double newlines
        const parts = buf.split(/\r?\n\r?\n/);
        buf = parts.pop();
        for (const chunk of parts) {
          const lines = chunk.split(/\r?\n/).filter((l) => l.startsWith('data:'));
          for (const line of lines) {
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let obj;
            try { obj = JSON.parse(payload); } catch { continue; }
            if (obj && obj.error) {
              throw new Error((obj.error.message || 'Gemini API error') + (obj.error.status ? ` (${obj.error.status})` : ''));
            }
            const cand = obj && obj.candidates && obj.candidates[0];
            const parts2 = cand && cand.content && cand.content.parts;
            if (parts2) {
              for (const p of parts2) if (p.text) yield p.text;
            }
            if (cand && cand.groundingMetadata && typeof onMetadata === 'function') {
              try { onMetadata(cand.groundingMetadata); } catch {}
            }
            if (cand && cand.finishReason && cand.finishReason !== 'STOP' && cand.finishReason !== 'FINISH_REASON_UNSPECIFIED') {
              // Safety block or length cap — surface to user via a tail message
              yield `\n\n_(finishReason: ${cand.finishReason})_`;
            }
          }
        }
      }
    }
  };

  // =========================================================================
  // 5. Google Drive (OAuth2 Implicit flow + Drive v3)
  // =========================================================================
  const DRIVE_FILE_NAME = 'ai-chat-overlay-backup.json';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

  const Drive = {
    isTokenValid() {
      const s = Store.settings;
      return !!s.driveToken && s.driveTokenExp > now() + 30_000;
    },
    startOAuth(clientId) {
      if (!clientId) throw new Error('Google OAuth Client ID が未設定です。');
      // Use current page URL (without hash) as redirect — must be registered as allowed origin/redirect in the OAuth client.
      const redirectUri = location.origin + location.pathname;
      const state = uid();
      sessionStorage.setItem('aicx:oauthState', state);
      const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      u.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'token',
        scope: DRIVE_SCOPE,
        include_granted_scopes: 'true',
        state,
        prompt: 'consent'
      }).toString();
      location.href = u.toString();
    },
    consumeOAuthHash() {
      if (!location.hash || location.hash.indexOf('access_token=') < 0) return false;
      const p = new URLSearchParams(location.hash.slice(1));
      const token = p.get('access_token');
      const expIn = Number(p.get('expires_in') || 3600);
      const state = p.get('state');
      if (!token) return false;
      if (state && sessionStorage.getItem('aicx:oauthState') !== state) {
        console.warn('[aicx] OAuth state mismatch; ignoring token.');
        return false;
      }
      Store.settings.driveToken = token;
      Store.settings.driveTokenExp = now() + expIn * 1000;
      Store.saveSettings();
      sessionStorage.removeItem('aicx:oauthState');
      // Clean URL
      try { history.replaceState(null, '', location.pathname + location.search); } catch {}
      return true;
    },
    async signOut() {
      Store.settings.driveToken = '';
      Store.settings.driveTokenExp = 0;
      await Store.saveSettings();
    },
    async _fetch(url, opts = {}) {
      if (!this.isTokenValid()) throw new Error('Google Drive トークンが無効/期限切れです。再接続してください。');
      const headers = Object.assign({}, opts.headers || {}, { Authorization: `Bearer ${Store.settings.driveToken}` });
      const res = await fetch(url, Object.assign({}, opts, { headers }));
      if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`);
      return res;
    },
    async findOrCreateFile() {
      if (Store.settings.driveFileId) return Store.settings.driveFileId;
      // search appDataFolder
      const q = encodeURIComponent(`name = '${DRIVE_FILE_NAME}' and trashed = false`);
      const list = await this._fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=appDataFolder&fields=files(id,name)`);
      const data = await list.json();
      if (data.files && data.files.length) {
        Store.settings.driveFileId = data.files[0].id;
        await Store.saveSettings();
        return data.files[0].id;
      }
      const meta = { name: DRIVE_FILE_NAME, parents: ['appDataFolder'] };
      const created = await this._fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(meta)
      });
      const cdata = await created.json();
      Store.settings.driveFileId = cdata.id;
      await Store.saveSettings();
      return cdata.id;
    },
    async upload() {
      const id = await this.findOrCreateFile();
      const payload = {
        version: 1,
        exportedAt: now(),
        settings: { ...Store.settings, driveToken: '', driveTokenExp: 0, driveFileId: '' },
        domains: Store.domains
      };
      await this._fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      Store.settings.lastBackupAt = now();
      await Store.saveSettings();
    },
    async download() {
      const id = await this.findOrCreateFile();
      const res = await this._fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
      const text = await res.text();
      if (!text || !text.trim()) throw new Error('バックアップファイルが空です。');
      const data = JSON.parse(text);
      if (!data || !data.settings) throw new Error('バックアップが不正な形式です。');
      // Merge settings (keep our token/file id)
      const { driveToken, driveTokenExp, driveFileId } = Store.settings;
      Store.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings, { driveToken, driveTokenExp, driveFileId });
      Store.domains = data.domains || {};
      await Store.saveAll();
    }
  };

  // =========================================================================
  // 6. Page context extractor
  // =========================================================================
  const Page = {
    // Base strip list — tags whose visible text is either noise or unparseable
    // regardless of extraction mode.
    BASE_STRIP: 'script,style,noscript,svg,iframe,video,audio,canvas,template',
    // Additional selectors for 'clean' mode: chrome elements whose text is
    // almost always navigation / boilerplate, plus elements the page has
    // declared as hidden via aria/hidden.
    CHROME_STRIP: [
      'header', 'footer', 'nav', 'aside',
      '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]', '[role="search"]',
      '[aria-hidden="true"]', '[hidden]'
    ].join(','),
    MAX_TEXT: 20000,

    snapshot() {
      const selection = (window.getSelection && String(window.getSelection())) || '';
      const title = document.title || '';
      const metaDesc = (document.querySelector('meta[name="description"]') || {}).content || '';
      const url = location.href;

      const mode = Store.resolvePageExtractMode();
      let text = '';
      let effectiveMode = mode;

      if (mode === 'auto') {
        text = this._extractReadability();
        if (!text) { effectiveMode = 'clean'; text = this._extractHeuristic(true); }
      } else if (mode === 'clean') {
        text = this._extractHeuristic(true);
      } else {
        text = this._extractHeuristic(false);
      }

      if (text.length > this.MAX_TEXT) text = text.slice(0, this.MAX_TEXT) + '\n...[truncated]';
      return { url, title, metaDesc, selection: selection.slice(0, 4000), text, mode: effectiveMode };
    },

    // Remove the overlay's own DOM from a cloned tree so the chat UI text
    // (user messages, assistant replies, settings labels, etc.) doesn't get
    // fed back into itself as "page context". Without this, typing into the
    // composer and then asking about the page leaks the chat itself into
    // the prompt on the next turn.
    _stripSelf(clone) {
      if (!clone || !clone.querySelectorAll) return;
      clone.querySelectorAll('#aicx-root').forEach((n) => n.remove());
    },

    // Try Mozilla Readability on a cloned document. Returns '' if the library
    // is unavailable, throws, or yields a suspiciously short result.
    _extractReadability() {
      try {
        if (typeof Readability === 'undefined') return '';
        const docClone = document.cloneNode(true);
        this._stripSelf(docClone);
        const article = new Readability(docClone).parse();
        if (!article) return '';
        const t = (article.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        // Readability sometimes picks a tiny unrelated node on SPA / doc sites;
        // treat <200 chars as "failed" so callers can fall back.
        return t.length >= 200 ? t : '';
      } catch (e) {
        console.warn('[aicx] Readability failed:', e);
        return '';
      }
    },

    // Heuristic extraction. When `stripChrome` is true, also removes
    // header/nav/footer/aside/aria-hidden/hidden elements.
    _extractHeuristic(stripChrome) {
      const root = document.querySelector('article') || document.querySelector('main') || document.body;
      if (!root) return '';
      const clone = root.cloneNode(true);
      this._stripSelf(clone);
      clone.querySelectorAll(this.BASE_STRIP).forEach((n) => n.remove());
      if (stripChrome) clone.querySelectorAll(this.CHROME_STRIP).forEach((n) => n.remove());
      return (clone.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    },

    formatForPrompt(snap) {
      const parts = [
        `# Current Page Context`,
        `URL: ${snap.url}`,
        `Title: ${snap.title}`
      ];
      if (snap.metaDesc) parts.push(`Description: ${snap.metaDesc}`);
      if (snap.selection) parts.push(`\nSelected text:\n"""\n${snap.selection}\n"""`);
      if (snap.text) parts.push(`\nPage text:\n"""\n${snap.text}\n"""`);
      return parts.join('\n');
    }
  };

  // =========================================================================
  // 7. Markdown renderer (marked + DOMPurify; Tailwind-class adorned)
  // =========================================================================
  const MD = {
    ready: false,
    init() {
      if (this.ready || typeof marked === 'undefined') return;
      marked.setOptions({ breaks: true, gfm: true });
      this.ready = true;
    },
    render(text) {
      this.init();
      const raw = this.ready ? marked.parse(String(text || '')) : esc(text).replace(/\n/g, '<br>');
      const clean = (typeof DOMPurify !== 'undefined')
        ? DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
        : raw;
      return this.decorate(clean);
    },
    // Add Tailwind classes so rendered markdown looks right under our scoped tailwind
    decorate(html) {
      const tpl = document.createElement('div');
      tpl.innerHTML = html;
      const map = [
        ['h1', 'text-xl font-bold mt-4 mb-2'],
        ['h2', 'text-lg font-bold mt-3 mb-2'],
        ['h3', 'text-base font-bold mt-2 mb-1'],
        ['h4', 'text-sm font-bold mt-2 mb-1'],
        ['h5', 'text-sm font-semibold mt-1'],
        ['h6', 'text-xs font-semibold mt-1'],
        ['p',  'my-2 leading-relaxed'],
        ['ul', 'list-disc ml-5 my-2 space-y-1'],
        ['ol', 'list-decimal ml-5 my-2 space-y-1'],
        ['li', ''],
        ['blockquote', 'border-l-4 border-zinc-300 dark:border-zinc-600 pl-3 my-2 text-zinc-600 dark:text-zinc-300 italic'],
        ['a',  'text-blue-600 dark:text-blue-400 underline break-all'],
        ['code', 'px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 font-mono text-[0.85em]'],
        ['pre', 'p-3 my-2 rounded-lg bg-zinc-900 text-zinc-100 overflow-x-auto text-xs font-mono'],
        ['table', 'my-2 border-collapse w-full text-sm'],
        ['th', 'border border-zinc-300 dark:border-zinc-600 px-2 py-1 bg-zinc-100 dark:bg-zinc-800 font-semibold text-left'],
        ['td', 'border border-zinc-300 dark:border-zinc-600 px-2 py-1 align-top'],
        ['hr', 'my-3 border-zinc-200 dark:border-zinc-700'],
        ['img', 'max-w-full h-auto rounded-md my-2'],
        ['details', 'my-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50'],
        ['summary', 'cursor-pointer select-none px-3 py-2 text-xs font-semibold text-zinc-600 dark:text-zinc-300'],
      ];
      for (const [tag, cls] of map) {
        tpl.querySelectorAll(tag).forEach((n) => {
          if (cls) n.className = ((n.className ? n.className + ' ' : '') + cls);
        });
      }
      // <pre><code> inside pre: reset inline code styles
      tpl.querySelectorAll('pre code').forEach((n) => { n.className = 'bg-transparent p-0 text-inherit'; });
      // External links: target blank + noopener
      tpl.querySelectorAll('a[href]').forEach((a) => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      });
      return tpl.innerHTML;
    }
  };

  // =========================================================================
  // 8. Theme
  // =========================================================================
  const Theme = {
    mql: null,
    root: null,
    install(root) {
      this.root = root;
      this.mql = matchMedia('(prefers-color-scheme: dark)');
      const apply = () => this.apply();
      if (this.mql.addEventListener) this.mql.addEventListener('change', apply);
      else if (this.mql.addListener) this.mql.addListener(apply);
      this.apply();
    },
    apply() {
      if (!this.root) return;
      const pref = Store.settings.theme || 'system';
      const dark = pref === 'dark' || (pref === 'system' && this.mql && this.mql.matches);
      this.root.classList.toggle('dark', dark);
      this.root.setAttribute('data-theme', dark ? 'dark' : 'light');
    }
  };

  // =========================================================================
  // 9. Tailwind bootstrap  (scoped to #aicx-root via `important` config)
  // =========================================================================
  const TailwindBoot = {
    loaded: false,
    load() {
      if (this.loaded) return Promise.resolve();
      // Tailwind Play CDN is loaded via @require, so it executes before this
      // script runs — bypassing the page's script-src CSP. Setting config here
      // triggers the Proxy setter installed by the CDN, which schedules the
      // initial CSS generation with our config.
      try {
        if (window.tailwind) {
          window.tailwind.config = {
            darkMode: 'class',
            corePlugins: { preflight: false },
            theme: {
              extend: {
                fontFamily: {
                  sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Helvetica', 'Arial', 'sans-serif'],
                  mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace']
                }
              }
            }
          };
        }
      } catch (e) { console.warn('[aicx] tailwind config failed:', e); }
      this.loaded = true;
      return Promise.resolve();
    },
    // Install scoped base styles (mini "preflight" confined to our root) so page CSS
    // can't bleed into our UI, and vice versa.
    installBase() {
      if (document.getElementById('aicx-base')) return;
      const css = `
/* AI Chat Overlay — scoped base */
#aicx-root {
  all: initial;
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483000;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: rgb(24,24,27);
  -webkit-tap-highlight-color: transparent;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
#aicx-root .aicx-stage {
  position: absolute;
  inset: 0;
  pointer-events: none;
  color: inherit;
}
#aicx-root .dark { color: rgb(228,228,231); }
/* Element-level reset wrapped in :where() so specificity is 0.
   Tailwind utilities (specificity 0,1,0) always override these resets. */
:where(#aicx-root *, #aicx-root *::before, #aicx-root *::after) {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border: 0 solid currentColor;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  color: inherit;
  background-color: transparent;
  background-image: none;
  text-decoration: none;
  list-style: none;
}
:where(
  #aicx-root button,
  #aicx-root input:not([type="checkbox"]):not([type="radio"]),
  #aicx-root textarea,
  #aicx-root select
) {
  font: inherit; color: inherit; background-color: transparent;
  appearance: none; -webkit-appearance: none; outline: none;
}
:where(
  #aicx-root input:not([type="checkbox"]):not([type="radio"]),
  #aicx-root textarea,
  #aicx-root select
) {
  border-radius: 8px; padding: 8px 10px;
}
/* Prevent iOS Safari auto-zoom on focus: font-size must be >= 16px.
   Scoped to touch devices so desktop layout is unaffected. Uses #aicx-root
   prefix (specificity 1,0,1) so it beats Tailwind's .text-sm / .text-xs. */
@media (hover: none) and (pointer: coarse) {
  #aicx-root input:not([type="checkbox"]):not([type="radio"]),
  #aicx-root textarea,
  #aicx-root select {
    font-size: 16px;
  }
}
:where(#aicx-root button) { cursor: pointer; touch-action: manipulation; }
:where(#aicx-root img) { max-width: 100%; height: auto; display: block; }
:where(#aicx-root svg) { display: inline-block; vertical-align: middle; }
:where(#aicx-root textarea) { resize: none; }
/* Functional utilities (not intended to be overridden by Tailwind) */
#aicx-root [data-active="true"] { pointer-events: auto; }
#aicx-root .aicx-panel { pointer-events: auto; }
#aicx-root .aicx-scroll { -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
#aicx-root .aicx-tap { touch-action: manipulation; user-select: none; -webkit-user-select: none; }
/* aicx-full wrapped in :where() so sm:h-[...] can override it at breakpoints */
:where(#aicx-root .aicx-full) { height: 100dvh; max-height: 100dvh; }
/* Resize handle */
#aicx-root .aicx-resize { touch-action: none; cursor: ns-resize; user-select: none; -webkit-user-select: none; }
/* Sheet enter animation */
@keyframes aicx-slide-up { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
@keyframes aicx-fade-in { from { opacity: 0; } to { opacity: 1; } }
#aicx-root .aicx-enter-sheet { animation: aicx-slide-up 180ms ease-out both; }
#aicx-root .aicx-enter-fade { animation: aicx-fade-in 160ms ease-out both; }
/* Typing dots */
@keyframes aicx-dot { 0%, 80%, 100% { opacity: .2; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
#aicx-root .aicx-dot { display:inline-block; width:6px; height:6px; margin:0 2px; background:currentColor; border-radius:50%; animation: aicx-dot 1.2s infinite; }
#aicx-root .aicx-dot:nth-child(2){ animation-delay:.15s; }
#aicx-root .aicx-dot:nth-child(3){ animation-delay:.3s; }

/* -------- Explicit dark-mode overrides --------
   The Play CDN's dark: variant generation is unreliable when config is set
   after initial compile, so we emit our own rules. These have specificity
   (1, 2, 0) via the #aicx-root prefix, which always beats any Tailwind rule
   Play CDN happens to produce ((0, 2, 0) at best). */
#aicx-root .dark .dark\\:bg-white { background-color: rgb(255 255 255); }
#aicx-root .dark .dark\\:bg-zinc-50 { background-color: rgb(250 250 250); }
#aicx-root .dark .dark\\:bg-zinc-100 { background-color: rgb(244 244 245); }
#aicx-root .dark .dark\\:bg-zinc-600 { background-color: rgb(82 82 91); }
#aicx-root .dark .dark\\:bg-zinc-700 { background-color: rgb(63 63 70); }
#aicx-root .dark .dark\\:bg-zinc-800 { background-color: rgb(39 39 42); }
#aicx-root .dark .dark\\:bg-zinc-900 { background-color: rgb(24 24 27); }
#aicx-root .dark .dark\\:bg-indigo-900 { background-color: rgb(49 46 129); }
#aicx-root .dark .dark\\:bg-red-900\\/30 { background-color: rgb(127 29 29 / 0.3); }

#aicx-root .dark .dark\\:text-zinc-100 { color: rgb(244 244 245); }
#aicx-root .dark .dark\\:text-zinc-200 { color: rgb(228 228 231); }
#aicx-root .dark .dark\\:text-zinc-300 { color: rgb(212 212 216); }
#aicx-root .dark .dark\\:text-zinc-400 { color: rgb(161 161 170); }
#aicx-root .dark .dark\\:text-zinc-500 { color: rgb(113 113 122); }
#aicx-root .dark .dark\\:text-blue-400 { color: rgb(96 165 250); }
#aicx-root .dark .dark\\:text-indigo-300 { color: rgb(165 180 252); }
#aicx-root .dark .dark\\:text-indigo-400 { color: rgb(129 140 248); }
#aicx-root .dark .dark\\:text-red-300 { color: rgb(252 165 165); }

#aicx-root .dark .dark\\:border-zinc-600 { border-color: rgb(82 82 91); }
#aicx-root .dark .dark\\:border-zinc-700 { border-color: rgb(63 63 70); }
#aicx-root .dark .dark\\:border-zinc-800 { border-color: rgb(39 39 42); }

#aicx-root .dark .dark\\:divide-zinc-800 > :not([hidden]) ~ :not([hidden]) { border-color: rgb(39 39 42); }

#aicx-root .dark .dark\\:hover\\:bg-zinc-800:hover { background-color: rgb(39 39 42); }
#aicx-root .dark .dark\\:hover\\:bg-zinc-800\\/50:hover { background-color: rgb(39 39 42 / 0.5); }
#aicx-root .dark .dark\\:hover\\:bg-zinc-800\\/60:hover { background-color: rgb(39 39 42 / 0.6); }
#aicx-root .dark .dark\\:hover\\:bg-indigo-900\\/40:hover { background-color: rgb(49 46 129 / 0.4); }
#aicx-root .dark .dark\\:hover\\:bg-red-900\\/30:hover { background-color: rgb(127 29 29 / 0.3); }
#aicx-root .dark .dark\\:hover\\:text-zinc-200:hover { color: rgb(228 228 231); }
`;
      const style = document.createElement('style');
      style.id = 'aicx-base';
      style.textContent = css;
      document.head.appendChild(style);
    }
  };

  // =========================================================================
  // 10. Icons (inline SVG)
  // =========================================================================
  const TEMPLATE_ICONS = [
    'template', 'chat', 'search', 'edit', 'star', 'bookmark',
    'bolt', 'code', 'sparkles', 'question', 'folder', 'tag',
    'heart', 'list', 'translate', 'summary', 'web'
  ];
  const icon = (name, cls = 'w-5 h-5') => {
    const paths = {
      chat:    '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8A2.5 2.5 0 0 1 17.5 16H11l-4.5 3.5V16H6.5A2.5 2.5 0 0 1 4 13.5v-8Z" stroke="currentColor" stroke-width="1.6" fill="none"/>',
      plus:    '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
      history: '<path d="M12 6v6l4 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M3 3v5h5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      gear:    '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 1 1-4 0v-.1a1 1 0 0 0-.7-.9 1 1 0 0 0-1.1.2l-.1.1A2 2 0 1 1 6.4 16.4l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H5.7a2 2 0 1 1 0-4h.1a1 1 0 0 0 .9-.7 1 1 0 0 0-.2-1.1l-.1-.1A2 2 0 1 1 9.2 6.4l.1.1a1 1 0 0 0 1.1.2h.1a1 1 0 0 0 .6-.9V5.7a2 2 0 1 1 4 0v.1a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1A2 2 0 1 1 19.8 9.2l-.1.1a1 1 0 0 0-.2 1.1V10.5a1 1 0 0 0 .9.6h.1a2 2 0 1 1 0 4h-.1a1 1 0 0 0-.9.6Z" stroke="currentColor" stroke-width="1.4" fill="none"/>',
      close:   '<path d="M6 6l12 12M18 6l-12 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
      send:    '<path d="M4 12l16-8-6 18-2-8-8-2Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
      attach:  '<path d="M21 12.5l-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l9-9a3.5 3.5 0 1 1 5 5l-9 9a1.5 1.5 0 1 1-2.1-2.1l7.5-7.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
      camera:  '<path d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="12" cy="13" r="4" stroke="currentColor" stroke-width="1.6" fill="none"/>',
      trash:   '<path d="M5 7h14M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
      back:    '<path d="M15 6l-6 6 6 6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      check:   '<path d="M4 12l5 5 11-11" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      stop:    '<rect x="6" y="6" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/>',
      refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      template:'<path d="M4 5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Z" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M14 3v6h6" stroke="currentColor" stroke-width="1.6" fill="none"/>',
      cloud:   '<path d="M7 18a4 4 0 1 1 .7-7.9 5 5 0 0 1 9.8 1A4 4 0 0 1 17 18H7Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
      user:    '<circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M4 20a8 8 0 0 1 16 0" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
      bot:     '<rect x="4" y="6" width="16" height="12" rx="3" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><path d="M12 2v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
      drag:    '<circle cx="9" cy="6" r="1.4" fill="currentColor"/><circle cx="15" cy="6" r="1.4" fill="currentColor"/><circle cx="9" cy="12" r="1.4" fill="currentColor"/><circle cx="15" cy="12" r="1.4" fill="currentColor"/><circle cx="9" cy="18" r="1.4" fill="currentColor"/><circle cx="15" cy="18" r="1.4" fill="currentColor"/>',
      web:     '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" stroke="currentColor" stroke-width="1.6" fill="none"/>',
      copy:    '<rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M5 15V6a2 2 0 0 1 2-2h9" stroke="currentColor" stroke-width="1.6" fill="none"/>',
      search:  '<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M20 20l-4.35-4.35" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
      edit:    '<path d="M12 20h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
      star:    '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
      bookmark:'<path d="M6 3h12a1 1 0 0 1 1 1v18l-7-5-7 5V4a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
      bolt:    '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
      code:    '<path d="M8 6l-6 6 6 6M16 6l6 6-6 6" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      sparkles:'<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
      question:'<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5M12 17v.01" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
      folder:  '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
      tag:     '<path d="M3 3h8l10 10-8 8L3 11V3Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><circle cx="7.5" cy="7.5" r="1" fill="currentColor"/>',
      heart:   '<path d="M20.8 4.6a5.5 5.5 0 0 0-8.8-1.4L12 3.8l-.1-.1a5.5 5.5 0 0 0-8.8 6.6l.8.9 8.1 8.5 8-8.5.7-.9a5.5 5.5 0 0 0 .1-6.7Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
      list:    '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
      translate: '<path d="M4 5h8M8 2v3M6 5c0 4 3 7 7 9M14 14c-4 0-7-3-7-7" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M13 22l5-11 5 11M14 18h8" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      summary: '<path d="M6 3h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M15 3v5h5M9 13h7M9 17h5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
    };
    const svg = el('span', { class: 'inline-flex items-center justify-center ' + cls });
    svg.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
    return svg;
  };

  // =========================================================================
  // 11. UI: root container + notifications
  // =========================================================================
  const UI = {
    rootEl: null,   // #aicx-root - outer container for Tailwind `important` scoping
    root: null,     // .aicx-stage - inner container where `.dark` is toggled and children mount
    toastHost: null,
    init() {
      TailwindBoot.installBase();
      const rootEl = el('div', { id: 'aicx-root' });
      const stage = el('div', { class: 'aicx-stage' });
      rootEl.appendChild(stage);
      (document.body || document.documentElement).appendChild(rootEl);
      this.rootEl = rootEl;
      this.root = stage;
      // toast host
      this.toastHost = el('div', { class: 'fixed bottom-4 left-1/2 -translate-x-1/2 flex flex-col gap-2 items-center pointer-events-none', style: { zIndex: 20 } });
      stage.appendChild(this.toastHost);
      Theme.install(stage);
    },
    toast(msg, kind = 'info') {
      const colors = {
        info: 'bg-zinc-800 text-white',
        error: 'bg-red-600 text-white',
        success: 'bg-emerald-600 text-white'
      };
      const t = el('div', {
        class: `aicx-enter-fade px-4 py-2 rounded-full shadow-lg text-sm pointer-events-auto ${colors[kind] || colors.info}`,
        role: 'status'
      }, msg);
      this.toastHost.appendChild(t);
      setTimeout(() => {
        t.style.transition = 'opacity 200ms';
        t.style.opacity = '0';
        setTimeout(() => t.remove(), 250);
      }, 2400);
    },
    confirm(message) {
      return new Promise((resolve) => {
        const overlay = el('div', { class: 'fixed inset-0 bg-black/40 aicx-panel aicx-enter-fade flex items-center justify-center p-4', style: { zIndex: 50 } });
        const box = el('div', { class: 'bg-white dark:bg-zinc-900 rounded-2xl shadow-xl max-w-sm w-full p-4 aicx-enter-sheet' });
        const p = el('p', { class: 'text-sm text-zinc-700 dark:text-zinc-200 whitespace-pre-wrap' }, message);
        const btns = el('div', { class: 'flex justify-end gap-2 mt-4' });
        const cancel = el('button', { class: 'px-4 py-2 rounded-lg text-sm bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 aicx-tap' }, 'キャンセル');
        const ok = el('button', { class: 'px-4 py-2 rounded-lg text-sm bg-red-600 text-white aicx-tap' }, 'OK');
        cancel.addEventListener('click', () => { overlay.remove(); resolve(false); });
        ok.addEventListener('click', () => { overlay.remove(); resolve(true); });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
        box.append(p, btns);
        btns.append(cancel, ok);
        overlay.appendChild(box);
        this.root.appendChild(overlay);
      });
    }
  };

  // =========================================================================
  // 12. UI: Floating Overlay Button (draggable)
  // =========================================================================
  const OverlayButton = {
    host: null,
    btn: null,
    menuEl: null,
    dragging: false,
    init() {
      this.host = el('div', { id: 'aicx-fab', class: 'fixed aicx-panel aicx-tap', style: { zIndex: 10, touchAction: 'none' } });
      this.btn = el('button', {
        class: 'w-14 h-14 rounded-full shadow-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center active:scale-95 transition',
        type: 'button',
        'aria-label': 'AI チャットを開く'
      });
      this.btn.appendChild(icon('chat', 'w-7 h-7'));
      this.host.appendChild(this.btn);
      UI.root.appendChild(this.host);
      this.applyPosition();
      this.bindDrag();
      // Click listener on HOST (not btn): setPointerCapture on host causes the
      // click event to target the host itself, so a listener on btn never fires.
      this.host.addEventListener('click', (e) => {
        if (this.suppressClick) { this.suppressClick = false; return; }
        e.preventDefault();
        this.toggleMenu();
      });
      window.addEventListener('resize', () => this.applyPosition());
    },
    applyPosition() {
      const pos = Store.settings.buttonPos || { xFrac: 1, yFrac: 1 };
      const W = window.innerWidth, H = window.innerHeight;
      const size = 56;
      const pad = 16;
      const x = Math.max(pad, Math.min(W - size - pad, pos.xFrac * (W - size - pad * 2) + pad));
      const y = Math.max(pad, Math.min(H - size - pad, pos.yFrac * (H - size - pad * 2) + pad));
      this.host.style.left = x + 'px';
      this.host.style.top  = y + 'px';
    },
    savePosition(x, y) {
      const W = window.innerWidth, H = window.innerHeight;
      const size = 56, pad = 16;
      const xFrac = (x - pad) / Math.max(1, W - size - pad * 2);
      const yFrac = (y - pad) / Math.max(1, H - size - pad * 2);
      Store.settings.buttonPos = { xFrac: Math.min(1, Math.max(0, xFrac)), yFrac: Math.min(1, Math.max(0, yFrac)) };
      Store.saveSettings();
    },
    bindDrag() {
      let startX = 0, startY = 0, offX = 0, offY = 0, moved = false, pointerId = null;
      const onMove = (e) => {
        if (pointerId == null || e.pointerId !== pointerId) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 5) return;
        moved = true;
        this.dragging = true;
        e.preventDefault();
        const x = offX + dx, y = offY + dy;
        const W = window.innerWidth, H = window.innerHeight, size = 56, pad = 8;
        this.host.style.left = Math.max(pad, Math.min(W - size - pad, x)) + 'px';
        this.host.style.top  = Math.max(pad, Math.min(H - size - pad, y)) + 'px';
      };
      const onUp = (e) => {
        if (pointerId == null || e.pointerId !== pointerId) return;
        this.host.removeEventListener('pointermove', onMove);
        this.host.removeEventListener('pointerup', onUp);
        this.host.removeEventListener('pointercancel', onUp);
        try { this.host.releasePointerCapture(pointerId); } catch {}
        const wasMoved = moved;
        pointerId = null;
        moved = false;
        this.dragging = false;
        if (wasMoved) {
          this.suppressClick = true;
          this.savePosition(parseFloat(this.host.style.left), parseFloat(this.host.style.top));
          // Clear stale suppress flag so the next real click isn't swallowed.
          setTimeout(() => { this.suppressClick = false; }, 300);
        }
      };
      this.host.addEventListener('pointerdown', (e) => {
        // Only primary mouse button (ignore right-click / middle-click on desktop)
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        pointerId = e.pointerId;
        startX = e.clientX; startY = e.clientY;
        const r = this.host.getBoundingClientRect();
        offX = r.left; offY = r.top;
        moved = false;
        try { this.host.setPointerCapture(pointerId); } catch {}
        this.host.addEventListener('pointermove', onMove);
        this.host.addEventListener('pointerup', onUp);
        this.host.addEventListener('pointercancel', onUp);
      });
    },
    toggleMenu() {
      if (this.menuEl) { this.closeMenu(); return; }
      this.openMenu();
    },
    closeMenu() {
      if (!this.menuEl) return;
      this.menuEl.remove();
      this.menuEl = null;
    },
    openMenu() {
      const host = getDomain();
      const domain = Store.getDomain(host);
      const recent = (domain.conversations || []).slice(0, 3);

      // Position menu near button but within viewport
      const r = this.host.getBoundingClientRect();
      const menuW = 280;
      const below = r.bottom + menuW < window.innerHeight;
      const left = Math.max(8, Math.min(window.innerWidth - menuW - 8, r.left + r.width/2 - menuW/2));

      const menu = el('div', {
        class: 'fixed aicx-panel aicx-enter-sheet bg-white dark:bg-zinc-900 shadow-2xl rounded-2xl border border-zinc-200 dark:border-zinc-700 overflow-hidden',
        style: { zIndex: 15, width: menuW + 'px', left: left + 'px', [below ? 'top' : 'bottom']: (below ? (r.bottom + 8) : (window.innerHeight - r.top + 8)) + 'px' }
      });

      const row = (iconName, label, onClick, extra='') => {
        const b = el('button', { class: `w-full flex items-center gap-3 px-4 py-3 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 aicx-tap ${extra}`, type: 'button' });
        b.append(icon(iconName, 'w-4 h-4 text-zinc-500'), el('span', { class: 'flex-1 truncate' }, label));
        b.addEventListener('click', () => { this.closeMenu(); onClick(); });
        return b;
      };

      // Header
      const header = el('div', { class: 'px-4 pt-3 pb-2 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 flex items-center justify-between' },
        [el('span', {}, host), el('span', { class: 'text-[10px] opacity-60' }, Store.settings.model || '')]
      );
      menu.appendChild(header);

      menu.appendChild(row('plus', '新規 AI チャット', () => ChatPanel.open({ newChat: true })));
      menu.appendChild(row('history', '会話履歴', () => HistoryPanel.open()));

      // Recent section
      if (recent.length) {
        menu.appendChild(el('div', { class: 'px-4 pt-2 pb-1 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400' }, '最近の会話'));
        recent.forEach((c) => {
          const label = c.title || (c.messages[0] && (c.messages[0].content || '').slice(0, 40)) || '(新規会話)';
          menu.appendChild(row('chat', label, () => ChatPanel.open({ conversationId: c.id })));
        });
      }

      // Footer
      menu.appendChild(el('div', { class: 'border-t border-zinc-100 dark:border-zinc-800 mt-1' }));
      menu.appendChild(row('gear', '設定', () => SettingsPanel.open()));

      // Shortcut bar — template icons at the bottom of the menu
      const globalTpls = Store.settings.globalTemplates || [];
      const domainTpls = domain.templates || [];
      if (globalTpls.length || domainTpls.length) {
        const bar = el('div', { class: 'border-t border-zinc-100 dark:border-zinc-800 p-2 flex items-center gap-1 overflow-x-auto' });
        const mkShortcut = (t, scope) => {
          const label = t.name || '(無題)';
          const b = el('button', {
            class: `w-9 h-9 shrink-0 rounded-full flex items-center justify-center aicx-tap transition ${scope === 'global' ? 'text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/40' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`,
            type: 'button',
            'aria-label': label,
            title: label + (scope === 'global' ? ' (グローバル)' : '')
          });
          b.appendChild(icon(t.icon || 'template', 'w-5 h-5'));
          b.addEventListener('click', () => { this.closeMenu(); ChatPanel.open({ newChat: true, initialPrompt: t.prompt || '', autoSend: true, webSearch: !!t.webSearch }); });
          return b;
        };
        for (const t of globalTpls) bar.appendChild(mkShortcut(t, 'global'));
        for (const t of domainTpls) bar.appendChild(mkShortcut(t, 'domain'));
        menu.appendChild(bar);
      }

      this.menuEl = menu;
      UI.root.appendChild(menu);

      // Close on outside click (next tick to avoid instant close)
      setTimeout(() => {
        const onDoc = (e) => {
          if (!menu.contains(e.target) && !this.host.contains(e.target)) {
            document.removeEventListener('pointerdown', onDoc, true);
            this.closeMenu();
          }
        };
        document.addEventListener('pointerdown', onDoc, true);
      }, 0);
    }
  };

  // =========================================================================
  // 13. UI: Chat Panel
  // =========================================================================
  const ChatPanel = {
    panel: null, host: null, conv: null, aborter: null, attachments: [],
    open(opts = {}) {
      this.close();
      const host = getDomain();
      const domain = Store.getDomain(host);
      let conv = null;
      if (opts.conversationId) {
        conv = domain.conversations.find((c) => c.id === opts.conversationId) || null;
      }
      // Defer creating a new conversation until the user actually sends something,
      // to avoid leaving empty conversations in history if they close the panel.
      this.host = host;
      // Web grounding defaults to off for every newly opened chat panel,
      // unless the caller (e.g. a template shortcut) explicitly requests it.
      this.webGrounding = !!opts.webSearch;
      this.conv = conv;
      this.attachments = [];

      const panel = el('div', { class: 'fixed inset-0 aicx-panel aicx-enter-fade flex items-end justify-center', style: { zIndex: 30 } });
      const overlay = el('div', { class: 'absolute inset-0 bg-black/30' });
      overlay.addEventListener('click', () => this.close());

      const heightPct = Math.max(25, Math.min(100, Number(Store.settings.chatHeightPct) || 70));
      const sheet = el('div', {
        class: 'relative bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 w-full sm:max-w-xl sm:mb-4 sm:rounded-2xl rounded-t-2xl shadow-2xl flex flex-col aicx-enter-sheet overflow-hidden',
        style: {
          height: `${heightPct}dvh`,
          maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px))',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)'
        }
      });

      // Resize handle (drag to change sheet height)
      const resizeHandle = el('div', {
        class: 'shrink-0 py-2 flex items-center justify-center aicx-resize',
        role: 'separator',
        'aria-label': '高さを変更',
        'aria-orientation': 'horizontal'
      });
      resizeHandle.appendChild(el('div', { class: 'w-10 h-1 rounded-full bg-zinc-300 dark:bg-zinc-600' }));
      this.bindResize(resizeHandle, sheet);

      // Header
      const header = el('div', { class: 'shrink-0 px-4 pb-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-1' });
      const title = el('div', { class: 'flex-1 min-w-0 mr-2' });
      const titleTop = el('div', { class: 'text-sm font-semibold truncate' }, (conv && conv.title) || '新しい会話');
      const titleSub = el('div', { class: 'text-[11px] text-zinc-500 dark:text-zinc-400 truncate' }, `${host} · ${Store.settings.model || '(モデル未選択)'}`);
      title.append(titleTop, titleSub);

      const btnNewChat = el('button', { class: 'w-9 h-9 shrink-0 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center aicx-tap', 'aria-label': '新規チャット', title: '新規チャット' });
      btnNewChat.appendChild(icon('plus'));
      btnNewChat.addEventListener('click', () => this.open());

      const btnHistory = el('button', { class: 'w-9 h-9 shrink-0 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center aicx-tap', 'aria-label': '会話履歴', title: '会話履歴' });
      btnHistory.appendChild(icon('history'));
      btnHistory.addEventListener('click', () => HistoryPanel.open());

      const closeBtn = el('button', { class: 'w-9 h-9 shrink-0 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center aicx-tap', 'aria-label': '閉じる' });
      closeBtn.appendChild(icon('close'));
      closeBtn.addEventListener('click', () => this.close());

      header.append(title, btnNewChat, btnHistory, closeBtn);

      // Messages
      const list = el('div', { class: 'flex-1 aicx-scroll overflow-y-auto p-4 space-y-3' });

      // Composer: textarea on top, button row below
      const composer = el('div', { class: 'shrink-0 border-t border-zinc-200 dark:border-zinc-800 p-3 bg-white dark:bg-zinc-900 flex flex-col gap-2' });
      const attBar = el('div', { class: 'flex flex-wrap gap-2 empty:hidden' });
      const ta = el('textarea', {
        class: 'w-full min-h-[40px] max-h-40 px-3 py-2 rounded-2xl bg-zinc-100 dark:bg-zinc-800 text-sm',
        placeholder: 'メッセージを入力 (Shift+Enter で改行)',
        rows: '1'
      });
      ta.addEventListener('input', () => {
        ta.style.height = 'auto';
        ta.style.height = Math.min(160, ta.scrollHeight) + 'px';
      });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          this.send();
        }
      });
      if (opts.initialPrompt) {
        ta.value = opts.initialPrompt;
        setTimeout(() => {
          ta.dispatchEvent(new Event('input'));
          if (opts.autoSend && ta.value.trim()) {
            this.send();
          } else {
            ta.focus();
          }
        }, 0);
      }

      // File / camera inputs (hidden)
      const fileInput = el('input', { type: 'file', multiple: true, class: 'hidden' });
      fileInput.addEventListener('change', (e) => this.handleFiles(e.target.files));
      const cameraInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden' });
      cameraInput.addEventListener('change', (e) => this.handleFiles(e.target.files));

      // Button row (below textarea)
      const btnRow = el('div', { class: 'flex items-center gap-2' });

      const btnAttach = el('button', { class: 'w-10 h-10 shrink-0 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 flex items-center justify-center aicx-tap', 'aria-label': 'ファイル添付', title: 'ファイル添付' });
      btnAttach.appendChild(icon('attach'));
      btnAttach.addEventListener('click', () => fileInput.click());

      const btnCamera = el('button', { class: 'w-10 h-10 shrink-0 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 flex items-center justify-center aicx-tap', 'aria-label': 'カメラ撮影', title: 'カメラ撮影' });
      btnCamera.appendChild(icon('camera'));
      btnCamera.addEventListener('click', () => cameraInput.click());

      const btnWeb = el('button', { class: '', type: 'button', 'aria-label': 'Web 検索 (Grounding)', 'aria-pressed': 'false', title: 'Gemini の Google 検索 Grounding を有効/無効 (このチャット内のみ)' });
      btnWeb.appendChild(icon('web'));
      const updateWebBtn = () => {
        const on = !!this.webGrounding;
        btnWeb.setAttribute('aria-pressed', on ? 'true' : 'false');
        btnWeb.className = `h-10 shrink-0 rounded-full flex items-center justify-center gap-1 px-3 aicx-tap transition ${on ? 'bg-indigo-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300'}`;
      };
      updateWebBtn();
      btnWeb.appendChild(el('span', { class: 'text-xs font-medium' }, 'Web'));
      btnWeb.addEventListener('click', () => {
        this.webGrounding = !this.webGrounding;
        updateWebBtn();
      });

      const btnCtx = el('button', { class: 'w-10 h-10 shrink-0 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 flex items-center justify-center aicx-tap', type: 'button', 'aria-label': 'コンテキストを確認', title: 'AI に送られるページコンテキストをプレビュー' });
      btnCtx.appendChild(icon('summary'));
      btnCtx.addEventListener('click', () => this.showContextPreview());

      const spacer = el('div', { class: 'flex-1' });

      const btnSend = el('button', { class: 'w-10 h-10 shrink-0 rounded-full bg-indigo-600 text-white flex items-center justify-center disabled:opacity-50 aicx-tap', 'aria-label': '送信' });
      btnSend.appendChild(icon('send'));
      btnSend.addEventListener('click', () => this.send());

      const btnStop = el('button', { class: 'w-10 h-10 shrink-0 rounded-full bg-red-600 text-white flex items-center justify-center aicx-tap hidden', 'aria-label': '停止' });
      btnStop.appendChild(icon('stop'));
      btnStop.addEventListener('click', () => this.stop());

      btnRow.append(btnAttach, btnCamera, btnWeb, btnCtx, spacer, btnSend, btnStop, fileInput, cameraInput);
      composer.append(attBar, ta, btnRow);

      sheet.append(resizeHandle, header, list, composer);
      panel.append(overlay, sheet);
      UI.root.appendChild(panel);
      this.panel = panel;
      this.sheet = sheet;
      this.els = { list, ta, btnSend, btnStop, attBar, titleTop };

      // Render initial messages
      this.render();

      // Focus composer on next frame (mobile keyboards)
      setTimeout(() => ta.focus(), 50);
    },

    bindResize(handle, sheet) {
      let startY = 0, startHpx = 0, pointerId = null;
      const onMove = (e) => {
        if (e.pointerId !== pointerId) return;
        e.preventDefault();
        const dy = e.clientY - startY;
        // Sheet is anchored at bottom: dragging up (negative dy) grows height.
        const newH = startHpx - dy;
        const vh = window.innerHeight;
        const minH = Math.max(180, vh * 0.25);
        const maxH = vh;
        sheet.style.height = `${Math.max(minH, Math.min(maxH, newH))}px`;
      };
      const onUp = (e) => {
        if (e.pointerId !== pointerId) return;
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        try { handle.releasePointerCapture(pointerId); } catch {}
        pointerId = null;
        const vh = window.innerHeight;
        const pct = Math.max(25, Math.min(100, Math.round(sheet.offsetHeight / vh * 100)));
        Store.settings.chatHeightPct = pct;
        Store.saveSettings();
        // Convert back to percentage-based so it tracks viewport changes afterward
        sheet.style.height = `${pct}dvh`;
      };
      handle.addEventListener('pointerdown', (e) => {
        pointerId = e.pointerId;
        startY = e.clientY;
        startHpx = sheet.offsetHeight;
        try { handle.setPointerCapture(pointerId); } catch {}
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
      });
    },

    close() {
      if (this.aborter) { try { this.aborter.abort(); } catch {} this.aborter = null; }
      if (this.panel) { this.panel.remove(); this.panel = null; }
      this.sheet = null;
      this.conv = null;
      this.attachments = [];
    },

    stop() {
      if (this.aborter) { try { this.aborter.abort(); } catch {} }
    },

    async handleFiles(fileList) {
      const files = Array.from(fileList || []);
      for (const f of files) {
        if (f.size > 15 * 1024 * 1024) { UI.toast(`ファイルが大きすぎます (15MB以下): ${f.name}`, 'error'); continue; }
        const dataUrl = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.onerror = () => rej(r.error);
          r.readAsDataURL(f);
        });
        this.attachments.push({ id: uid(), name: f.name, mimeType: f.type || 'application/octet-stream', size: f.size, dataUrl });
      }
      this.renderAttachments();
    },

    renderAttachments() {
      const bar = this.els.attBar;
      clear(bar);
      this.attachments.forEach((a) => {
        const chip = el('div', { class: 'inline-flex items-center gap-2 px-2 py-1 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs max-w-[200px]' });
        if (a.mimeType && a.mimeType.startsWith('image/')) {
          chip.appendChild(el('img', { src: a.dataUrl, class: 'w-5 h-5 rounded object-cover' }));
        } else {
          chip.appendChild(icon('attach', 'w-4 h-4 text-zinc-500'));
        }
        chip.appendChild(el('span', { class: 'truncate' }, a.name));
        const x = el('button', { class: 'text-zinc-500 hover:text-red-500 aicx-tap' });
        x.appendChild(icon('close', 'w-3 h-3'));
        x.addEventListener('click', () => { this.attachments = this.attachments.filter((v) => v.id !== a.id); this.renderAttachments(); });
        chip.appendChild(x);
        bar.appendChild(chip);
      });
    },

    showContextPreview() {
      let snap;
      try {
        snap = Page.snapshot();
      } catch (e) {
        UI.toast('コンテキストの取得に失敗しました: ' + (e && e.message || e), 'error');
        return;
      }
      const MODE_LABEL = {
        auto: '自動 (Readability)',
        clean: 'クリーン (chrome 除外)',
        raw: 'ほぼそのまま'
      };
      const modeLabel = MODE_LABEL[snap.mode] || snap.mode;
      const systemPrompt = Store.resolveSystemPrompt(this.host);
      const promptText = Page.formatForPrompt(snap);

      const kv = (k, v) => el('div', { class: 'flex gap-2 text-xs' }, [
        el('span', { class: 'shrink-0 w-24 text-zinc-500 dark:text-zinc-400' }, k),
        el('span', { class: 'flex-1 break-all text-zinc-800 dark:text-zinc-200' }, v)
      ]);
      const preBlock = (text) => el('pre', {
        class: 'whitespace-pre-wrap break-words text-[11px] font-mono bg-zinc-50 dark:bg-zinc-800 rounded-lg p-3 max-h-64 overflow-auto text-zinc-800 dark:text-zinc-200'
      }, text || '(空)');
      const section = (label, child) => el('section', { class: 'space-y-1' }, [
        el('h3', { class: 'text-[11px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400 font-semibold' }, label),
        child
      ]);

      const close = el('button', { class: 'w-9 h-9 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center aicx-tap', 'aria-label': '閉じる', type: 'button' });
      close.appendChild(icon('close'));
      const { panel, body } = Form.sheet({
        title: 'コンテキスト プレビュー',
        onClose: () => panel.remove()
      });
      close.addEventListener('click', () => panel.remove());

      // Summary (mode + stats)
      const stats = el('div', { class: 'space-y-1 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700' }, [
        kv('抽出モード', modeLabel),
        kv('本文文字数', `${snap.text.length.toLocaleString()} 文字${snap.text.endsWith('...[truncated]') ? ' (打ち切り)' : ''}`),
        kv('選択文字数', `${snap.selection.length.toLocaleString()} 文字`),
        kv('添付ファイル', this.attachments.length ? this.attachments.map((a) => a.name).join(', ') : 'なし')
      ]);
      body.append(section('概要', stats));

      // Page meta
      body.append(section('ページ情報', el('div', { class: 'space-y-1' }, [
        kv('URL', snap.url),
        kv('Title', snap.title || '(なし)'),
        kv('Description', snap.metaDesc || '(なし)')
      ])));

      // Selection
      if (snap.selection) body.append(section('選択中のテキスト', preBlock(snap.selection)));

      // Extracted text
      body.append(section('抽出された本文', preBlock(snap.text)));

      // System prompt
      body.append(section('システムプロンプト', preBlock(systemPrompt || '(なし)')));

      // Full prompt (what actually gets sent as context)
      body.append(section('送信される Page Context (整形済み)', preBlock(promptText)));

      // Actions
      const actions = el('div', { class: 'flex gap-2 pt-2' });
      const copyBtn = Form.btn('本文をコピー', async () => {
        const ok = await copyToClipboard(snap.text);
        UI.toast(ok ? 'コピーしました' : 'コピーに失敗しました', ok ? 'success' : 'error');
      }, 'bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100');
      const copyAllBtn = Form.btn('プロンプト全体をコピー', async () => {
        const ok = await copyToClipboard(promptText);
        UI.toast(ok ? 'コピーしました' : 'コピーに失敗しました', ok ? 'success' : 'error');
      }, 'bg-indigo-600 text-white');
      actions.append(copyBtn, copyAllBtn);
      body.append(actions);

      UI.root.appendChild(panel);
    },

    render() {
      const list = this.els.list;
      clear(list);
      const visible = this.conv ? this.conv.messages.filter((m) => m.role !== 'system') : [];
      if (!visible.length) {
        list.appendChild(el('div', { class: 'text-center text-xs text-zinc-500 py-8' }, 'このページについて質問してみましょう。ページのテキストが文脈として送信されます。'));
      }
      for (const m of visible) list.appendChild(this.renderMessage(m));
      list.scrollTop = list.scrollHeight;
    },

    renderMessage(m) {
      const isUser = m.role === 'user';

      // Build attachments block (if any)
      let atts = null;
      if (m.attachments && m.attachments.length) {
        atts = el('div', { class: `flex flex-wrap gap-2 ${isUser ? 'justify-end' : ''} mb-1` });
        for (const a of m.attachments) {
          if (a.mimeType && a.mimeType.startsWith('image/')) {
            atts.appendChild(el('img', { src: a.dataUrl, class: 'max-w-[160px] max-h-[160px] rounded-lg object-cover' }));
          } else {
            atts.appendChild(el('div', { class: 'text-xs opacity-80 flex items-center gap-1' }, [icon('attach', 'w-3 h-3'), a.name]));
          }
        }
      }

      if (isUser) {
        // User: right-aligned bubble, preserves whitespace
        const wrap = el('div', { class: 'flex flex-col items-end' });
        const bubble = el('div', { class: 'max-w-[85%] rounded-2xl px-3 py-2 text-sm bg-indigo-600 text-white' });
        if (atts) bubble.appendChild(atts);
        const body = el('div', { class: 'whitespace-pre-wrap break-words' });
        body.textContent = m.content || '';
        bubble.appendChild(body);
        wrap.appendChild(bubble);
        const actions = this.renderActions(m);
        if (actions) wrap.appendChild(actions);
        return wrap;
      }

      // Assistant: full-width plain markdown, no bubble, no avatar
      const wrap = el('div', { class: 'w-full text-sm break-words' });
      if (atts) wrap.appendChild(atts);
      const body = el('div', { class: 'aicx-md' });
      body.innerHTML = MD.render(m.content || (m._pending ? '<span class="aicx-dot"></span><span class="aicx-dot"></span><span class="aicx-dot"></span>' : ''));
      wrap.appendChild(body);
      const actions = this.renderActions(m);
      if (actions) wrap.appendChild(actions);
      return wrap;
    },

    // Per-message action bar. Designed to host multiple buttons — append more
    // children to the returned bar as new features are added.
    renderActions(m) {
      if (m._pending) return null;
      const text = m.content || '';
      const hasAtts = m.attachments && m.attachments.length;
      if (!text.trim() && !hasAtts) return null;
      const isUser = m.role === 'user';
      const bar = el('div', {
        class: `flex gap-1 mt-1.5 flex-wrap ${isUser ? 'justify-end' : 'justify-start'}`,
        'data-aicx-actions': ''
      });
      bar.appendChild(this._actionButton('copy', 'コピー', async () => {
        const ok = await copyToClipboard(text);
        UI.toast(ok ? 'コピーしました' : 'コピーに失敗しました', ok ? 'success' : 'error');
      }));
      return bar;
    },

    _actionButton(iconName, label, onClick) {
      const b = el('button', {
        class: 'text-xs px-2 py-1 rounded-md text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 aicx-tap inline-flex items-center gap-1 transition',
        'aria-label': label,
        title: label
      });
      b.append(icon(iconName, 'w-3.5 h-3.5'), el('span', {}, label));
      b.addEventListener('click', onClick);
      return b;
    },

    async send() {
      if (this.aborter) return; // already sending
      const text = this.els.ta.value.trim();
      const atts = this.attachments;
      if (!text && atts.length === 0) return;
      if (!Store.settings.apiKey) { UI.toast('API キーを設定してください', 'error'); SettingsPanel.open(); return; }

      // Lazily create the conversation on first send
      if (!this.conv) this.conv = Store.newConversation(this.host);

      // Snapshot locals so this run isn't affected if user closes/opens another panel mid-stream
      const host = this.host;
      const conv = this.conv;
      const els = this.els;
      const firstMessage = conv.messages.filter((m) => m.role === 'user').length === 0;

      const userMsg = {
        id: uid(), role: 'user', content: text, createdAt: now(),
        attachments: atts.length ? atts.map(({ id, name, mimeType, dataUrl }) => ({ id, name, mimeType, dataUrl })) : undefined
      };
      conv.messages.push(userMsg);
      if (!conv.title) conv.title = (text || (atts[0] && atts[0].name) || '新しい会話').slice(0, 60);

      // assistant placeholder
      const asstMsg = { id: uid(), role: 'assistant', content: '', createdAt: now(), _pending: true };
      conv.messages.push(asstMsg);

      this.attachments = [];
      this.renderAttachments();
      els.ta.value = '';
      els.ta.style.height = 'auto';
      this.render();
      els.titleTop.textContent = conv.title;
      Store.upsertConversation(host, conv);
      Store.saveDomains();

      // Build message list for API
      const apiMessages = [];
      const snap = Page.snapshot();
      if (firstMessage) {
        apiMessages.push({ role: 'user', content: Page.formatForPrompt(snap) });
        apiMessages.push({ role: 'assistant', content: '(context received)' });
      }
      for (const m of conv.messages) {
        if (m === asstMsg) continue;
        apiMessages.push({ role: m.role, content: m.content, attachments: m.attachments });
      }

      const aborter = new AbortController();
      this.aborter = aborter;
      els.btnSend.classList.add('hidden');
      els.btnStop.classList.remove('hidden');

      try {
        let acc = '';
        // Google Search grounding (requires Gemini 2.0+ for `googleSearch`; 1.5 uses `googleSearchRetrieval`)
        let tools;
        if (this.webGrounding) {
          const m = Store.settings.model || '';
          tools = /\b1\.[05]\b/.test(m) ? [{ googleSearchRetrieval: {} }] : [{ googleSearch: {} }];
        }
        let grounding = null;
        const stream = Gemini.streamGenerate({
          apiKey: Store.settings.apiKey,
          model: Store.settings.model,
          messages: apiMessages,
          systemPrompt: Store.resolveSystemPrompt(host),
          tools,
          onMetadata: (meta) => { grounding = meta; },
          signal: aborter.signal
        });
        for await (const chunk of stream) {
          acc += chunk;
          asstMsg.content = acc;
          asstMsg._pending = false;
          if (this.conv === conv) this.renderLastAssistant();
        }
        asstMsg._pending = false;
        // Append grounding sources (web citations) if any.
        // Rendered as <details> so the list is collapsed by default — it can
        // get long and dominate the bubble otherwise.
        if (grounding && grounding.groundingChunks && grounding.groundingChunks.length) {
          const items = grounding.groundingChunks
            .map((c) => (c.web && c.web.uri) ? `<li><a href="${esc(c.web.uri)}" target="_blank" rel="noopener noreferrer">${esc(c.web.title || c.web.uri)}</a></li>` : null)
            .filter(Boolean);
          if (items.length) {
            const html = `\n\n<details class="aicx-sources"><summary>ソース (${items.length} 件)</summary>\n<ol>\n${items.join('\n')}\n</ol>\n</details>`;
            asstMsg.content = (asstMsg.content || '') + html;
            if (this.conv === conv) this.renderLastAssistant();
          }
        }
      } catch (err) {
        asstMsg._pending = false;
        if (err && err.name === 'AbortError') {
          asstMsg.content = (asstMsg.content || '') + '\n\n_(停止しました)_';
        } else {
          asstMsg.content = `**エラー:** ${esc(err && err.message || String(err))}`;
        }
        if (this.conv === conv) this.renderLastAssistant();
      } finally {
        if (this.aborter === aborter) this.aborter = null;
        if (this.conv === conv) {
          els.btnSend.classList.remove('hidden');
          els.btnStop.classList.add('hidden');
        }
        Store.upsertConversation(host, conv);
        await Store.saveDomains();
        ScheduleBackup.mark();
      }
    },

    renderLastAssistant() {
      const list = this.els.list;
      // Preserve user's scroll position when they scroll up to read
      const nearBottom = (list.scrollHeight - list.scrollTop - list.clientHeight) < 80;
      const children = list.children;
      const last = children[children.length - 1];
      const msg = this.conv.messages[this.conv.messages.length - 1];
      const replacement = this.renderMessage(msg);
      if (last) list.replaceChild(replacement, last); else list.appendChild(replacement);
      if (nearBottom) list.scrollTop = list.scrollHeight;
    }
  };

  // =========================================================================
  // 14. UI: History Panel
  // =========================================================================
  const HistoryPanel = {
    panel: null,
    open() {
      this.close();
      const host = getDomain();
      const domain = Store.getDomain(host);

      const panel = el('div', { class: 'fixed inset-0 aicx-panel aicx-enter-fade flex items-end sm:items-stretch justify-center', style: { zIndex: 30 } });
      const overlay = el('div', { class: 'absolute inset-0 bg-black/30' });
      overlay.addEventListener('click', () => this.close());

      const sheet = el('div', {
        class: 'relative bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 w-full sm:max-w-md sm:mx-auto sm:my-4 sm:rounded-2xl rounded-t-2xl shadow-2xl flex flex-col aicx-enter-sheet aicx-full sm:h-[calc(100dvh-2rem)] overflow-hidden',
        style: { paddingBottom: 'env(safe-area-inset-bottom, 0px)' }
      });

      const header = el('div', { class: 'shrink-0 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2' });
      const backBtn = el('button', { class: 'w-9 h-9 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center aicx-tap' });
      backBtn.appendChild(icon('back'));
      backBtn.addEventListener('click', () => this.close());
      header.append(backBtn, el('div', { class: 'flex-1' }, [el('div', { class: 'text-sm font-semibold' }, '会話履歴'), el('div', { class: 'text-[11px] text-zinc-500' }, host)]));

      const list = el('div', { class: 'flex-1 aicx-scroll overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800' });

      if (!domain.conversations.length) {
        list.appendChild(el('div', { class: 'p-8 text-center text-sm text-zinc-500' }, 'このドメインでの会話はまだありません。'));
      } else {
        for (const c of domain.conversations) list.appendChild(this.renderItem(c, host));
      }

      sheet.append(header, list);
      panel.append(overlay, sheet);
      UI.root.appendChild(panel);
      this.panel = panel;
    },
    close() { if (this.panel) { this.panel.remove(); this.panel = null; } },
    renderItem(c, host) {
      const row = el('div', { class: 'flex items-center gap-3 p-4 hover:bg-zinc-50 dark:hover:bg-zinc-800/50' });
      const main = el('button', { class: 'flex-1 min-w-0 text-left aicx-tap' });
      const snippet = (c.messages.find((m) => m.role === 'user') || {}).content || '';
      main.append(
        el('div', { class: 'text-sm font-medium truncate' }, c.title || snippet.slice(0, 50) || '(無題)'),
        el('div', { class: 'text-xs text-zinc-500 truncate' }, `${fmtDate(c.updatedAt || c.createdAt)} · ${c.messages.filter((m) => m.role !== 'system').length} msg`)
      );
      main.addEventListener('click', () => { this.close(); ChatPanel.open({ conversationId: c.id }); });

      const del = el('button', { class: 'w-8 h-8 rounded-full text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30 flex items-center justify-center aicx-tap', 'aria-label': '削除' });
      del.appendChild(icon('trash', 'w-4 h-4'));
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (await UI.confirm('この会話を削除しますか?')) {
          Store.removeConversation(host, c.id);
          await Store.saveDomains();
          row.remove();
          ScheduleBackup.mark();
        }
      });
      row.append(main, del);
      return row;
    }
  };

  // =========================================================================
  // 15. UI: Settings Panel
  // =========================================================================
  // -------------------------------------------------------------------------
  // Form helpers (shared by Settings / Domain panels)
  // -------------------------------------------------------------------------
  const Form = {
    sectionTitle(t) {
      return el('h3', { class: 'text-xs uppercase tracking-wider text-zinc-500 dark:text-zinc-400 font-semibold' }, t);
    },
    label(t) { return el('label', { class: 'block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1' }, t); },
    input(val, onInput, opts = {}) {
      const i = el('input', Object.assign({
        type: 'text',
        class: 'w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg text-sm px-3 py-2'
      }, opts));
      i.value = val == null ? '' : String(val);
      i.addEventListener('input', () => onInput(i.value));
      return i;
    },
    textarea(val, onInput, rows = 4) {
      const t = el('textarea', { class: 'w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg text-sm px-3 py-2', rows: String(rows) });
      t.value = val == null ? '' : String(val);
      t.addEventListener('input', () => onInput(t.value));
      return t;
    },
    btn(text, onClick, cls = 'bg-indigo-600 text-white') {
      const b = el('button', { class: `px-3 py-2 rounded-lg text-sm aicx-tap ${cls}`, type: 'button' }, text);
      b.addEventListener('click', onClick);
      return b;
    },
    checkbox(label, checked, onChange) {
      const wrap = el('label', { class: 'flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer' });
      const chk = el('input', { type: 'checkbox', class: 'w-4 h-4' });
      chk.checked = !!checked;
      chk.addEventListener('change', () => onChange(chk.checked));
      wrap.append(chk, el('span', {}, label));
      return wrap;
    },
    select(options, value, onChange) {
      const sel = el('select', { class: 'w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg text-sm px-3 py-2' });
      for (const opt of options) {
        const o = el('option', { value: opt.value }, opt.label);
        if (opt.value === value) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener('change', () => onChange(sel.value));
      return sel;
    },
    // Icon picker for templates — shows current icon, opens a grid popover on click.
    iconPicker({ current, onChange }) {
      let selected = current || 'template';
      const wrap = el('div', { class: 'relative inline-block shrink-0' });
      const trigger = el('button', {
        class: 'w-10 h-10 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center justify-center aicx-tap text-zinc-600 dark:text-zinc-300',
        type: 'button',
        'aria-label': 'アイコンを選択',
        title: 'アイコンを選択'
      });
      const paintTrigger = () => { clear(trigger); trigger.appendChild(icon(selected, 'w-5 h-5')); };
      paintTrigger();
      let popover = null;
      const closePop = () => {
        if (popover) { popover.remove(); popover = null; }
        document.removeEventListener('pointerdown', onDoc, true);
      };
      const onDoc = (e) => { if (!wrap.contains(e.target)) closePop(); };
      const openPop = () => {
        if (popover) { closePop(); return; }
        popover = el('div', {
          class: 'absolute z-20 mt-1 left-0 p-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl',
          style: { top: '100%', minWidth: '244px' }
        });
        const grid = el('div', { class: 'grid grid-cols-6 gap-1' });
        for (const name of TEMPLATE_ICONS) {
          const active = name === selected;
          const cell = el('button', {
            class: `w-9 h-9 rounded flex items-center justify-center aicx-tap transition ${active ? 'bg-indigo-100 dark:bg-indigo-900 text-indigo-600 dark:text-indigo-300' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`,
            type: 'button',
            'aria-label': name,
            title: name
          });
          cell.appendChild(icon(name, 'w-4 h-4'));
          cell.addEventListener('click', () => {
            selected = name;
            paintTrigger();
            try { onChange(selected); } catch {}
            closePop();
          });
          grid.appendChild(cell);
        }
        popover.appendChild(grid);
        wrap.appendChild(popover);
        setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
      };
      trigger.addEventListener('click', openPop);
      wrap.appendChild(trigger);
      return wrap;
    },
    // Sheet skeleton: returns { panel, sheet, body } with header already mounted.
    // `title` may be a string or HTMLElement. `subheader` (optional) is rendered
    // between the header and the scrollable body (useful for tab bars).
    sheet({ title, onBack, onClose, leading, trailing, subheader, maxWidth = 'sm:max-w-lg' }) {
      const panel = el('div', { class: 'fixed inset-0 aicx-panel aicx-enter-fade flex items-end sm:items-stretch justify-center', style: { zIndex: 30 } });
      const overlay = el('div', { class: 'absolute inset-0 bg-black/30' });
      overlay.addEventListener('click', () => { (onBack || onClose || (() => panel.remove()))(); });
      const sheet = el('div', {
        class: `relative bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 w-full ${maxWidth} sm:mx-auto sm:my-4 sm:rounded-2xl rounded-t-2xl shadow-2xl flex flex-col aicx-enter-sheet aicx-full sm:h-[calc(100dvh-2rem)] overflow-hidden`,
        style: { paddingBottom: 'env(safe-area-inset-bottom, 0px)' }
      });
      const header = el('div', { class: 'shrink-0 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2' });
      if (leading) header.appendChild(leading);
      const titleEl = (typeof title === 'string')
        ? el('div', { class: 'flex-1 text-sm font-semibold truncate' }, title)
        : title;
      header.appendChild(titleEl);
      if (trailing) header.appendChild(trailing);
      if (onClose) {
        const close = el('button', { class: 'w-9 h-9 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center aicx-tap', 'aria-label': '閉じる' });
        close.appendChild(icon('close'));
        close.addEventListener('click', onClose);
        header.appendChild(close);
      }
      const body = el('div', { class: 'flex-1 aicx-scroll overflow-y-auto p-4 space-y-6' });
      sheet.append(header);
      if (subheader) sheet.append(subheader);
      sheet.append(body);
      panel.append(overlay, sheet);
      return { panel, sheet, body };
    }
  };

  const SettingsPanel = {
    panel: null,
    models: null,
    activeTab: 'general',

    TABS: [
      { id: 'general', label: '一般' },
      { id: 'prompts', label: 'プロンプト' },
      { id: 'domains', label: 'ドメイン' },
      { id: 'backup',  label: 'バックアップ' }
    ],

    open() {
      this.close();

      const tabBar = el('div', { class: 'flex border-b border-zinc-200 dark:border-zinc-800 shrink-0 overflow-x-auto' });
      const tabButtons = {};
      const updateTabStyles = () => {
        for (const [id, btn] of Object.entries(tabButtons)) {
          const active = this.activeTab === id;
          btn.className = `flex-1 min-w-[80px] px-3 py-2.5 text-sm whitespace-nowrap border-b-2 transition aicx-tap ${active ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 font-medium' : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'}`;
        }
      };

      const { panel, body } = Form.sheet({
        title: '設定',
        onClose: () => this.close(),
        subheader: tabBar
      });

      for (const t of this.TABS) {
        const btn = el('button', { role: 'tab', 'aria-selected': 'false' }, t.label);
        tabButtons[t.id] = btn;
        btn.addEventListener('click', () => {
          this.activeTab = t.id;
          updateTabStyles();
          this.renderTab(body);
          body.scrollTop = 0;
        });
        tabBar.append(btn);
      }
      updateTabStyles();
      this.renderTab(body);

      UI.root.appendChild(panel);
      this.panel = panel;
    },
    close() { if (this.panel) { this.panel.remove(); this.panel = null; } },

    renderTab(body) {
      clear(body);
      switch (this.activeTab) {
        case 'general':
          body.append(this.sectionAPI(), this.sectionTheme(), this.sectionAbout());
          break;
        case 'prompts':
          body.append(this.sectionGlobalPrompt(), this.sectionPageExtract(), this.sectionGlobalTemplates());
          break;
        case 'domains':
          body.append(this.sectionDomains());
          break;
        case 'backup':
          body.append(this.sectionBackup());
          break;
      }
    },

    sectionAPI() {
      const box = el('section', { class: 'space-y-3' });
      box.append(Form.sectionTitle('Gemini API'));

      const keyWrap = el('div');
      keyWrap.append(Form.label('API キー'));
      const keyInput = Form.input(Store.settings.apiKey, (v) => { Store.settings.apiKey = v.trim(); Store.saveSettings(); updateModelOpts(); }, { type: 'password', placeholder: 'AIza...' });
      keyWrap.append(keyInput);
      keyWrap.append(el('p', { class: 'text-[11px] text-zinc-500 mt-1' }, [
        'キーは ',
        (() => { const a = el('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener', class: 'underline text-indigo-600 dark:text-indigo-400' }, 'Google AI Studio'); return a; })(),
        ' で取得できます。'
      ]));
      box.append(keyWrap);

      const modelWrap = el('div');
      modelWrap.append(Form.label('モデル'));
      const row = el('div', { class: 'flex gap-2' });
      const sel = el('select', { class: 'flex-1 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg text-sm px-3 py-2' });
      const refreshBtn = Form.btn('再取得', () => updateModelOpts(true), 'bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100');
      refreshBtn.prepend(icon('refresh', 'w-3 h-3 mr-1 inline'));
      row.append(sel, refreshBtn);
      modelWrap.append(row);
      const hint = el('p', { class: 'text-[11px] text-zinc-500 mt-1' }, 'API キーを入力すると利用可能な Gemini モデルを動的に取得します。');
      modelWrap.append(hint);
      box.append(modelWrap);

      const updateModelOpts = async (force = false) => {
        if (!Store.settings.apiKey) {
          clear(sel);
          sel.appendChild(el('option', { value: Store.settings.model || '' }, Store.settings.model || '(API キー未設定)'));
          return;
        }
        if (!this.models || force) {
          sel.disabled = true;
          hint.textContent = 'モデル一覧を取得中...';
          try {
            this.models = await Gemini.listModels(Store.settings.apiKey);
            hint.textContent = `${this.models.length} モデルを取得しました。`;
          } catch (e) {
            hint.textContent = 'モデル一覧の取得に失敗しました: ' + (e && e.message || e);
            this.models = [];
          } finally {
            sel.disabled = false;
          }
        }
        clear(sel);
        const ids = new Set();
        if (Store.settings.model && !this.models.some((m) => m.id === Store.settings.model)) {
          sel.appendChild(el('option', { value: Store.settings.model }, Store.settings.model));
          ids.add(Store.settings.model);
        }
        for (const m of this.models) {
          if (ids.has(m.id)) continue;
          sel.appendChild(el('option', { value: m.id }, `${m.display} (${m.id})`));
        }
        sel.value = Store.settings.model || '';
      };
      sel.addEventListener('change', () => { Store.settings.model = sel.value; Store.saveSettings(); });
      updateModelOpts();

      return box;
    },

    sectionGlobalPrompt() {
      const box = el('section', { class: 'space-y-2' });
      box.append(Form.sectionTitle('グローバル システムプロンプト'));
      box.append(el('p', { class: 'text-xs text-zinc-500' }, '全ドメインで共通して使われます。ドメインごとの上書きは「ドメイン」タブから行えます。'));
      box.append(Form.textarea(Store.settings.globalSystemPrompt, (v) => { Store.settings.globalSystemPrompt = v; Store.saveSettings(); }, 5));
      return box;
    },

    sectionPageExtract() {
      const box = el('section', { class: 'space-y-2' });
      box.append(Form.sectionTitle('ページ本文の抽出方法'));
      box.append(el('p', { class: 'text-xs text-zinc-500' }, 'AI に送るページのコンテキスト抽出方法を選びます。ドメインごとに個別設定することもできます。'));
      const opts = [
        { value: 'auto', label: '自動 (Readability で本文抽出 · 推奨)' },
        { value: 'clean', label: 'クリーン (ヘッダー/ナビ/フッター/サイドバー等を除外)' },
        { value: 'raw', label: 'ほぼそのまま (スクリプト/スタイル等のみ除外)' }
      ];
      box.append(Form.select(opts, Store.settings.pageExtractMode || 'auto', (v) => {
        Store.settings.pageExtractMode = v;
        Store.saveSettings();
      }));
      return box;
    },

    sectionGlobalTemplates() {
      const box = el('section', { class: 'space-y-2' });
      box.append(Form.sectionTitle('グローバル テンプレート'));
      box.append(el('p', { class: 'text-xs text-zinc-500' }, '全ドメインのオーバーレイメニューから呼び出せるプロンプトです。ドメイン固有のテンプレートは「ドメイン」タブから設定できます。'));

      Store.settings.globalTemplates = Store.settings.globalTemplates || [];
      const tpls = Store.settings.globalTemplates;

      const list = el('div', { class: 'space-y-2' });
      const render = () => {
        clear(list);
        for (const t of tpls) {
          const row = el('div', { class: 'p-2 rounded-lg border border-zinc-200 dark:border-zinc-700 space-y-2' });
          const head = el('div', { class: 'flex gap-2' });
          head.append(
            Form.iconPicker({ current: t.icon || 'template', onChange: async (v) => { t.icon = v; await Store.saveSettings(); } }),
            Form.input(t.name || '', async (v) => { t.name = v; await Store.saveSettings(); }, { placeholder: '名前' })
          );
          const del = el('button', { class: 'w-9 h-9 shrink-0 rounded-lg text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30 flex items-center justify-center aicx-tap', type: 'button', 'aria-label': 'テンプレート削除' });
          del.appendChild(icon('trash', 'w-4 h-4'));
          del.addEventListener('click', async () => {
            if (await UI.confirm(`テンプレート「${t.name || ''}」を削除しますか?`)) {
              const idx = tpls.findIndex((x) => x.id === t.id);
              if (idx >= 0) tpls.splice(idx, 1);
              await Store.saveSettings();
              render();
            }
          });
          head.append(del);
          const ta = Form.textarea(t.prompt || '', async (v) => { t.prompt = v; await Store.saveSettings(); }, 3);
          ta.placeholder = 'プロンプトテキスト';
          const webChk = Form.checkbox('Web 検索 (Grounding) を有効にする', !!t.webSearch, async (v) => { t.webSearch = v; await Store.saveSettings(); });
          row.append(head, ta, webChk);
          list.append(row);
        }
        if (!tpls.length) list.append(el('p', { class: 'text-xs text-zinc-500' }, 'テンプレートはまだありません。'));
      };
      render();
      const addBtn = Form.btn('+ テンプレートを追加', async () => {
        tpls.push({ id: uid(), icon: 'template', name: '新規テンプレート', prompt: '', webSearch: false });
        await Store.saveSettings();
        render();
      }, 'bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 w-full');
      box.append(list, addBtn);
      return box;
    },

    sectionDomains() {
      const box = el('section', { class: 'space-y-2' });
      box.append(Form.sectionTitle('ドメイン別設定'));
      box.append(el('p', { class: 'text-xs text-zinc-500' }, 'ドメインを選択すると、そのドメインのシステムプロンプト上書き・テンプレート・会話履歴を編集できます。'));

      const current = getDomain();
      const others = Object.keys(Store.domains).filter((d) => d !== current).sort();
      const ordered = [current, ...others];

      const wrap = el('div', { class: 'divide-y divide-zinc-100 dark:divide-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden' });
      for (const d of ordered) {
        const dom = Store.domains[d] || {};
        const convs = (dom.conversations || []).length;
        const tpls = (dom.templates || []).length;
        const hasPrompt = !!(dom.systemPrompt && String(dom.systemPrompt).trim());
        const isCurrent = d === current;
        const row = el('button', { class: 'w-full flex items-center gap-3 px-3 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/60 aicx-tap' });
        const main = el('div', { class: 'flex-1 min-w-0' });
        const nameRow = el('div', { class: 'text-sm font-medium truncate flex items-center gap-2' });
        nameRow.append(el('span', { class: 'truncate' }, d));
        if (isCurrent) nameRow.append(el('span', { class: 'text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 shrink-0' }, '現在'));
        const bits = [];
        if (convs) bits.push(`${convs} 件の会話`);
        if (tpls) bits.push(`${tpls} テンプレート`);
        if (hasPrompt) bits.push('プロンプト上書き');
        main.append(nameRow, el('div', { class: 'text-xs text-zinc-500 truncate' }, bits.length ? bits.join(' · ') : '未設定'));
        row.append(main, el('span', { class: 'text-zinc-400 text-lg leading-none' }, '›'));
        row.addEventListener('click', () => {
          this.close();
          DomainPanel.open(d, () => this.open());
        });
        wrap.append(row);
      }
      box.append(wrap);
      return box;
    },

    sectionBackup() {
      const box = el('section', { class: 'space-y-3' });
      box.append(Form.sectionTitle('Google Drive バックアップ'));

      const info = el('div', { class: 'text-xs text-zinc-500 space-y-1' });
      info.append(el('p', {}, '設定と会話履歴を Google Drive の「App Data」領域に保存します。'));
      info.append(el('p', {}, [
        '1. ',
        (() => { const a = el('a', { href: 'https://console.cloud.google.com/apis/credentials', target: '_blank', rel: 'noopener', class: 'underline text-indigo-600 dark:text-indigo-400' }, 'Google Cloud Console'); return a; })(),
        ' で OAuth クライアント ID を作成（種類: ウェブアプリ）。'
      ]));
      info.append(el('p', {}, `2. 承認済みリダイレクト URI に現在のページ (${location.origin + location.pathname}) を登録。`));
      info.append(el('p', {}, '3. 下のフィールドにクライアント ID を貼り付け、「接続」を押す。'));
      box.append(info);

      box.append(Form.label('OAuth クライアント ID'));
      box.append(Form.input(Store.settings.driveClientId, (v) => { Store.settings.driveClientId = v.trim(); Store.saveSettings(); }, { placeholder: 'xxxxx.apps.googleusercontent.com' }));

      const statusLine = el('div', { class: 'text-xs' });
      const updateStatus = () => {
        const valid = Drive.isTokenValid();
        clear(statusLine);
        statusLine.className = 'text-xs ' + (valid ? 'text-emerald-600' : 'text-zinc-500');
        statusLine.textContent = valid
          ? `接続中 · 期限: ${fmtDate(Store.settings.driveTokenExp)}${Store.settings.lastBackupAt ? ` · 最終バックアップ: ${fmtDate(Store.settings.lastBackupAt)}` : ''}`
          : '未接続';
      };
      updateStatus();
      box.append(statusLine);

      const row = el('div', { class: 'flex flex-wrap gap-2' });
      row.append(Form.btn('接続', async () => {
        if (!Store.settings.driveClientId) { UI.toast('クライアント ID を入力してください', 'error'); return; }
        if (!await UI.confirm('Google 認証のため現在のページを離れます。入力中のフォーム等があれば保存してください。続行しますか?')) return;
        try { Drive.startOAuth(Store.settings.driveClientId); } catch (e) { UI.toast(e.message, 'error'); }
      }));
      row.append(Form.btn('今すぐバックアップ', async () => {
        try { await Drive.upload(); UI.toast('バックアップしました', 'success'); updateStatus(); }
        catch (e) { UI.toast(e.message, 'error'); }
      }, 'bg-emerald-600 text-white'));
      row.append(Form.btn('Drive から復元', async () => {
        if (!await UI.confirm('現在の設定/履歴を上書きします。続行しますか?')) return;
        try { await Drive.download(); UI.toast('復元しました', 'success'); this.close(); this.open(); }
        catch (e) { UI.toast(e.message, 'error'); }
      }, 'bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100'));
      row.append(Form.btn('切断', async () => { await Drive.signOut(); updateStatus(); }, 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200'));
      box.append(row);

      const autoWrap = el('label', { class: 'flex items-center gap-2 text-sm' });
      const chk = el('input', { type: 'checkbox', class: 'w-4 h-4' });
      chk.checked = !!Store.settings.autoBackup;
      chk.addEventListener('change', () => { Store.settings.autoBackup = chk.checked; Store.saveSettings(); });
      autoWrap.append(chk, el('span', {}, '会話更新時に自動バックアップ (接続中のみ)'));
      box.append(autoWrap);

      return box;
    },

    sectionTheme() {
      const box = el('section', { class: 'space-y-2' });
      box.append(Form.sectionTitle('テーマ'));
      const row = el('div', { class: 'flex gap-2' });
      const rerender = () => {
        clear(row);
        for (const v of [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']]) {
          const active = Store.settings.theme === v[0];
          const b = el('button', { class: `flex-1 px-3 py-2 rounded-lg text-sm aicx-tap transition ${active ? 'bg-indigo-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100'}` }, v[1]);
          b.addEventListener('click', () => { Store.settings.theme = v[0]; Store.saveSettings(); Theme.apply(); rerender(); });
          row.append(b);
        }
      };
      rerender();
      box.append(row);
      return box;
    },

    sectionAbout() {
      const box = el('section', { class: 'space-y-1' });
      box.append(Form.sectionTitle('情報'));
      box.append(el('p', { class: 'text-xs text-zinc-500' }, 'AI Chat Overlay v0.1.0 · Tailwind CSS · Gemini API · Google Drive'));
      return box;
    }
  };

  // =========================================================================
  // 15.5 DomainPanel — per-domain settings (opened from SettingsPanel)
  // =========================================================================
  const DomainPanel = {
    panel: null,
    returnTo: null,
    open(host, returnTo) {
      this.close();
      this.returnTo = returnTo || null;

      // Header: back arrow + domain title
      const back = el('button', { class: 'w-9 h-9 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center aicx-tap', 'aria-label': '戻る' });
      back.appendChild(icon('back'));
      back.addEventListener('click', () => this.close());
      const title = el('div', { class: 'flex-1 min-w-0' }, [
        el('div', { class: 'text-[11px] text-zinc-500 dark:text-zinc-400' }, 'ドメイン設定'),
        el('div', { class: 'text-sm font-semibold truncate' }, host)
      ]);

      const { panel, body } = Form.sheet({
        leading: back,
        title,
        onBack: () => this.close()
      });

      body.append(
        this.sectionPrompt(host),
        this.sectionPageExtract(host),
        this.sectionTemplates(host),
        this.sectionConversations(host),
        this.sectionDanger(host)
      );

      UI.root.appendChild(panel);
      this.panel = panel;
    },
    close() {
      if (this.panel) { this.panel.remove(); this.panel = null; }
      const cb = this.returnTo; this.returnTo = null;
      if (cb) cb();
    },

    sectionPrompt(host) {
      const box = el('section', { class: 'space-y-2' });
      box.append(Form.sectionTitle('システムプロンプト上書き'));
      box.append(el('p', { class: 'text-xs text-zinc-500' }, '空欄の場合はグローバル設定が使われます。'));
      const dom = Store.getDomain(host);
      const ta = Form.textarea(dom.systemPrompt || '', async (v) => { dom.systemPrompt = v; await Store.saveDomains(); }, 4);
      ta.placeholder = '(空欄でグローバル設定を使用)';
      box.append(ta);
      return box;
    },

    sectionPageExtract(host) {
      const box = el('section', { class: 'space-y-2' });
      box.append(Form.sectionTitle('ページ本文の抽出方法'));
      box.append(el('p', { class: 'text-xs text-zinc-500' }, 'このドメインでの抽出方法を個別に指定できます。既定ではグローバル設定を使用します。'));
      const dom = Store.getDomain(host);
      const opts = [
        { value: 'inherit', label: 'グローバル設定を使用' },
        { value: 'auto', label: '自動 (Readability で本文抽出)' },
        { value: 'clean', label: 'クリーン (ヘッダー/ナビ/フッター/サイドバー等を除外)' },
        { value: 'raw', label: 'ほぼそのまま (スクリプト/スタイル等のみ除外)' }
      ];
      box.append(Form.select(opts, dom.pageExtractMode || 'inherit', async (v) => {
        dom.pageExtractMode = v;
        await Store.saveDomains();
      }));
      return box;
    },

    sectionTemplates(host) {
      const box = el('section', { class: 'space-y-2' });
      box.append(Form.sectionTitle('テンプレート'));
      box.append(el('p', { class: 'text-xs text-zinc-500' }, 'オーバーレイメニューから呼び出せるプロンプトです。'));
      const dom = Store.getDomain(host);
      const list = el('div', { class: 'space-y-2' });
      const render = () => {
        clear(list);
        for (const t of dom.templates) {
          const row = el('div', { class: 'p-2 rounded-lg border border-zinc-200 dark:border-zinc-700 space-y-2' });
          const head = el('div', { class: 'flex gap-2' });
          head.append(
            Form.iconPicker({ current: t.icon || 'template', onChange: async (v) => { t.icon = v; await Store.saveDomains(); } }),
            Form.input(t.name || '', async (v) => { t.name = v; await Store.saveDomains(); }, { placeholder: '名前' })
          );
          const del = el('button', { class: 'w-9 h-9 shrink-0 rounded-lg text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30 flex items-center justify-center aicx-tap', type: 'button', 'aria-label': 'テンプレート削除' });
          del.appendChild(icon('trash', 'w-4 h-4'));
          del.addEventListener('click', async () => {
            if (await UI.confirm(`テンプレート「${t.name || ''}」を削除しますか?`)) {
              dom.templates = dom.templates.filter((x) => x.id !== t.id);
              await Store.saveDomains();
              render();
            }
          });
          head.append(del);
          const ta = Form.textarea(t.prompt || '', async (v) => { t.prompt = v; await Store.saveDomains(); }, 3);
          ta.placeholder = 'プロンプトテキスト';
          const webChk = Form.checkbox('Web 検索 (Grounding) を有効にする', !!t.webSearch, async (v) => { t.webSearch = v; await Store.saveDomains(); });
          row.append(head, ta, webChk);
          list.append(row);
        }
        if (!dom.templates.length) list.append(el('p', { class: 'text-xs text-zinc-500' }, 'テンプレートはまだありません。'));
      };
      render();
      const addBtn = Form.btn('+ テンプレートを追加', async () => {
        dom.templates.push({ id: uid(), icon: 'template', name: '新規テンプレート', prompt: '', webSearch: false });
        await Store.saveDomains();
        render();
      }, 'bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 w-full');
      box.append(list, addBtn);
      return box;
    },

    sectionConversations(host) {
      const box = el('section', { class: 'space-y-2' });
      box.append(Form.sectionTitle('会話履歴'));
      const dom = Store.getDomain(host);
      const list = el('div', { class: 'divide-y divide-zinc-100 dark:divide-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden' });
      const render = () => {
        clear(list);
        if (!dom.conversations.length) {
          list.append(el('p', { class: 'text-xs text-zinc-500 p-3' }, 'このドメインでの会話はまだありません。'));
          return;
        }
        for (const c of dom.conversations) {
          const row = el('div', { class: 'flex items-start gap-2 p-3' });
          const main = el('div', { class: 'flex-1 min-w-0' });
          const preview = (c.messages.find((m) => m.role === 'user') || {}).content || '';
          main.append(
            el('div', { class: 'text-sm font-medium truncate' }, c.title || preview.slice(0, 50) || '(無題)'),
            el('div', { class: 'text-xs text-zinc-500 truncate' }, `${fmtDate(c.updatedAt || c.createdAt)} · ${c.messages.filter((m) => m.role !== 'system').length} msg`)
          );
          if (preview && preview !== c.title) {
            main.append(el('div', { class: 'text-xs text-zinc-400 dark:text-zinc-500 mt-1 line-clamp-2 break-words' }, preview.slice(0, 160)));
          }
          const actions = el('div', { class: 'flex flex-col gap-1 shrink-0' });
          if (host === getDomain()) {
            const open = el('button', { class: 'w-8 h-8 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center aicx-tap', 'aria-label': '会話を開く', title: '会話を開く' });
            open.appendChild(icon('chat', 'w-4 h-4'));
            open.addEventListener('click', () => {
              this.returnTo = null; // don't reopen settings after opening chat
              this.close();
              SettingsPanel.close();
              ChatPanel.open({ conversationId: c.id });
            });
            actions.append(open);
          }
          const del = el('button', { class: 'w-8 h-8 rounded-lg text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30 flex items-center justify-center aicx-tap', 'aria-label': '削除' });
          del.appendChild(icon('trash', 'w-4 h-4'));
          del.addEventListener('click', async () => {
            if (await UI.confirm('この会話を削除しますか?')) {
              dom.conversations = dom.conversations.filter((x) => x.id !== c.id);
              await Store.saveDomains();
              render();
            }
          });
          actions.append(del);
          row.append(main, actions);
          list.append(row);
        }
      };
      render();
      box.append(list);
      return box;
    },

    sectionDanger(host) {
      const box = el('section', { class: 'space-y-2' });
      box.append(Form.sectionTitle('危険な操作'));
      const btn = Form.btn('このドメインの全データを削除', async () => {
        if (!await UI.confirm(`${host} の会話・テンプレート・プロンプト設定を全て削除します。続行しますか?`)) return;
        delete Store.domains[host];
        await Store.saveDomains();
        UI.toast('削除しました', 'success');
        this.close();
      }, 'bg-red-600 text-white w-full');
      box.append(btn);
      return box;
    }
  };

  // =========================================================================
  // 16. Auto-backup scheduler (debounced)
  // =========================================================================
  const ScheduleBackup = {
    mark: debounce(async () => {
      if (!Store.settings.autoBackup) return;
      if (!Drive.isTokenValid()) return;
      try { await Drive.upload(); } catch (e) { console.warn('[aicx] auto-backup failed:', e); }
    }, 5000)
  };

  // =========================================================================
  // 17. Bootstrap
  // =========================================================================
  async function main() {
    await Store.load();
    // If coming back from OAuth, consume hash
    Drive.consumeOAuthHash();
    // Tailwind first, then UI
    await TailwindBoot.load().catch((e) => console.warn('[aicx] Tailwind load failed:', e));
    UI.init();
    OverlayButton.init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }
})();
