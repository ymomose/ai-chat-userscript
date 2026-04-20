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
// @connect      cdn.tailwindcss.com
// @require      https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js
// @require      https://cdn.jsdelivr.net/npm/dompurify@3.0.11/dist/purify.min.js
// @noframes
// ==/UserScript==

/* global marked, DOMPurify */
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
    buttonPos: null // { x, y } fraction of viewport
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

    async *streamGenerate({ apiKey, model, messages, systemPrompt, signal }) {
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
    snapshot() {
      const selection = (window.getSelection && String(window.getSelection())) || '';
      const title = document.title || '';
      const metaDesc = (document.querySelector('meta[name="description"]') || {}).content || '';
      const url = location.href;

      // main content: try article / main / body in that order, strip scripts/styles
      const root = document.querySelector('article') || document.querySelector('main') || document.body;
      let text = '';
      if (root) {
        const clone = root.cloneNode(true);
        clone.querySelectorAll('script,style,noscript,svg,iframe,video,audio,canvas').forEach((n) => n.remove());
        text = (clone.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      }
      // Cap to ~20k chars to keep prompt bounded
      const MAX = 20000;
      if (text.length > MAX) text = text.slice(0, MAX) + '\n...[truncated]';
      return { url, title, metaDesc, selection: selection.slice(0, 4000), text };
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
    loadingPromise: null,
    load() {
      if (this.loaded) return Promise.resolve();
      if (this.loadingPromise) return this.loadingPromise;
      // Pre-configure before the Play CDN script evaluates
      window.tailwind = window.tailwind || {};
      window.tailwind.config = {
        darkMode: 'class',
        important: '#aicx-root',
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
      this.loadingPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.tailwindcss.com/3.4.16';
        s.async = true;
        s.onload = () => { this.loaded = true; resolve(); };
        s.onerror = () => reject(new Error('Failed to load Tailwind CSS CDN'));
        document.head.appendChild(s);
      });
      return this.loadingPromise;
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
#aicx-root *, #aicx-root *::before, #aicx-root *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border: 0 solid currentColor;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  color: inherit;
  background: transparent;
  text-decoration: none;
  list-style: none;
}
#aicx-root button, #aicx-root input, #aicx-root textarea, #aicx-root select {
  font: inherit; color: inherit; background: transparent;
  appearance: none; -webkit-appearance: none; outline: none;
}
#aicx-root input, #aicx-root textarea, #aicx-root select {
  border-radius: 8px; padding: 8px 10px;
}
#aicx-root button { cursor: pointer; touch-action: manipulation; }
#aicx-root img { max-width: 100%; height: auto; display: block; }
#aicx-root svg { display: inline-block; vertical-align: middle; }
#aicx-root [data-active="true"] { pointer-events: auto; }
#aicx-root .aicx-panel { pointer-events: auto; }
#aicx-root .aicx-scroll { -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
#aicx-root .aicx-tap { touch-action: manipulation; user-select: none; -webkit-user-select: none; }
#aicx-root textarea { resize: none; }
/* Viewport helpers */
#aicx-root .aicx-full { height: 100dvh; max-height: 100dvh; }
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
        'aria-label': 'AI チャットを開く'
      });
      this.btn.appendChild(icon('chat', 'w-7 h-7'));
      this.host.appendChild(this.btn);
      UI.root.appendChild(this.host);
      this.applyPosition();
      this.bindDrag();
      this.btn.addEventListener('click', (e) => {
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
        pointerId = null;
        if (moved) {
          this.suppressClick = true;
          this.savePosition(parseFloat(this.host.style.left), parseFloat(this.host.style.top));
        }
        this.dragging = false;
      };
      this.host.addEventListener('pointerdown', (e) => {
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
      const recent = (domain.conversations || []).slice(0, 5);
      const templates = domain.templates || [];

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
        const b = el('button', { class: `w-full flex items-center gap-3 px-4 py-3 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 aicx-tap ${extra}` });
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

      // Templates section
      if (templates.length) {
        menu.appendChild(el('div', { class: 'px-4 pt-2 pb-1 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400' }, 'テンプレート'));
        templates.slice(0, 8).forEach((t) => {
          menu.appendChild(row('template', t.name || '(無題)', () => ChatPanel.open({ newChat: true, initialPrompt: t.prompt })));
        });
      } else {
        menu.appendChild(el('div', { class: 'px-4 py-2 text-xs text-zinc-400' }, 'テンプレート: 設定画面で追加できます'));
      }

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
      this.conv = conv;
      this.attachments = [];

      const panel = el('div', { class: 'fixed inset-0 aicx-panel aicx-enter-fade flex items-end sm:items-stretch justify-center', style: { zIndex: 30 } });
      const overlay = el('div', { class: 'absolute inset-0 bg-black/30' });
      overlay.addEventListener('click', () => this.close());

      const sheet = el('div', {
        class: 'relative bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 w-full sm:max-w-xl sm:mx-auto sm:my-4 sm:rounded-2xl rounded-t-2xl shadow-2xl flex flex-col aicx-enter-sheet aicx-full sm:h-[calc(100dvh-2rem)] overflow-hidden',
        style: { paddingBottom: 'env(safe-area-inset-bottom, 0px)' }
      });

      // Header
      const header = el('div', { class: 'shrink-0 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-3' });
      const title = el('div', { class: 'flex-1 min-w-0' });
      const titleTop = el('div', { class: 'text-sm font-semibold truncate' }, (conv && conv.title) || '新しい会話');
      const titleSub = el('div', { class: 'text-[11px] text-zinc-500 dark:text-zinc-400 truncate' }, `${host} · ${Store.settings.model || '(モデル未選択)'}`);
      title.append(titleTop, titleSub);
      const closeBtn = el('button', { class: 'w-9 h-9 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center aicx-tap', 'aria-label': '閉じる' });
      closeBtn.appendChild(icon('close'));
      closeBtn.addEventListener('click', () => this.close());
      header.append(title, closeBtn);

      // Messages
      const list = el('div', { class: 'flex-1 aicx-scroll overflow-y-auto p-4 space-y-3' });

      // Composer
      const composer = el('div', { class: 'shrink-0 border-t border-zinc-200 dark:border-zinc-800 p-3 bg-white dark:bg-zinc-900' });
      const attBar = el('div', { class: 'flex flex-wrap gap-2 mb-2 empty:hidden' });
      const inputRow = el('div', { class: 'flex items-end gap-2' });
      const ta = el('textarea', {
        class: 'flex-1 min-h-[40px] max-h-40 px-3 py-2 rounded-2xl bg-zinc-100 dark:bg-zinc-800 text-sm',
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
        setTimeout(() => { ta.dispatchEvent(new Event('input')); ta.focus(); }, 0);
      }

      // Attach buttons
      const fileInput = el('input', { type: 'file', multiple: true, class: 'hidden' });
      fileInput.addEventListener('change', (e) => this.handleFiles(e.target.files));
      const cameraInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden' });
      cameraInput.addEventListener('change', (e) => this.handleFiles(e.target.files));

      const btnAttach = el('button', { class: 'w-10 h-10 shrink-0 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 flex items-center justify-center aicx-tap', 'aria-label': '添付' });
      btnAttach.appendChild(icon('attach'));
      btnAttach.addEventListener('click', () => fileInput.click());

      const btnCamera = el('button', { class: 'w-10 h-10 shrink-0 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 flex items-center justify-center aicx-tap', 'aria-label': 'カメラ撮影' });
      btnCamera.appendChild(icon('camera'));
      btnCamera.addEventListener('click', () => cameraInput.click());

      const btnSend = el('button', { class: 'w-10 h-10 shrink-0 rounded-full bg-indigo-600 text-white flex items-center justify-center disabled:opacity-50 aicx-tap', 'aria-label': '送信' });
      btnSend.appendChild(icon('send'));
      btnSend.addEventListener('click', () => this.send());

      const btnStop = el('button', { class: 'w-10 h-10 shrink-0 rounded-full bg-red-600 text-white flex items-center justify-center aicx-tap hidden', 'aria-label': '停止' });
      btnStop.appendChild(icon('stop'));
      btnStop.addEventListener('click', () => this.stop());

      inputRow.append(btnAttach, btnCamera, ta, btnSend, btnStop, fileInput, cameraInput);
      composer.append(attBar, inputRow);

      sheet.append(header, list, composer);
      panel.append(overlay, sheet);
      UI.root.appendChild(panel);
      this.panel = panel;
      this.els = { list, ta, btnSend, btnStop, attBar, titleTop };

      // Render initial messages
      this.render();

      // Focus composer on next frame (mobile keyboards)
      setTimeout(() => ta.focus(), 50);
    },

    close() {
      if (this.aborter) { try { this.aborter.abort(); } catch {} this.aborter = null; }
      if (this.panel) { this.panel.remove(); this.panel = null; }
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
      const wrap = el('div', { class: `flex gap-2 ${isUser ? 'justify-end' : 'justify-start'}` });
      const avatar = el('div', { class: `w-7 h-7 shrink-0 rounded-full flex items-center justify-center ${isUser ? 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900 dark:text-indigo-300 order-last' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'}` });
      avatar.appendChild(icon(isUser ? 'user' : 'bot', 'w-4 h-4'));
      const bubble = el('div', { class: `max-w-[80%] rounded-2xl px-3 py-2 text-sm ${isUser ? 'bg-indigo-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'}` });
      if (m.attachments && m.attachments.length) {
        const atts = el('div', { class: 'flex flex-wrap gap-2 mb-1' });
        for (const a of m.attachments) {
          if (a.mimeType && a.mimeType.startsWith('image/')) {
            atts.appendChild(el('img', { src: a.dataUrl, class: 'max-w-[160px] max-h-[160px] rounded-lg object-cover' }));
          } else {
            atts.appendChild(el('div', { class: 'text-xs opacity-80 flex items-center gap-1' }, [icon('attach', 'w-3 h-3'), a.name]));
          }
        }
        bubble.appendChild(atts);
      }
      const body = el('div', { class: 'aicx-md' });
      if (isUser) {
        body.className = 'whitespace-pre-wrap break-words';
        body.textContent = m.content || '';
      } else {
        body.innerHTML = MD.render(m.content || (m._pending ? '<span class="aicx-dot"></span><span class="aicx-dot"></span><span class="aicx-dot"></span>' : ''));
      }
      bubble.appendChild(body);
      wrap.append(avatar, bubble);
      return wrap;
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
        const stream = Gemini.streamGenerate({
          apiKey: Store.settings.apiKey,
          model: Store.settings.model,
          messages: apiMessages,
          systemPrompt: Store.resolveSystemPrompt(host),
          signal: aborter.signal
        });
        for await (const chunk of stream) {
          acc += chunk;
          asstMsg.content = acc;
          asstMsg._pending = false;
          if (this.conv === conv) this.renderLastAssistant();
        }
        asstMsg._pending = false;
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
  const SettingsPanel = {
    panel: null,
    models: null,
    open() {
      this.close();
      const panel = el('div', { class: 'fixed inset-0 aicx-panel aicx-enter-fade flex items-end sm:items-stretch justify-center', style: { zIndex: 30 } });
      const overlay = el('div', { class: 'absolute inset-0 bg-black/30' });
      overlay.addEventListener('click', () => this.close());

      const sheet = el('div', {
        class: 'relative bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 w-full sm:max-w-lg sm:mx-auto sm:my-4 sm:rounded-2xl rounded-t-2xl shadow-2xl flex flex-col aicx-enter-sheet aicx-full sm:h-[calc(100dvh-2rem)] overflow-hidden',
        style: { paddingBottom: 'env(safe-area-inset-bottom, 0px)' }
      });

      const header = el('div', { class: 'shrink-0 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2' });
      const back = el('button', { class: 'w-9 h-9 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center aicx-tap' });
      back.appendChild(icon('close'));
      back.addEventListener('click', () => this.close());
      header.append(el('div', { class: 'flex-1 text-sm font-semibold' }, '設定'), back);

      const body = el('div', { class: 'flex-1 aicx-scroll overflow-y-auto p-4 space-y-6' });

      body.append(this.sectionAPI(), this.sectionPrompts(), this.sectionTemplates(), this.sectionHistory(), this.sectionBackup(), this.sectionTheme(), this.sectionAbout());

      sheet.append(header, body);
      panel.append(overlay, sheet);
      UI.root.appendChild(panel);
      this.panel = panel;
    },
    close() { if (this.panel) { this.panel.remove(); this.panel = null; } },

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
      const b = el('button', { class: `px-3 py-2 rounded-lg text-sm aicx-tap ${cls}` }, text);
      b.addEventListener('click', onClick);
      return b;
    },

    sectionAPI() {
      const box = el('section', { class: 'space-y-3' });
      box.append(this.sectionTitle('Gemini API'));

      const keyWrap = el('div');
      keyWrap.append(this.label('API キー'));
      const keyInput = this.input(Store.settings.apiKey, (v) => { Store.settings.apiKey = v.trim(); Store.saveSettings(); updateModelOpts(); }, { type: 'password', placeholder: 'AIza...' });
      keyWrap.append(keyInput);
      keyWrap.append(el('p', { class: 'text-[11px] text-zinc-500 mt-1' }, [
        'キーは ',
        (() => { const a = el('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener', class: 'underline text-indigo-600 dark:text-indigo-400' }, 'Google AI Studio'); return a; })(),
        ' で取得できます。'
      ]));
      box.append(keyWrap);

      const modelWrap = el('div');
      modelWrap.append(this.label('モデル'));
      const row = el('div', { class: 'flex gap-2' });
      const sel = el('select', { class: 'flex-1 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg text-sm px-3 py-2' });
      const refreshBtn = this.btn('再取得', () => updateModelOpts(true), 'bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100');
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
        // Include current model even if not in list
        if (Store.settings.model && !this.models.some((m) => m.id === Store.settings.model)) {
          sel.appendChild(el('option', { value: Store.settings.model }, Store.settings.model));
          ids.add(Store.settings.model);
        }
        for (const m of this.models) {
          if (ids.has(m.id)) continue;
          const opt = el('option', { value: m.id }, `${m.display} (${m.id})`);
          sel.appendChild(opt);
        }
        sel.value = Store.settings.model || '';
      };
      sel.addEventListener('change', () => { Store.settings.model = sel.value; Store.saveSettings(); });
      updateModelOpts();

      return box;
    },

    sectionPrompts() {
      const box = el('section', { class: 'space-y-3' });
      box.append(this.sectionTitle('システムプロンプト'));

      box.append(this.label('グローバル (全ドメイン共通)'));
      box.append(this.textarea(Store.settings.globalSystemPrompt, (v) => { Store.settings.globalSystemPrompt = v; Store.saveSettings(); }, 4));

      const domains = Store.usedDomains();
      box.append(this.label('ドメイン別オーバーライド'));
      if (!domains.length) {
        box.append(el('p', { class: 'text-xs text-zinc-500' }, 'AI チャットを使用したことのあるドメインで設定できます。'));
      } else {
        const sel = el('select', { class: 'w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg text-sm px-3 py-2 mb-2' });
        for (const d of domains) sel.appendChild(el('option', { value: d }, d));
        sel.value = domains.includes(getDomain()) ? getDomain() : domains[0];
        const ta = this.textarea(Store.getDomain(sel.value).systemPrompt || '', (v) => { Store.getDomain(sel.value).systemPrompt = v; Store.saveDomains(); }, 3);
        ta.placeholder = '(空欄でグローバル設定を使用)';
        sel.addEventListener('change', () => { ta.value = Store.getDomain(sel.value).systemPrompt || ''; });
        box.append(sel, ta);
      }
      return box;
    },

    sectionTemplates() {
      const box = el('section', { class: 'space-y-2' });
      box.append(this.sectionTitle('テンプレート (ドメイン別)'));
      const host = getDomain();
      const domain = Store.getDomain(host);
      box.append(el('p', { class: 'text-xs text-zinc-500' }, `対象: ${host}`));

      const list = el('div', { class: 'space-y-2' });
      const render = () => {
        clear(list);
        for (const t of domain.templates) {
          const row = el('div', { class: 'p-2 rounded-lg border border-zinc-200 dark:border-zinc-700 space-y-2' });
          const head = el('div', { class: 'flex gap-2' });
          const nameInput = this.input(t.name || '', (v) => { t.name = v; Store.saveDomains(); }, { placeholder: '名前' });
          const del = el('button', { class: 'w-9 h-9 rounded-lg text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30 flex items-center justify-center aicx-tap' });
          del.appendChild(icon('trash', 'w-4 h-4'));
          del.addEventListener('click', async () => {
            if (await UI.confirm(`テンプレート「${t.name || ''}」を削除しますか?`)) {
              domain.templates = domain.templates.filter((x) => x.id !== t.id);
              await Store.saveDomains();
              render();
            }
          });
          head.append(nameInput, del);
          const ta = this.textarea(t.prompt || '', (v) => { t.prompt = v; Store.saveDomains(); }, 3);
          ta.placeholder = 'プロンプトテキスト';
          row.append(head, ta);
          list.append(row);
        }
        if (!domain.templates.length) list.append(el('p', { class: 'text-xs text-zinc-500' }, 'テンプレートはまだありません。'));
      };
      render();
      const addBtn = this.btn('+ テンプレートを追加', async () => {
        domain.templates.push({ id: uid(), name: '新規テンプレート', prompt: '' });
        await Store.saveDomains();
        render();
      }, 'bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 w-full');
      box.append(list, addBtn);
      return box;
    },

    sectionHistory() {
      const box = el('section', { class: 'space-y-2' });
      box.append(this.sectionTitle('会話履歴 (ドメイン別)'));
      const domains = Object.keys(Store.domains).filter((d) => Store.domains[d].conversations && Store.domains[d].conversations.length).sort();
      if (!domains.length) {
        box.append(el('p', { class: 'text-xs text-zinc-500' }, '会話履歴はまだありません。'));
        return box;
      }
      const wrap = el('div', { class: 'divide-y divide-zinc-100 dark:divide-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden' });
      for (const d of domains) {
        const dom = Store.domains[d];
        const row = el('div', { class: 'flex items-center justify-between px-3 py-2 gap-2' });
        row.append(el('div', { class: 'flex-1 min-w-0' }, [
          el('div', { class: 'text-sm font-medium truncate' }, d),
          el('div', { class: 'text-xs text-zinc-500' }, `${dom.conversations.length} 件`)
        ]));
        const view = this.btn('閲覧', () => { this.close(); location.host === d ? HistoryPanel.open() : this.openReadonly(d); }, 'bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100');
        const del = el('button', { class: 'w-9 h-9 rounded-lg text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30 flex items-center justify-center aicx-tap' });
        del.appendChild(icon('trash', 'w-4 h-4'));
        del.addEventListener('click', async () => {
          if (await UI.confirm(`${d} の全ての会話を削除しますか?`)) {
            dom.conversations = [];
            await Store.saveDomains();
            row.remove();
          }
        });
        row.append(view, del);
        wrap.append(row);
      }
      box.append(wrap);
      return box;
    },

    openReadonly(domain) {
      const dom = Store.domains[domain];
      const panel = el('div', { class: 'fixed inset-0 aicx-panel aicx-enter-fade flex items-end sm:items-stretch justify-center', style: { zIndex: 40 } });
      const overlay = el('div', { class: 'absolute inset-0 bg-black/40' });
      overlay.addEventListener('click', () => panel.remove());
      const sheet = el('div', {
        class: 'relative bg-white dark:bg-zinc-900 w-full sm:max-w-md sm:mx-auto sm:my-4 sm:rounded-2xl rounded-t-2xl shadow-2xl flex flex-col aicx-enter-sheet aicx-full sm:h-[calc(100dvh-2rem)] overflow-hidden'
      });
      const header = el('div', { class: 'shrink-0 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2' });
      const close = el('button', { class: 'w-9 h-9 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center' });
      close.appendChild(icon('close'));
      close.addEventListener('click', () => panel.remove());
      header.append(el('div', { class: 'flex-1 text-sm font-semibold truncate' }, domain), close);
      const list = el('div', { class: 'flex-1 aicx-scroll overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800' });
      for (const c of dom.conversations) {
        const row = el('div', { class: 'p-3' });
        row.append(
          el('div', { class: 'text-sm font-medium truncate' }, c.title || '(無題)'),
          el('div', { class: 'text-xs text-zinc-500' }, `${fmtDate(c.updatedAt || c.createdAt)} · ${c.messages.filter((m) => m.role !== 'system').length} msg`)
        );
        const actions = el('div', { class: 'flex gap-2 mt-2' });
        const del = this.btn('削除', async () => {
          if (await UI.confirm('この会話を削除しますか?')) {
            dom.conversations = dom.conversations.filter((x) => x.id !== c.id);
            await Store.saveDomains();
            row.remove();
          }
        }, 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300');
        actions.append(del);
        row.append(actions);
        list.append(row);
      }
      sheet.append(header, list);
      panel.append(overlay, sheet);
      UI.root.appendChild(panel);
    },

    sectionBackup() {
      const box = el('section', { class: 'space-y-3' });
      box.append(this.sectionTitle('Google Drive バックアップ'));

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

      box.append(this.label('OAuth クライアント ID'));
      box.append(this.input(Store.settings.driveClientId, (v) => { Store.settings.driveClientId = v.trim(); Store.saveSettings(); }, { placeholder: 'xxxxx.apps.googleusercontent.com' }));

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
      row.append(this.btn('接続', async () => {
        if (!Store.settings.driveClientId) { UI.toast('クライアント ID を入力してください', 'error'); return; }
        if (!await UI.confirm('Google 認証のため現在のページを離れます。入力中のフォーム等があれば保存してください。続行しますか?')) return;
        try { Drive.startOAuth(Store.settings.driveClientId); } catch (e) { UI.toast(e.message, 'error'); }
      }));
      row.append(this.btn('今すぐバックアップ', async () => {
        try { await Drive.upload(); UI.toast('バックアップしました', 'success'); updateStatus(); }
        catch (e) { UI.toast(e.message, 'error'); }
      }, 'bg-emerald-600 text-white'));
      row.append(this.btn('Drive から復元', async () => {
        if (!await UI.confirm('現在の設定/履歴を上書きします。続行しますか?')) return;
        try { await Drive.download(); UI.toast('復元しました', 'success'); this.close(); this.open(); }
        catch (e) { UI.toast(e.message, 'error'); }
      }, 'bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100'));
      row.append(this.btn('切断', async () => { await Drive.signOut(); updateStatus(); }, 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200'));
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
      box.append(this.sectionTitle('テーマ'));
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
      box.append(this.sectionTitle('情報'));
      box.append(el('p', { class: 'text-xs text-zinc-500' }, 'AI Chat Overlay v0.1.0 · Tailwind CSS · Gemini API · Google Drive'));
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
