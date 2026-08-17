// ==UserScript==
// @name         AI Chat Overlay
// @name:ja      AI チャット オーバーレイ
// @namespace    https://github.com/ym/userscripts/ai-chat
// @version      1.2.0
// @description  Floating AI chat (Gemini) with page context, per-domain history, templates, Google Drive backup, and an agentic UserScript authoring mode. Optimized for iOS Safari.
// @description:ja Webページの内容を文脈として Gemini と対話できるオーバーレイ AI チャット。ページを解析して Tampermonkey 向け UserScript を作る「UserScript 作成モード」搭載。ドメインごとの履歴・テンプレート・Google Drive バックアップ対応。iOS Safari 最適化。
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
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      generativelanguage.googleapis.com
// @connect      www.googleapis.com
// @connect      oauth2.googleapis.com
// @connect      cdn.jsdelivr.net
// @noframes
// ==/UserScript==
// Libraries (marked / DOMPurify / Readability) are NOT @require'd any more.
// Rationale: iOS Safari + Tampermonkey does not reliably honour @noframes for
// iframe navigations — sites that repeatedly retarget a single iframe at new
// sub-apps (Speedometer 3.1's benchmark runner is the canonical example) can
// re-inject the userscript on every navigation, re-parsing every @require'd
// library each time. With ~150 KB of libraries that accumulates into memory
// pressure and crashes the browser. Instead, the libraries are fetched by
// the `LazyLibs` module on the first FAB click, cached in KV storage so
// subsequent page loads are offline, and injected via a page <script> tag so
// both sandboxed and page-world userscript hosts can see the globals.

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
  // 1b. Lazy library loader (marked / DOMPurify / Readability)
  // =========================================================================
  // Fetches each library on first demand, caches the source in KV storage,
  // and injects it into the page via a <script> tag (so the UMD wrapper's
  // assignments land on the page's global object regardless of whether the
  // userscript manager runs us in a sandbox or the page world). Callers
  // should `await LazyLibs.load()` before relying on `marked`, `DOMPurify`,
  // or `Readability`; intermediate renderers fall back gracefully when the
  // libraries are not yet available (see MD.render / Page._extractReadability).
  const LazyLibs = {
    specs: [
      { global: 'marked',      cacheKey: 'lib:marked@12.0.2',     url: 'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js' },
      { global: 'DOMPurify',   cacheKey: 'lib:dompurify@3.0.11',  url: 'https://cdn.jsdelivr.net/npm/dompurify@3.0.11/dist/purify.min.js' },
      { global: 'Readability', cacheKey: 'lib:readability@0.5.0', url: 'https://cdn.jsdelivr.net/npm/@mozilla/readability@0.5.0/Readability.js' }
    ],
    _promise: null,
    load() {
      if (this._promise) return this._promise;
      this._promise = Promise.all(this.specs.map((s) => this._loadOne(s))).then(() => {});
      return this._promise;
    },
    loaded(name) {
      return typeof window[name] !== 'undefined';
    },
    async _loadOne(spec) {
      if (typeof window[spec.global] !== 'undefined') return;
      let source = null;
      try { source = await KV.get(spec.cacheKey, null); } catch {}
      if (!source) {
        try {
          source = await this._fetch(spec.url);
          KV.set(spec.cacheKey, source).catch(() => {});
        } catch (e) {
          console.warn('[aicx] library fetch failed:', spec.global, e && e.message || e);
          return;
        }
      }
      try {
        // Inject as a page <script> so UMD wrappers assign to page's window
        // even when the userscript itself runs in an isolated sandbox.
        const script = document.createElement('script');
        script.textContent = source + '\n//# sourceURL=' + spec.global + '.js';
        (document.head || document.documentElement).appendChild(script);
        script.remove();
      } catch (e) {
        // Fallback: indirect eval in the userscript scope. If the manager
        // runs us in the page world this reaches window directly; in a
        // sandbox it at least makes the symbol visible to our own code.
        try { (0, eval)(source); } catch (e2) {
          console.warn('[aicx] library exec failed:', spec.global, e2 && e2.message || e2);
        }
      }
    },
    _fetch(url) {
      return new Promise((resolve, reject) => {
        const gmXhr = (typeof GM !== 'undefined' && GM && GM.xmlHttpRequest) ||
                      (typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null);
        if (gmXhr) {
          try {
            gmXhr({
              method: 'GET',
              url,
              timeout: 20000,
              onload: (res) => {
                if (res && res.status >= 200 && res.status < 300) resolve(res.responseText);
                else reject(new Error('HTTP ' + (res && res.status)));
              },
              onerror: () => reject(new Error('network error')),
              ontimeout: () => reject(new Error('timeout'))
            });
            return;
          } catch { /* fall through to fetch */ }
        }
        // jsDelivr sets Access-Control-Allow-Origin: * so plain fetch works
        // whenever GM XHR is unavailable or blocked.
        fetch(url, { cache: 'force-cache' })
          .then((r) => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
          .then(resolve, reject);
      });
    }
  };

  // =========================================================================
  // 2. Utilities
  // =========================================================================
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const now = () => Date.now();
  const $ = (sel, root) => (root || document).querySelector(sel);
  // Events originating inside a shadow tree have their `target` retargeted
  // to the shadow host when observed from the light DOM, so `.contains(target)`
  // no longer works against shadow-internal elements. Walking `composedPath`
  // piercing the shadow boundary gives the true event path.
  const eventPathIncludes = (container, e) => {
    if (!container) return false;
    const path = (e && typeof e.composedPath === 'function') ? e.composedPath() : null;
    if (path && path.length) return path.indexOf(container) !== -1;
    return !!(e && e.target && container.contains(e.target));
  };
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
    // Models the user has explicitly added in Settings. The chat-side picker
    // shows only these; the full Gemini catalog is fetched only to populate
    // the "add model" dropdown in Settings. Shape: [{ id, display }].
    addedModels: [],
    globalSystemPrompt: 'You are a helpful AI assistant. The user is viewing a webpage; use its content as context. Respond in the same language as the user.',
    // System prompt for the UserScript authoring mode (chats started from the
    // FAB menu's "新規 UserScript" entry). Empty means "use the built-in
    // default" — see UserScriptMode.DEFAULT_SYSTEM_PROMPT.
    userscriptSystemPrompt: '',
    // How many model→tool→model round trips one send() may make in UserScript
    // mode before it stops and hands control back. See
    // UserScriptMode.maxToolRounds() for clamping.
    userscriptMaxToolRounds: 50,
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
    //   'none'  : do not attach the current page as context (per-chat opt-out;
    //             this is also what restored conversations default to so the
    //             stored pageSnapshot is used instead of the current page)
    pageExtractMode: 'auto',
    // Cap on the page text fed to the model as context. Long pages are
    // truncated to this many characters before being attached.
    pageContextMaxChars: 20000
  };

  const Store = {
    settings: { ...DEFAULT_SETTINGS },
    domains: {}, // { [host]: { systemPrompt?, templates: [], conversations: [] } }
    async load() {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, await KV.get('settings', {}));
      this.domains = await KV.get('domains', {});
      // Seed addedModels for users upgrading from a single-model layout so
      // their previously-selected model survives in the chat picker.
      if (!Array.isArray(this.settings.addedModels)) this.settings.addedModels = [];
      if (!this.settings.addedModels.length && this.settings.model) {
        this.settings.addedModels.push({ id: this.settings.model, display: this.settings.model });
      }
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
    // `mode` marks a conversation as belonging to a non-default chat mode
    // (currently only 'userscript'). It is persisted so reopening the chat
    // from history restores the same tools, system prompt, and UI affordances.
    newConversation(host, mode) {
      const d = this.getDomain(host);
      const c = { id: uid(), title: '', createdAt: now(), updatedAt: now(), messages: [] };
      if (mode) c.mode = mode;
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
    // True when a domain carries no conversations, no templates, no system-
    // prompt override, and no page-extract-mode override. Used by bulk
    // operations (e.g. wipe-all-history) to drop domain entries that are
    // effectively blank.
    isDomainEmpty(d) {
      if (!d) return true;
      if (d.conversations && d.conversations.length) return false;
      if (d.templates && d.templates.length) return false;
      if (d.systemPrompt && d.systemPrompt.trim()) return false;
      if (d.pageExtractMode && d.pageExtractMode !== 'inherit') return false;
      return true;
    },
    pruneEmptyDomains() {
      let removed = 0;
      for (const host of Object.keys(this.domains)) {
        if (this.isDomainEmpty(this.domains[host])) {
          delete this.domains[host];
          removed++;
        }
      }
      return removed;
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

  // GM_xmlhttpRequest wrapper — bypasses the page's CSP (can't do SSE, so this
  // is only used as a fallback when plain fetch is blocked by strict CSPs).
  const _gmXhr = (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest
    : (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') ? GM.xmlHttpRequest.bind(GM)
    : null;
  function gmRequest({ method = 'GET', url, headers, body, signal }) {
    return new Promise((resolve, reject) => {
      if (!_gmXhr) { reject(new Error('GM_xmlhttpRequest is unavailable')); return; }
      if (signal && signal.aborted) {
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        return;
      }
      const handle = _gmXhr({
        method, url, headers, data: body, responseType: 'text',
        onload: (r) => resolve({ status: r.status, statusText: r.statusText, responseText: r.responseText }),
        onerror: (r) => reject(new Error(`Network error${r && r.status ? ' ' + r.status : ''}${r && r.statusText ? ' ' + r.statusText : ''}`)),
        ontimeout: () => reject(new Error('Request timed out')),
        onabort: () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
      });
      if (signal) {
        const onAbort = () => { try { handle && handle.abort && handle.abort(); } catch {} };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  // Streaming variant of GM.xmlHttpRequest.
  //
  // Prefers Tampermonkey's `responseType: 'stream'`, which exposes a real
  // ReadableStream on `onloadstart`'s `response.response`. That path delivers
  // bytes as the server flushes them — exactly what SSE needs.
  //
  // When the runtime doesn't honor `responseType: 'stream'` (Violentmonkey,
  // older Tampermonkey builds), we fall back to reading `responseText` growth
  // from `onprogress`. That path is best-effort: some environments buffer
  // more aggressively, which can coalesce chunks but still produces valid
  // (just chunkier) output.
  function gmStream({ method = 'GET', url, headers, body, signal }) {
    return {
      [Symbol.asyncIterator]() {
        const queue = [];
        let pendingResolve = null;
        let pendingReject = null;
        let finished = false;
        let failure = null;
        let lastIndex = 0;
        let usingReadableStream = false;
        let streamReader = null;
        let streamEndTimer = null;
        let handle = null;

        const push = (chunk) => {
          if (!chunk) return;
          if (pendingResolve) {
            const r = pendingResolve; pendingResolve = null; pendingReject = null;
            r({ value: chunk, done: false });
          } else {
            queue.push(chunk);
          }
        };
        const finish = (err) => {
          if (finished) return;
          finished = true;
          failure = err || null;
          if (streamEndTimer) { clearTimeout(streamEndTimer); streamEndTimer = null; }
          // Wake any pending reader.read() in pumpReadable so it can exit.
          // cancel() fulfils the pending read with {done: true}; subsequent
          // reads resolve the same way, so the pump loop terminates cleanly.
          if (streamReader) {
            try { streamReader.cancel(); } catch {}
          }
          if (pendingResolve) {
            const r = pendingResolve; const j = pendingReject;
            pendingResolve = null; pendingReject = null;
            if (err) j(err); else r({ value: undefined, done: true });
          }
        };
        const drainResponseText = (r) => {
          const text = r && typeof r.responseText === 'string' ? r.responseText : '';
          if (text.length > lastIndex) {
            const slice = text.slice(lastIndex);
            lastIndex = text.length;
            push(slice);
          }
        };
        const pumpReadable = async (stream) => {
          usingReadableStream = true;
          streamReader = stream.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { value, done } = await streamReader.read();
              if (done) break;
              if (value == null) continue;
              if (typeof value === 'string') push(value);
              else push(decoder.decode(value, { stream: true }));
            }
            const tail = decoder.decode();
            if (tail) push(tail);
          } catch (e) {
            if (!finished) finish(e);
            return;
          }
          if (!finished) finish(null);
        };
        // Safety net: some Tampermonkey builds deliver all chunks through the
        // stream but never flip `done: true`, so `pumpReadable`'s reader stays
        // pending forever. When the XHR's `onload`/`onloadend` fires we know
        // no more bytes are coming — give the pump a brief grace window to
        // drain any already-enqueued chunks, then force-close.
        const scheduleStreamEnd = () => {
          if (finished || streamEndTimer) return;
          streamEndTimer = setTimeout(() => {
            streamEndTimer = null;
            if (!finished) finish(null);
          }, 250);
        };

        if (!_gmXhr) {
          finish(new Error('GM_xmlhttpRequest is unavailable'));
        } else if (signal && signal.aborted) {
          finish(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        } else {
          handle = _gmXhr({
            method, url, headers, data: body,
            responseType: 'stream',
            onloadstart: (r) => {
              const resp = r && r.response;
              if (resp && typeof resp.getReader === 'function') {
                pumpReadable(resp);
              }
            },
            onprogress: (r) => {
              if (usingReadableStream) return;
              try { drainResponseText(r); } catch {}
            },
            onload: (r) => {
              if (r && (r.status < 200 || r.status >= 300)) {
                finish(new Error(`Gemini request failed: ${r.status} ${(r && r.responseText) || (r && r.statusText) || ''}`));
                return;
              }
              if (!usingReadableStream) {
                try { drainResponseText(r); } catch {}
                finish(null);
                return;
              }
              scheduleStreamEnd();
            },
            onloadend: () => { if (usingReadableStream) scheduleStreamEnd(); },
            onerror: (r) => finish(new Error(`Network error${r && r.status ? ' ' + r.status : ''}${r && r.statusText ? ' ' + r.statusText : ''}`)),
            ontimeout: () => finish(new Error('Request timed out')),
            onabort: () => finish(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
          });
          if (signal) {
            signal.addEventListener('abort', () => {
              try { handle && handle.abort && handle.abort(); } catch {}
            }, { once: true });
          }
        }

        return {
          next() {
            if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
            if (finished) {
              if (failure) return Promise.reject(failure);
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve, reject) => {
              pendingResolve = resolve;
              pendingReject = reject;
            });
          },
          return(v) {
            try { handle && handle.abort && handle.abort(); } catch {}
            finish(null);
            return Promise.resolve({ value: v, done: true });
          },
          throw(e) {
            try { handle && handle.abort && handle.abort(); } catch {}
            finish(e);
            return Promise.reject(e);
          }
        };
      }
    };
  }

  // Adapt a ReadableStream (e.g. fetch response body) into an async iterable
  // of decoded text chunks so it can share the SSE parsing loop with gmStream.
  async function* readerToTextChunks(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) yield decoder.decode(value, { stream: true });
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  const Gemini = {
    // Compact badge for a Gemini model id: "gemini-2.5-pro" → "2.5P",
    // "gemini-3-flash" → "3F", "gemini-2.0-flash-lite" → "2.0FL". Falls
    // back to a truncation of the non-prefix portion for odd ids so the
    // UI always has something short to display.
    abbreviate(id) {
      if (!id) return '—';
      const s = String(id).replace(/^models\//, '').replace(/^gemini-/i, '');
      const ver = (s.match(/^([0-9]+(?:\.[0-9]+)?)/) || [])[1] || '';
      let tier = '';
      if (/flash-lite/i.test(s)) tier = 'FL';
      else if (/\bpro\b/i.test(s)) tier = 'P';
      else if (/\bflash\b/i.test(s)) tier = 'F';
      else if (/\bultra\b/i.test(s)) tier = 'U';
      else if (/\bnano\b/i.test(s)) tier = 'N';
      const out = ver + tier;
      return out || s.slice(0, 6).toUpperCase();
    },
    async listModels(apiKey) {
      if (!apiKey) throw new Error('API key is required.');
      const url = `${API_BASE}/models?pageSize=200&key=${encodeURIComponent(apiKey)}`;
      let data;
      let res = null;
      try {
        res = await fetch(url);
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        // CSP / network — fall through to GM_xmlhttpRequest fallback below.
        console.warn('[aicx] fetch listModels blocked, falling back to GM_xmlhttpRequest:', e);
      }
      if (res) {
        if (!res.ok) throw new Error(`Gemini listModels failed: ${res.status} ${await res.text()}`);
        data = await res.json();
      } else {
        const r = await gmRequest({ method: 'GET', url });
        if (r.status < 200 || r.status >= 300) throw new Error(`Gemini listModels failed: ${r.status} ${r.responseText || r.statusText || ''}`);
        try { data = JSON.parse(r.responseText); } catch { throw new Error('Gemini listModels: invalid JSON response'); }
      }
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

    // Build Gemini "contents" array from our message history.
    //
    // Besides plain text and inline attachments, a message may carry
    // `functionCalls` (emitted by the model, replayed on the `model` turn) or
    // `functionResponses` (our locally-computed tool results, sent back on a
    // `user` turn). Both are required verbatim for multi-turn function calling
    // — Gemini rejects a functionResponse that has no matching functionCall
    // earlier in the transcript, and the `id` must be echoed when the model
    // supplied one.
    //
    // THOUGHT SIGNATURES. Thinking models return an opaque `thoughtSignature`
    // on the *Part* (a sibling of `functionCall`, not a field inside it), and
    // Gemini 3 STRICTLY validates that it comes back on every replayed
    // functionCall part — omit it and the next request dies with
    // `400 INVALID_ARGUMENT: Function call is missing a thought_signature`.
    // So the signature is captured at stream time (see streamGenerate) and
    // re-emitted here on exactly the part it arrived on. With parallel calls
    // only the first part carries one; storing it per call reproduces that
    // shape naturally. On text parts the signature is merely recommended (it
    // preserves the model's reasoning chain), so a missing one is fine there.
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
        if (m.content && m.content.trim()) {
          const part = { text: m.content };
          if (m.thoughtSignature) part.thoughtSignature = m.thoughtSignature;
          parts.push(part);
        }
        if (m.functionCalls) {
          for (const fc of m.functionCalls) {
            if (!fc || !fc.name) continue;
            const call = { name: fc.name, args: fc.args || {} };
            if (fc.id) call.id = fc.id;
            const part = { functionCall: call };
            if (fc.thoughtSignature) part.thoughtSignature = fc.thoughtSignature;
            parts.push(part);
          }
        }
        if (m.functionResponses) {
          for (const fr of m.functionResponses) {
            if (!fr || !fr.name) continue;
            const resp = { name: fr.name, response: fr.response || {} };
            if (fr.id) resp.id = fr.id;
            parts.push({ functionResponse: resp });
          }
        }
        if (parts.length) contents.push({ role, parts });
      }
      return contents;
    },

    // Yields assistant text as it streams. Non-text response parts are handed
    // to callbacks instead: `onMetadata` for grounding citations,
    // `onFunctionCall(call, thoughtSignature)` for tool invocations (the caller
    // executes them and re-enters this generator with the results appended to
    // `messages`), and `onThoughtSignature` for the signature riding on the
    // turn's first text part. Both signatures must survive into the stored
    // message so buildContents can replay them — see the THOUGHT SIGNATURES
    // note there.
    async *streamGenerate({ apiKey, model, messages, systemPrompt, tools, onMetadata, onFunctionCall, onThoughtSignature, signal }) {
      if (!apiKey) throw new Error('API キーが設定されていません。設定画面から登録してください。');
      if (!model) throw new Error('モデルが選択されていません。');
      const streamUrl = `${API_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
      const body = {
        contents: this.buildContents(messages),
        generationConfig: { temperature: 0.7 }
      };
      // Implicit context: tell the model the current local date so it can
      // resolve "today" / "yesterday" / "next Friday" without us threading
      // it through every user-facing prompt. Prepended to the system
      // instruction; not shown in the context preview.
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
      const dateLine = `Today's date: ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} (${weekday})`;
      const sys = systemPrompt && systemPrompt.trim() ? `${dateLine}\n\n${systemPrompt}` : dateLine;
      body.systemInstruction = { role: 'user', parts: [{ text: sys }] };
      // Attach tools when the user opted into grounding. Otherwise pin
      // functionCallingConfig to NONE: Gemini 2.5 sporadically emits a stray
      // function-call token when no tools are declared and aborts the turn
      // with MALFORMED_FUNCTION_CALL. Explicitly prohibiting function calls
      // ("Model is prohibited from making function calls") removes that
      // failure mode at the source. Grounding tools (googleSearch/urlContext)
      // are not user-declared functions, so when tools ARE present we leave
      // the default AUTO behaviour and don't send toolConfig.
      if (tools && tools.length) {
        body.tools = tools;
      } else {
        body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
      }
      const payload = JSON.stringify(body);
      const reqHeaders = { 'content-type': 'application/json' };

      // Pick a transport: try fetch first (native SSE); if the page's CSP
      // (or a network error) blocks it, fall back to GM.xmlHttpRequest and
      // stream incrementally via its onprogress callback.
      let chunks;
      let res = null;
      try {
        res = await fetch(streamUrl, { method: 'POST', headers: reqHeaders, body: payload, signal });
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        console.warn('[aicx] fetch streamGenerate blocked, falling back to GM.xmlHttpRequest:', e);
      }
      if (res) {
        if (!res.ok || !res.body) {
          const t = await res.text();
          throw new Error(`Gemini request failed: ${res.status} ${t}`);
        }
        chunks = readerToTextChunks(res.body);
      } else {
        chunks = gmStream({ method: 'POST', url: streamUrl, headers: reqHeaders, body: payload, signal });
      }

      // Shared SSE parsing loop. Both transports deliver text chunks that we
      // split on blank-line boundaries, then parse `data:` lines as JSON.
      let buf = '';
      let yieldedText = false;
      for await (const text of chunks) {
        buf += text;
        const parts = buf.split(/\r?\n\r?\n/);
        buf = parts.pop();
        for (const chunk of parts) {
          const lines = chunk.split(/\r?\n/).filter((l) => l.startsWith('data:'));
          for (const line of lines) {
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let obj;
            try { obj = JSON.parse(data); } catch { continue; }
            if (obj && obj.error) {
              throw new Error((obj.error.message || 'Gemini API error') + (obj.error.status ? ` (${obj.error.status})` : ''));
            }
            const cand = obj && obj.candidates && obj.candidates[0];
            const parts2 = cand && cand.content && cand.content.parts;
            if (parts2) {
              for (const p of parts2) {
                if (p.text) {
                  // Text arrives split across many parts that we concatenate
                  // into one message, so only the first part's signature can
                  // be meaningfully replayed (it is the one the docs say the
                  // leading part always carries).
                  if (!yieldedText && p.thoughtSignature && typeof onThoughtSignature === 'function') {
                    try { onThoughtSignature(p.thoughtSignature); } catch (e) { console.warn('[aicx] onThoughtSignature threw:', e); }
                  }
                  yieldedText = true;
                  yield p.text;
                }
                if (p.functionCall && p.functionCall.name && typeof onFunctionCall === 'function') {
                  try { onFunctionCall(p.functionCall, p.thoughtSignature); } catch (e) { console.warn('[aicx] onFunctionCall threw:', e); }
                }
              }
            }
            if (cand && cand.groundingMetadata && typeof onMetadata === 'function') {
              try { onMetadata(cand.groundingMetadata); } catch {}
            }
            if (cand && cand.finishReason && cand.finishReason !== 'FINISH_REASON_UNSPECIFIED') {
              // Gemini's final SSE frame always carries a finishReason. Using
              // it as the authoritative end-of-response signal lets us exit
              // the generator (and, via the inner iterator's return(), abort
              // the GM_xmlhttpRequest) even when the transport itself never
              // signals stream-close — some Tampermonkey builds deliver every
              // byte but never flip the ReadableStream to `done: true`, and
              // their `onload`/`onloadend` callbacks also don't fire in
              // `responseType: 'stream'` mode. Waiting for transport close
              // there leaves the request (and the UI "generating" state)
              // pending forever.
              if (cand.finishReason !== 'STOP') {
                // MALFORMED_FUNCTION_CALL is a known Gemini 2.5 fault: the
                // model emits a stray function-call-shaped token even when no
                // tools are configured, and the API aborts the turn. It is
                // sporadic (re-running the identical request usually succeeds)
                // and — whether it fires before or midway through the text —
                // leaves a broken/partial answer. So we ALWAYS raise it as a
                // retryable error (previously only when no text had streamed
                // yet) and let the caller re-run from scratch, rather than
                // dumping an opaque `_(finishReason: …)_` marker or a truncated
                // reply on the user. Enabling a grounding tool masks the bug
                // only because the stray call then has a valid landing spot.
                if (cand.finishReason === 'MALFORMED_FUNCTION_CALL') {
                  const err = new Error('MALFORMED_FUNCTION_CALL');
                  err.code = 'MALFORMED_FUNCTION_CALL';
                  err.retryable = true;
                  throw err;
                }
                // Other non-STOP reasons (SAFETY, MAX_TOKENS, RECITATION, …)
                // are meaningful — surface them to the user via a tail message.
                yield `\n\n_(finishReason: ${cand.finishReason})_`;
              }
              return;
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
    // Extra tags to drop in 'raw' HTML output — in-body <link>/<meta>/<base>
    // carry no user-visible content. <input type=hidden> likewise.
    RAW_EXTRA_STRIP: 'link,meta,base,input[type="hidden"]',
    // Attributes removed in 'raw' HTML output. Presentation (class/style),
    // identity hooks (id), a11y metadata (aria-*, role, tabindex), custom
    // data-*, inline event handlers (on*), and a handful of editor-only
    // boolean attributes — none of which contribute to body content.
    RAW_DROP_ATTR_EXACT: new Set([
      'class', 'style', 'id', 'tabindex', 'role',
      'contenteditable', 'spellcheck', 'draggable',
      'autocapitalize', 'autocorrect', 'translate', 'slot', 'part', 'is'
    ]),
    // Strict chrome strip for 'clean' mode: removes navigation/boilerplate
    // plus <aside>/<footer>/complementary roles. Note this also strips
    // comment widgets on sites (e.g. Yahoo News) that wrap comments in
    // <aside>; users who want comments should pick 'auto' mode which uses
    // the permissive strip below.
    CHROME_STRIP: [
      'header', 'footer', 'nav', 'aside',
      '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]', '[role="search"]',
      '[aria-hidden="true"]', '[hidden]'
    ].join(','),
    // Permissive chrome strip for 'auto' mode's heuristic supplement:
    // keeps <aside>, <footer>, and complementary roles so comments and
    // related-content sections (which frequently live there) survive. Only
    // strips clear site chrome + aria-hidden.
    CHROME_STRIP_PERMISSIVE: [
      'header', 'nav',
      '[role="navigation"]', '[role="banner"]', '[role="search"]',
      '[aria-hidden="true"]', '[hidden]'
    ].join(','),
    MAX_TEXT_DEFAULT: 20000,
    get MAX_TEXT() {
      const n = Number(Store.settings && Store.settings.pageContextMaxChars);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : this.MAX_TEXT_DEFAULT;
    },

    async snapshot(modeOverride) {
      const selection = (window.getSelection && String(window.getSelection())) || '';
      const title = document.title || '';
      const metaDesc = (document.querySelector('meta[name="description"]') || {}).content || '';
      const url = location.href;

      // Prime (once) the raw-HTML cache used to recover tweet embeds that
      // got replaced by cross-origin iframes. Await here so the first
      // snapshot already includes tweets; subsequent calls hit the cache.
      await this.primeRawDoc();

      const mode = modeOverride || Store.resolvePageExtractMode();
      // `auto` mode blends heuristic text with Readability output. Await
      // the lazy library load so the very first send after FAB-open can
      // use Readability — normally this resolves instantly because the
      // menu-open hook kicked off loading already, or because the source
      // is cached in KV from a prior session.
      if (mode === 'auto') {
        try { await LazyLibs.load(); } catch {}
      }
      let text = '';
      let effectiveMode = mode;

      if (mode === 'auto') {
        // Permissive heuristic from <main> as primary — this captures the
        // article body plus side content (comments, related articles) that
        // Readability aggressively strips. Readability is used only as a
        // supplement: if it produces text not already in the heuristic,
        // that extra text is appended. On news sites like Yahoo, Readability
        // often misfires and picks a sidebar widget as the "article", so
        // using it as primary is unreliable.
        const heurText = this._extractHeuristic('permissive', true);
        const readText = this._extractReadability();
        text = this._mergeAutoTexts(heurText, readText);
        if (!text) { effectiveMode = 'clean'; text = this._extractHeuristic('clean'); }
      } else if (mode === 'clean') {
        text = this._extractHeuristic('clean');
      } else {
        text = this._extractRaw();
      }

      if (text.length > this.MAX_TEXT) text = text.slice(0, this.MAX_TEXT) + '\n...[truncated]';
      return { url, title, metaDesc, selection: selection.slice(0, 4000), text, mode: effectiveMode };
    },

    // Fetch the current page as raw HTML and parse it into a detached
    // Document we can query later. Used to recover text from embeds
    // (e.g. <blockquote class="twitter-tweet">) that were swapped out for
    // cross-origin iframes by third-party widget scripts. Idempotent.
    _rawDocPromise: null,
    _rawDoc: null,
    _tweetMap: null,
    primeRawDoc() {
      if (this._rawDocPromise) return this._rawDocPromise;
      this._rawDocPromise = (async () => {
        try {
          const res = await fetch(location.href, { credentials: 'include', cache: 'force-cache' });
          const buf = await res.arrayBuffer();
          // Honour the page's character set (EUC-JP / Shift_JIS / UTF-8, ...);
          // fetch().text() assumes UTF-8 and mojibakes non-UTF-8 pages.
          const charset = (document.characterSet || 'utf-8').toLowerCase();
          let decoded;
          try { decoded = new TextDecoder(charset).decode(buf); }
          catch { decoded = new TextDecoder('utf-8').decode(buf); }
          this._rawDoc = new DOMParser().parseFromString(decoded, 'text/html');
          this._buildTweetMap();
        } catch (e) {
          // Best-effort enhancement — silent failure is fine.
        }
      })();
      return this._rawDocPromise;
    },

    // Build a `tweetId → text` map from the cached raw doc. Each tweet's ID
    // comes from the status URL inside its <blockquote class="twitter-tweet">;
    // the same ID sits on the iframe's data-tweet-id in the live DOM, which
    // is how we later match them up for in-place replacement.
    _buildTweetMap() {
      this._tweetMap = new Map();
      if (!this._rawDoc) return;
      for (const bq of this._rawDoc.querySelectorAll('blockquote.twitter-tweet')) {
        const link = [...bq.querySelectorAll('a[href]')]
          .find((a) => /(?:twitter|x)\.com\/[^/]+\/status\/\d+/.test(a.href));
        const m = link && link.href.match(/status\/(\d+)/);
        if (!m) continue;
        const text = (bq.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length >= 10) this._tweetMap.set(m[1], text);
      }
    },

    // Replace rendered Twitter embed wrappers inside a clone with a div
    // containing the tweet's text, preserving the position in the document
    // so the embed reads inline with surrounding article content instead
    // of being appended at the end.
    _inlineEmbeds(clone) {
      if (!clone || !clone.querySelectorAll) return;
      if (!this._tweetMap || !this._tweetMap.size) return;
      for (const wrapper of clone.querySelectorAll('.twitter-tweet-rendered')) {
        const iframe = wrapper.querySelector('iframe[data-tweet-id]');
        const id = iframe && iframe.getAttribute('data-tweet-id');
        const text = id && this._tweetMap.get(id);
        if (!text) continue;
        const replacement = clone.ownerDocument.createElement('div');
        // Surround with blank lines so paragraph splitters in downstream
        // merge logic treat the embed as its own block.
        replacement.textContent = '\n[X/Twitter embed] ' + text + '\n';
        wrapper.replaceWith(replacement);
      }
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
        this._inlineEmbeds(docClone);
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

    // Prioritized CSS selectors for the article-body container on common
    // CMSes. Checked BEFORE falling back to plain <article>/<main> so the
    // heuristic doesn't trip over sites that use <article> for individual
    // comments. Concretely, LiveDoor Blog's mobile theme renders each
    // comment as `<article class="comment-list">` — without this list the
    // old heuristic would pick the first comment (≈ a hundred characters)
    // and miss the real post in `#article-contents`.
    ARTICLE_BODY_HINTS: [
      '[itemprop="articleBody"]',
      '#article-contents',
      '.article-body-inner',
      '.article-body',
      '.entry-content',
      '.post-content',
      '.post-body',
      '.story-body',
      '#mw-content-text' // Wikipedia
    ],
    // Minimum characters a candidate container must hold before we accept
    // it. Low enough to allow short posts, high enough to reject a single
    // comment or a "read more" teaser.
    MIN_ROOT_TEXT: 200,

    // Pick the DOM subtree the heuristic should walk. Priority, in order:
    //   1. <main> (only when preferMain and substantial)
    //   2. any ARTICLE_BODY_HINTS selector with substantial content
    //   3. the largest <article> on the page (substantial)
    //   4. legacy fallback chain main → article → body
    _findContentRoot(preferMain) {
      const enough = (el) => el && (el.innerText || '').length >= this.MIN_ROOT_TEXT;

      if (preferMain) {
        const main = document.querySelector('main');
        if (enough(main)) return main;
      }

      for (const sel of this.ARTICLE_BODY_HINTS) {
        let el;
        try { el = document.querySelector(sel); } catch { el = null; }
        if (enough(el)) return el;
      }

      const articles = Array.from(document.querySelectorAll('article'));
      if (articles.length) {
        articles.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length);
        if (enough(articles[0])) return articles[0];
      }

      const main = document.querySelector('main');
      const article = articles[0] || null;
      return preferMain
        ? (main || article || document.body)
        : (article || main || document.body);
    },

    // Heuristic extraction.
    //   stripLevel: 'clean' | 'permissive' | 'raw'
    //   preferMain: when true, pick <main> first (gets article + comments +
    //     related), then fall back to <article>. Default false keeps the old
    //     article-first behavior for 'clean' / 'raw' modes.
    _extractHeuristic(stripLevel, preferMain) {
      const root = this._findContentRoot(preferMain);
      if (!root) return '';
      const clone = root.cloneNode(true);
      this._stripSelf(clone);
      this._inlineEmbeds(clone);
      clone.querySelectorAll(this.BASE_STRIP).forEach((n) => n.remove());
      if (stripLevel === 'clean') clone.querySelectorAll(this.CHROME_STRIP).forEach((n) => n.remove());
      else if (stripLevel === 'permissive') clone.querySelectorAll(this.CHROME_STRIP_PERMISSIVE).forEach((n) => n.remove());
      return (clone.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    },

    // Raw extraction — emits the <body>'s HTML with minimal stripping so the
    // model sees document structure (headings, lists, links, ...) that plain-
    // text modes discard. Removes only content-irrelevant noise: scripts /
    // styles / media, HTML comments, presentation (class/style/id), a11y
    // metadata (aria-*/role/tabindex), custom data-*, and inline event
    // handlers. The textual content and semantic tags are preserved.
    _extractRaw() {
      const body = document.body;
      if (!body) return '';
      const clone = body.cloneNode(true);
      this._stripSelf(clone);
      this._inlineEmbeds(clone);
      clone.querySelectorAll(this.BASE_STRIP).forEach((n) => n.remove());
      clone.querySelectorAll(this.RAW_EXTRA_STRIP).forEach((n) => n.remove());

      const doc = clone.ownerDocument;
      const commentWalker = doc.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
      const comments = [];
      let c; while ((c = commentWalker.nextNode())) comments.push(c);
      for (const n of comments) n.remove();

      const all = [clone, ...clone.querySelectorAll('*')];
      for (const n of all) {
        if (!n.attributes || !n.attributes.length) continue;
        for (const attr of Array.from(n.attributes)) {
          const name = attr.name;
          if (
            this.RAW_DROP_ATTR_EXACT.has(name) ||
            name.startsWith('aria-') ||
            name.startsWith('data-') ||
            name.startsWith('on')
          ) {
            n.removeAttribute(name);
          }
        }
      }

      return (clone.innerHTML || '').replace(/\n{3,}/g, '\n\n').trim();
    },

    // Merge a primary text (typically permissive heuristic from <main>) with
    // a secondary text (typically Readability). Paragraphs from secondary
    // that are already contained in primary are skipped; genuinely new
    // paragraphs get appended under a separator. This lets auto mode fall
    // back gracefully when Readability misfires — the primary already has
    // the article + side content, and the secondary only contributes when
    // it found something primary missed.
    _mergeAutoTexts(primary, secondary) {
      if (!primary) return secondary || '';
      if (!secondary) return primary;

      const primCondensed = primary.replace(/\s+/g, '');
      const sigOf = (s) => s.slice(0, Math.min(50, s.length));
      const extras = [];
      for (const para of secondary.split(/\n{2,}/)) {
        const cond = para.replace(/\s+/g, '');
        if (!cond) continue;
        const needle = sigOf(cond);
        if (needle.length >= 10 && primCondensed.includes(needle)) continue;
        extras.push(para);
      }
      const extra = extras.join('\n\n').trim();
      if (!extra) return primary;
      return primary + '\n\n---\n\n' + extra;
    },

    formatForPrompt(snap) {
      const parts = [
        `# Current Page Context`,
        `URL: ${snap.url}`,
        `Title: ${snap.title}`
      ];
      if (snap.metaDesc) parts.push(`Description: ${snap.metaDesc}`);
      // Selection is intentionally NOT included here; it is attached per-message
      // to `userMsg.selection` (see ChatPanel.send) so every message the user
      // sends can carry its own highlighted excerpt, and so the quoted text
      // appears visibly in the chat bubble.
      if (snap.text) {
        const label = snap.mode === 'raw' ? 'Page HTML' : 'Page text';
        parts.push(`\n${label}:\n"""\n${snap.text}\n"""`);
      }
      return parts.join('\n');
    }
  };

  // =========================================================================
  // 6b. Page selection tracker
  // =========================================================================
  // Tracks the user's most recent non-empty text selection made *outside* the
  // overlay UI, so ChatPanel.send() can attach it to the outgoing message as
  // highlighted context. We listen on `selectionchange` instead of reading
  // `window.getSelection()` at send-time because focusing the composer
  // textarea on mobile typically collapses the page selection before send()
  // runs.
  const Selection = {
    _last: '',
    _listeners: new Set(),
    init() {
      const onChange = () => {
        try {
          const sel = window.getSelection && window.getSelection();
          if (!sel) return;
          const text = String(sel);
          // Empty selections fire on focus/caret moves — don't clobber the
          // stored page selection just because the user tapped into a field.
          if (!text) return;
          // Skip selections originating from a focused textarea/input inside
          // our overlay (e.g. the composer). Textarea selections have their
          // own internal model and `anchorNode` does not point into the
          // textarea's value, so the shadow-root check below cannot catch
          // them on browsers where `window.getSelection().toString()` still
          // surfaces the textarea's selected text.
          const active = (UI.shadow && UI.shadow.activeElement) || document.activeElement;
          if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
            if (UI.hostEl && UI.hostEl.contains(active)) return;
            if (UI.shadow && active.getRootNode && active.getRootNode() === UI.shadow) return;
          }
          const node = sel.anchorNode;
          const anchor = node && (node.nodeType === 3 ? node.parentNode : node);
          // Skip selections inside our overlay UI. The chat panel and its
          // messages live inside the open shadow root (`UI.shadow`), and
          // `Node.contains()` does not cross shadow boundaries — so a check
          // against the light-DOM host alone misses selections highlighted
          // inside assistant replies. Use `getRootNode()` to also catch
          // shadow-internal anchors and keep them out of the emphasized
          // context.
          if (anchor) {
            if (UI.hostEl && UI.hostEl.contains(anchor)) return;
            if (UI.shadow && anchor.getRootNode && anchor.getRootNode() === UI.shadow) return;
          }
          const next = text.slice(0, 4000);
          if (next === this._last) return;
          this._last = next;
          this._notify();
        } catch {}
      };
      document.addEventListener('selectionchange', onChange);
    },
    get() { return this._last; },
    clear() {
      if (!this._last) return;
      this._last = '';
      this._notify();
    },
    subscribe(fn) {
      this._listeners.add(fn);
      return () => this._listeners.delete(fn);
    },
    _notify() {
      for (const fn of this._listeners) { try { fn(this._last); } catch {} }
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
    // Add Tailwind classes so rendered markdown looks right inside the overlay
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
  // 9. Styles — precompiled Tailwind + hand-written base, installed into a
  //    Shadow Root by UI.init below.
  // =========================================================================
  //
  // All overlay styles are injected into a Shadow Root, so they cannot leak
  // into the host page and host-page CSS cannot cascade into the overlay
  // (except through inherited properties, which we pin on `:host`). The
  // Tailwind CSS string below is generated at build time by `build/build.mjs`
  // running the Tailwind CLI against this file as its content source — no
  // runtime CDN, no MutationObserver, no class scanner.
  //
  // ------------------------------------------------------------------------
  // NOTE FOR FUTURE AI AGENTS / MAINTAINERS — READ BEFORE EDITING STYLES
  // ------------------------------------------------------------------------
  // 1. The contents of `TAILWIND_CSS` between the
  //      TAILWIND_CSS_START ... TAILWIND_CSS_END
  //    markers are MACHINE-GENERATED. Do NOT hand-edit that string — any
  //    manual change will be silently overwritten the next time the build
  //    script runs. Edit classes in the userscript source instead, then
  //    rerun the build (see step 3).
  //
  // 2. When you ADD / REMOVE / RENAME any Tailwind utility class anywhere in
  //    this file (including template literals and dynamic `${...}` class
  //    names), the embedded CSS goes out of sync with the markup. You MUST
  //    rebuild so the Shadow-Root `<style>` contains rules for the new
  //    classes — otherwise the UI renders unstyled for those classes.
  //    Arbitrary-value utilities (e.g. `max-w-[160px]`, `text-[10px]`) must
  //    appear literally in a source string; do not construct them at runtime.
  //
  // 3. Build command (run from repo root or the `ai-chat/` directory):
  //      cd ai-chat
  //      npm install     # first time only
  //      npm run build   # regenerates TAILWIND_CSS in this file
  //    The script (`build/build.mjs`) invokes the Tailwind CLI configured at
  //    `build/tailwind.config.cjs` with this file as its content source and
  //    rewrites the region between the markers above. Commit the updated
  //    `ai-chat.user.js`; end users install that single file and never need
  //    Node / npm themselves.
  //
  // 4. The `important: '#aicx-root'` scoping trick used in the legacy Play
  //    CDN setup is intentionally GONE — Shadow DOM provides the isolation
  //    instead. Do not reintroduce runtime Tailwind loading (Play CDN,
  //    `<script src=cdn.tailwindcss.com>`, `new Function(source)()`, etc.);
  //    that was what caused Speedometer-class pages to suffer massive perf
  //    regressions and style leakage. All styling must go through the
  //    precompiled path above.
  // ------------------------------------------------------------------------
  /* @TAILWIND_CSS_START */
  const TAILWIND_CSS = `.\\!container{width:100%!important}.container{width:100%}@media (min-width:640px){.\\!container{max-width:640px!important}.container{max-width:640px}}@media (min-width:768px){.\\!container{max-width:768px!important}.container{max-width:768px}}@media (min-width:1024px){.\\!container{max-width:1024px!important}.container{max-width:1024px}}@media (min-width:1280px){.\\!container{max-width:1280px!important}.container{max-width:1280px}}@media (min-width:1536px){.\\!container{max-width:1536px!important}.container{max-width:1536px}}.pointer-events-none{pointer-events:none}.pointer-events-auto{pointer-events:auto}.\\!visible{visibility:visible!important}.visible{visibility:visible}.invisible{visibility:hidden}.fixed{position:fixed}.absolute{position:absolute}.relative{position:relative}.inset-0{inset:0}.bottom-4{bottom:1em}.bottom-full{bottom:100%}.left-0{left:0}.left-1{left:.25em}.left-1\\/2{left:50%}.z-20{z-index:20}.mx-3{margin-left:.75em;margin-right:.75em}.my-1{margin-top:.25em;margin-bottom:.25em}.my-2{margin-top:.5em;margin-bottom:.5em}.my-3{margin-top:.75em;margin-bottom:.75em}.mb-1{margin-bottom:.25em}.mb-2{margin-bottom:.5em}.mb-3{margin-bottom:.75em}.ml-5{margin-left:1.25em}.mr-1{margin-right:.25em}.mr-2{margin-right:.5em}.mt-0{margin-top:0}.mt-0\\.5{margin-top:.125em}.mt-1{margin-top:.25em}.mt-1\\.5{margin-top:.375em}.mt-2{margin-top:.5em}.mt-3{margin-top:.75em}.mt-4{margin-top:1em}.line-clamp-2{-webkit-line-clamp:2}.line-clamp-2,.line-clamp-3{overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical}.line-clamp-3{-webkit-line-clamp:3}.\\!block{display:block!important}.block{display:block}.inline-block{display:inline-block}.inline{display:inline}.flex{display:flex}.inline-flex{display:inline-flex}.table{display:table}.grid{display:grid}.contents{display:contents}.hidden{display:none}.h-1{height:.25em}.h-10{height:2.5em}.h-3{height:.75em}.h-3\\.5{height:.875em}.h-4{height:1em}.h-5{height:1.25em}.h-6{height:1.5em}.h-64{height:16em}.h-7{height:1.75em}.h-8{height:2em}.h-9{height:2.25em}.h-auto{height:auto}.max-h-40{max-height:10em}.max-h-64{max-height:16em}.max-h-80{max-height:20em}.max-h-\\[160px\\]{max-height:160px}.max-h-\\[85dvh\\]{max-height:85dvh}.min-h-\\[40px\\]{min-height:40px}.w-10{width:2.5em}.w-24{width:6em}.w-3{width:.75em}.w-3\\.5{width:.875em}.w-4{width:1em}.w-5{width:1.25em}.w-6{width:1.5em}.w-7{width:1.75em}.w-72{width:18em}.w-8{width:2em}.w-9{width:2.25em}.w-full{width:100%}.min-w-0{min-width:0}.min-w-\\[220px\\]{min-width:220px}.min-w-\\[80px\\]{min-width:80px}.max-w-2xl{max-width:42em}.max-w-\\[160px\\]{max-width:160px}.max-w-\\[200px\\]{max-width:200px}.max-w-\\[85\\%\\]{max-width:85%}.max-w-\\[90\\%\\]{max-width:90%}.max-w-full{max-width:100%}.max-w-sm{max-width:24em}.max-w-xl{max-width:36em}.flex-1{flex:1 1 0%}.flex-shrink,.shrink{flex-shrink:1}.shrink-0{flex-shrink:0}.border-collapse{border-collapse:collapse}.-translate-x-1{--tw-translate-x:-0.25em}.-translate-x-1,.-translate-x-1\\/2{transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}.-translate-x-1\\/2{--tw-translate-x:-50%}.transform{transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}.cursor-pointer{cursor:pointer}.select-none{-webkit-user-select:none;-moz-user-select:none;user-select:none}.resize{resize:both}.list-decimal{list-style-type:decimal}.list-disc{list-style-type:disc}.grid-cols-6{grid-template-columns:repeat(6,minmax(0,1fr))}.flex-col{flex-direction:column}.flex-wrap{flex-wrap:wrap}.items-start{align-items:flex-start}.items-end{align-items:flex-end}.items-center{align-items:center}.justify-start{justify-content:flex-start}.justify-end{justify-content:flex-end}.justify-center{justify-content:center}.gap-1{gap:.25em}.gap-2{gap:.5em}.gap-3{gap:.75em}.space-y-1>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(.25em*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.25em*var(--tw-space-y-reverse))}.space-y-2>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(.5em*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.5em*var(--tw-space-y-reverse))}.space-y-3>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(.75em*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.75em*var(--tw-space-y-reverse))}.space-y-6>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(1.5em*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(1.5em*var(--tw-space-y-reverse))}.divide-y>:not([hidden])~:not([hidden]){--tw-divide-y-reverse:0;border-top-width:calc(1px*(1 - var(--tw-divide-y-reverse)));border-bottom-width:calc(1px*var(--tw-divide-y-reverse))}.divide-zinc-100>:not([hidden])~:not([hidden]){--tw-divide-opacity:1;border-color:rgb(244 244 245/var(--tw-divide-opacity,1))}.overflow-auto{overflow:auto}.overflow-hidden{overflow:hidden}.overflow-x-auto{overflow-x:auto}.overflow-y-auto{overflow-y:auto}.truncate{overflow:hidden;text-overflow:ellipsis}.truncate,.whitespace-nowrap{white-space:nowrap}.whitespace-pre-wrap{white-space:pre-wrap}.break-words{overflow-wrap:break-word}.break-all{word-break:break-all}.rounded{border-radius:.25em}.rounded-2xl{border-radius:1em}.rounded-full{border-radius:9999px}.rounded-lg{border-radius:.5em}.rounded-md{border-radius:.375em}.rounded-xl{border-radius:.75em}.rounded-r-lg{border-top-right-radius:.5em;border-bottom-right-radius:.5em}.rounded-t-2xl{border-top-left-radius:1em;border-top-right-radius:1em}.border{border-width:1px}.border-b{border-bottom-width:1px}.border-b-2{border-bottom-width:2px}.border-l-4{border-left-width:4px}.border-t{border-top-width:1px}.border-dashed{border-style:dashed}.border-indigo-200{--tw-border-opacity:1;border-color:rgb(199 210 254/var(--tw-border-opacity,1))}.border-indigo-500{--tw-border-opacity:1;border-color:rgb(99 102 241/var(--tw-border-opacity,1))}.border-indigo-600{--tw-border-opacity:1;border-color:rgb(79 70 229/var(--tw-border-opacity,1))}.border-transparent{border-color:transparent}.border-zinc-100{--tw-border-opacity:1;border-color:rgb(244 244 245/var(--tw-border-opacity,1))}.border-zinc-200{--tw-border-opacity:1;border-color:rgb(228 228 231/var(--tw-border-opacity,1))}.border-zinc-300{--tw-border-opacity:1;border-color:rgb(212 212 216/var(--tw-border-opacity,1))}.bg-black{--tw-bg-opacity:1;background-color:rgb(0 0 0/var(--tw-bg-opacity,1))}.bg-black\\/30{background-color:rgba(0,0,0,.3)}.bg-black\\/40{background-color:rgba(0,0,0,.4)}.bg-emerald-600{--tw-bg-opacity:1;background-color:rgb(5 150 105/var(--tw-bg-opacity,1))}.bg-indigo-100{--tw-bg-opacity:1;background-color:rgb(224 231 255/var(--tw-bg-opacity,1))}.bg-indigo-50{--tw-bg-opacity:1;background-color:rgb(238 242 255/var(--tw-bg-opacity,1))}.bg-indigo-600{--tw-bg-opacity:1;background-color:rgb(79 70 229/var(--tw-bg-opacity,1))}.bg-indigo-900{--tw-bg-opacity:1;background-color:rgb(49 46 129/var(--tw-bg-opacity,1))}.bg-red-50{--tw-bg-opacity:1;background-color:rgb(254 242 242/var(--tw-bg-opacity,1))}.bg-red-600{--tw-bg-opacity:1;background-color:rgb(220 38 38/var(--tw-bg-opacity,1))}.bg-red-900{--tw-bg-opacity:1;background-color:rgb(127 29 29/var(--tw-bg-opacity,1))}.bg-transparent{background-color:transparent}.bg-white{--tw-bg-opacity:1;background-color:rgb(255 255 255/var(--tw-bg-opacity,1))}.bg-zinc-100{--tw-bg-opacity:1;background-color:rgb(244 244 245/var(--tw-bg-opacity,1))}.bg-zinc-200{--tw-bg-opacity:1;background-color:rgb(228 228 231/var(--tw-bg-opacity,1))}.bg-zinc-300{--tw-bg-opacity:1;background-color:rgb(212 212 216/var(--tw-bg-opacity,1))}.bg-zinc-50{--tw-bg-opacity:1;background-color:rgb(250 250 250/var(--tw-bg-opacity,1))}.bg-zinc-800{--tw-bg-opacity:1;background-color:rgb(39 39 42/var(--tw-bg-opacity,1))}.bg-zinc-900{--tw-bg-opacity:1;background-color:rgb(24 24 27/var(--tw-bg-opacity,1))}.object-cover{-o-object-fit:cover;object-fit:cover}.p-0{padding:0}.p-1{padding:.25em}.p-2{padding:.5em}.p-3{padding:.75em}.p-4{padding:1em}.p-8{padding:2em}.px-1{padding-left:.25em;padding-right:.25em}.px-1\\.5{padding-left:.375em;padding-right:.375em}.px-2{padding-left:.5em;padding-right:.5em}.px-3{padding-left:.75em;padding-right:.75em}.px-4{padding-left:1em;padding-right:1em}.py-0{padding-top:0;padding-bottom:0}.py-0\\.5{padding-top:.125em;padding-bottom:.125em}.py-1{padding-top:.25em;padding-bottom:.25em}.py-1\\.5{padding-top:.375em;padding-bottom:.375em}.py-2{padding-top:.5em;padding-bottom:.5em}.py-2\\.5{padding-top:.625em;padding-bottom:.625em}.py-3{padding-top:.75em;padding-bottom:.75em}.py-8{padding-top:2em;padding-bottom:2em}.pb-1{padding-bottom:.25em}.pb-2{padding-bottom:.5em}.pb-3{padding-bottom:.75em}.pl-3{padding-left:.75em}.pt-0{padding-top:0}.pt-0\\.5{padding-top:.125em}.pt-1{padding-top:.25em}.pt-2{padding-top:.5em}.pt-3{padding-top:.75em}.pt-4{padding-top:1em}.text-left{text-align:left}.text-center{text-align:center}.align-top{vertical-align:top}.font-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.text-\\[0\\.85em\\]{font-size:.85em}.text-\\[10px\\]{font-size:10px}.text-\\[11px\\]{font-size:11px}.text-base{font-size:16px;line-height:24px}.text-lg{font-size:18px;line-height:28px}.text-sm{font-size:14px;line-height:20px}.text-xl{font-size:20px;line-height:28px}.text-xs{font-size:12px;line-height:16px}.font-bold{font-weight:700}.font-medium{font-weight:500}.font-semibold{font-weight:600}.uppercase{text-transform:uppercase}.italic{font-style:italic}.leading-none{line-height:1}.leading-relaxed{line-height:1.625}.tracking-wide{letter-spacing:.025em}.tracking-wider{letter-spacing:.05em}.text-blue-600{--tw-text-opacity:1;color:rgb(37 99 235/var(--tw-text-opacity,1))}.text-emerald-600{--tw-text-opacity:1;color:rgb(5 150 105/var(--tw-text-opacity,1))}.text-indigo-600{--tw-text-opacity:1;color:rgb(79 70 229/var(--tw-text-opacity,1))}.text-indigo-700{--tw-text-opacity:1;color:rgb(67 56 202/var(--tw-text-opacity,1))}.text-inherit{color:inherit}.text-red-700{--tw-text-opacity:1;color:rgb(185 28 28/var(--tw-text-opacity,1))}.text-white{--tw-text-opacity:1;color:rgb(255 255 255/var(--tw-text-opacity,1))}.text-zinc-100{--tw-text-opacity:1;color:rgb(244 244 245/var(--tw-text-opacity,1))}.text-zinc-400{--tw-text-opacity:1;color:rgb(161 161 170/var(--tw-text-opacity,1))}.text-zinc-500{--tw-text-opacity:1;color:rgb(113 113 122/var(--tw-text-opacity,1))}.text-zinc-600{--tw-text-opacity:1;color:rgb(82 82 91/var(--tw-text-opacity,1))}.text-zinc-700{--tw-text-opacity:1;color:rgb(63 63 70/var(--tw-text-opacity,1))}.text-zinc-800{--tw-text-opacity:1;color:rgb(39 39 42/var(--tw-text-opacity,1))}.text-zinc-900{--tw-text-opacity:1;color:rgb(24 24 27/var(--tw-text-opacity,1))}.underline{text-decoration-line:underline}.antialiased{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}.opacity-80{opacity:.8}.shadow{--tw-shadow:0 1px 3px 0 rgba(0,0,0,.1),0 1px 2px -1px rgba(0,0,0,.1);--tw-shadow-colored:0 1px 3px 0 var(--tw-shadow-color),0 1px 2px -1px var(--tw-shadow-color)}.shadow,.shadow-2xl{box-shadow:var(--tw-ring-offset-shadow,0 0 #0000),var(--tw-ring-shadow,0 0 #0000),var(--tw-shadow)}.shadow-2xl{--tw-shadow:0 25px 50px -12px rgba(0,0,0,.25);--tw-shadow-colored:0 25px 50px -12px var(--tw-shadow-color)}.shadow-lg{--tw-shadow:0 10px 15px -3px rgba(0,0,0,.1),0 4px 6px -4px rgba(0,0,0,.1);--tw-shadow-colored:0 10px 15px -3px var(--tw-shadow-color),0 4px 6px -4px var(--tw-shadow-color)}.shadow-lg,.shadow-xl{box-shadow:var(--tw-ring-offset-shadow,0 0 #0000),var(--tw-ring-shadow,0 0 #0000),var(--tw-shadow)}.shadow-xl{--tw-shadow:0 20px 25px -5px rgba(0,0,0,.1),0 8px 10px -6px rgba(0,0,0,.1);--tw-shadow-colored:0 20px 25px -5px var(--tw-shadow-color),0 8px 10px -6px var(--tw-shadow-color)}.outline{outline-style:solid}.ring{--tw-ring-offset-shadow:var(--tw-ring-inset) 0 0 0 var(--tw-ring-offset-width) var(--tw-ring-offset-color);--tw-ring-shadow:var(--tw-ring-inset) 0 0 0 calc(3px + var(--tw-ring-offset-width)) var(--tw-ring-color);box-shadow:var(--tw-ring-offset-shadow),var(--tw-ring-shadow),var(--tw-shadow,0 0 #0000)}.blur{--tw-blur:blur(8px)}.blur,.filter{filter:var(--tw-blur) var(--tw-brightness) var(--tw-contrast) var(--tw-grayscale) var(--tw-hue-rotate) var(--tw-invert) var(--tw-saturate) var(--tw-sepia) var(--tw-drop-shadow)}.transition{transition-property:color,background-color,border-color,text-decoration-color,fill,stroke,opacity,box-shadow,transform,filter,-webkit-backdrop-filter;transition-property:color,background-color,border-color,text-decoration-color,fill,stroke,opacity,box-shadow,transform,filter,backdrop-filter;transition-property:color,background-color,border-color,text-decoration-color,fill,stroke,opacity,box-shadow,transform,filter,backdrop-filter,-webkit-backdrop-filter;transition-timing-function:cubic-bezier(.4,0,.2,1);transition-duration:.15s}.ease-out{transition-timing-function:cubic-bezier(0,0,.2,1)}.empty\\:hidden:empty{display:none}.hover\\:bg-indigo-50:hover{--tw-bg-opacity:1;background-color:rgb(238 242 255/var(--tw-bg-opacity,1))}.hover\\:bg-red-50:hover{--tw-bg-opacity:1;background-color:rgb(254 242 242/var(--tw-bg-opacity,1))}.hover\\:bg-zinc-100:hover{--tw-bg-opacity:1;background-color:rgb(244 244 245/var(--tw-bg-opacity,1))}.hover\\:bg-zinc-50:hover{--tw-bg-opacity:1;background-color:rgb(250 250 250/var(--tw-bg-opacity,1))}.hover\\:text-red-500:hover{--tw-text-opacity:1;color:rgb(239 68 68/var(--tw-text-opacity,1))}.hover\\:text-red-600:hover{--tw-text-opacity:1;color:rgb(220 38 38/var(--tw-text-opacity,1))}.hover\\:text-zinc-600:hover{--tw-text-opacity:1;color:rgb(82 82 91/var(--tw-text-opacity,1))}.hover\\:text-zinc-700:hover{--tw-text-opacity:1;color:rgb(63 63 70/var(--tw-text-opacity,1))}.hover\\:underline:hover{text-decoration-line:underline}.disabled\\:opacity-50:disabled{opacity:.5}.dark\\:divide-zinc-800:is(.dark *)>:not([hidden])~:not([hidden]){--tw-divide-opacity:1;border-color:rgb(39 39 42/var(--tw-divide-opacity,1))}.dark\\:border-indigo-800:is(.dark *){--tw-border-opacity:1;border-color:rgb(55 48 163/var(--tw-border-opacity,1))}.dark\\:border-zinc-600:is(.dark *){--tw-border-opacity:1;border-color:rgb(82 82 91/var(--tw-border-opacity,1))}.dark\\:border-zinc-700:is(.dark *){--tw-border-opacity:1;border-color:rgb(63 63 70/var(--tw-border-opacity,1))}.dark\\:border-zinc-800:is(.dark *){--tw-border-opacity:1;border-color:rgb(39 39 42/var(--tw-border-opacity,1))}.dark\\:bg-indigo-900:is(.dark *){--tw-bg-opacity:1;background-color:rgb(49 46 129/var(--tw-bg-opacity,1))}.dark\\:bg-indigo-900\\/30:is(.dark *){background-color:rgba(49,46,129,.3)}.dark\\:bg-indigo-900\\/40:is(.dark *){background-color:rgba(49,46,129,.4)}.dark\\:bg-red-900\\/30:is(.dark *){background-color:rgba(127,29,29,.3)}.dark\\:bg-zinc-600:is(.dark *){--tw-bg-opacity:1;background-color:rgb(82 82 91/var(--tw-bg-opacity,1))}.dark\\:bg-zinc-700:is(.dark *){--tw-bg-opacity:1;background-color:rgb(63 63 70/var(--tw-bg-opacity,1))}.dark\\:bg-zinc-800:is(.dark *){--tw-bg-opacity:1;background-color:rgb(39 39 42/var(--tw-bg-opacity,1))}.dark\\:bg-zinc-800\\/50:is(.dark *){background-color:rgba(39,39,42,.5)}.dark\\:bg-zinc-900:is(.dark *){--tw-bg-opacity:1;background-color:rgb(24 24 27/var(--tw-bg-opacity,1))}.dark\\:text-blue-400:is(.dark *){--tw-text-opacity:1;color:rgb(96 165 250/var(--tw-text-opacity,1))}.dark\\:text-indigo-200:is(.dark *){--tw-text-opacity:1;color:rgb(199 210 254/var(--tw-text-opacity,1))}.dark\\:text-indigo-300:is(.dark *){--tw-text-opacity:1;color:rgb(165 180 252/var(--tw-text-opacity,1))}.dark\\:text-indigo-400:is(.dark *){--tw-text-opacity:1;color:rgb(129 140 248/var(--tw-text-opacity,1))}.dark\\:text-red-300:is(.dark *){--tw-text-opacity:1;color:rgb(252 165 165/var(--tw-text-opacity,1))}.dark\\:text-zinc-100:is(.dark *){--tw-text-opacity:1;color:rgb(244 244 245/var(--tw-text-opacity,1))}.dark\\:text-zinc-200:is(.dark *){--tw-text-opacity:1;color:rgb(228 228 231/var(--tw-text-opacity,1))}.dark\\:text-zinc-300:is(.dark *){--tw-text-opacity:1;color:rgb(212 212 216/var(--tw-text-opacity,1))}.dark\\:text-zinc-400:is(.dark *){--tw-text-opacity:1;color:rgb(161 161 170/var(--tw-text-opacity,1))}.dark\\:text-zinc-500:is(.dark *){--tw-text-opacity:1;color:rgb(113 113 122/var(--tw-text-opacity,1))}.dark\\:hover\\:bg-indigo-900\\/40:hover:is(.dark *){background-color:rgba(49,46,129,.4)}.dark\\:hover\\:bg-red-900\\/30:hover:is(.dark *){background-color:rgba(127,29,29,.3)}.dark\\:hover\\:bg-zinc-700:hover:is(.dark *){--tw-bg-opacity:1;background-color:rgb(63 63 70/var(--tw-bg-opacity,1))}.dark\\:hover\\:bg-zinc-800:hover:is(.dark *){--tw-bg-opacity:1;background-color:rgb(39 39 42/var(--tw-bg-opacity,1))}.dark\\:hover\\:bg-zinc-800\\/50:hover:is(.dark *){background-color:rgba(39,39,42,.5)}.dark\\:hover\\:bg-zinc-800\\/60:hover:is(.dark *){background-color:rgba(39,39,42,.6)}.dark\\:hover\\:text-zinc-200:hover:is(.dark *){--tw-text-opacity:1;color:rgb(228 228 231/var(--tw-text-opacity,1))}@media (min-width:640px){.sm\\:mx-auto{margin-left:auto;margin-right:auto}.sm\\:my-4{margin-top:1em}.sm\\:mb-4,.sm\\:my-4{margin-bottom:1em}.sm\\:h-\\[calc\\(100dvh-2em\\)\\]{height:calc(100dvh - 2em)}.sm\\:max-w-4xl{max-width:56em}.sm\\:max-w-5xl{max-width:64em}.sm\\:max-w-6xl{max-width:72em}.sm\\:items-stretch{align-items:stretch}.sm\\:rounded-2xl{border-radius:1em}}`;
  /* @TAILWIND_CSS_END */

  const BASE_CSS = `
/* AI Chat Overlay — shadow-root base */
/* Shadow DOM already isolates styles. The only inherited properties that
   still cross the shadow boundary are the usual CSS inherited ones (color,
   font-*, line-height, etc.), so we pin those on :host to defeat host-page
   inheritance without needing !important everywhere. */
:host {
  all: initial;
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483000;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  /* Pin the overlay's root font-size so host pages that override the
     default html font-size (\`html { font-size: 10px !important }\` is a
     common CSS-reset pattern) don't shrink the UI via rem / em cascades.
     Tailwind's text-* utilities use absolute px values (see
     build/tailwind.config.cjs), so those are independently immune; this
     pin anchors em-based spacing/border-radius and the inherited default
     for elements without a text-* utility. */
  font-size: 16px;
  line-height: 1.5;
  color: rgb(24, 24, 27);
  -webkit-tap-highlight-color: transparent;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.aicx-stage {
  position: absolute;
  inset: 0;
  pointer-events: none;
  color: inherit;
}
.dark { color: rgb(228, 228, 231); }
*, *::before, *::after {
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
button, input:not([type="checkbox"]):not([type="radio"]), textarea, select {
  font: inherit; color: inherit; background-color: transparent;
  appearance: none; -webkit-appearance: none; outline: none;
}
input:not([type="checkbox"]):not([type="radio"]), textarea, select {
  border-radius: 8px; padding: 8px 10px;
}
/* Prevent iOS Safari auto-zoom on focus: font-size must be >= 16px on touch
   devices. \`!important\` is required, not optional — the composer textarea and
   the settings inputs carry Tailwind's \`.text-sm\` utility (14px), whose class
   selector (0,1,0) outranks the bare \`textarea\`/\`select\` selectors (0,0,1)
   here. Without \`!important\` the 14px utility wins and Safari zooms on focus,
   trapping the user zoomed-in until they manually pinch back out. The rule is
   semantically a hard floor ("touch form controls are never < 16px"), so
   overriding any smaller utility is the intended behaviour. */
@media (hover: none) and (pointer: coarse) {
  input:not([type="checkbox"]):not([type="radio"]), textarea, select {
    font-size: 16px !important;
  }
}
button { cursor: pointer; touch-action: manipulation; }
img { max-width: 100%; height: auto; display: block; }
svg { display: inline-block; vertical-align: middle; }
textarea { resize: none; }
/* Functional helpers (not intended to be overridden by Tailwind) */
[data-active="true"] { pointer-events: auto; }
.aicx-panel { pointer-events: auto; }
.aicx-scroll { -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
.aicx-tap { touch-action: manipulation; user-select: none; -webkit-user-select: none; }
.aicx-full { height: 100dvh; max-height: 100dvh; }
.aicx-resize { touch-action: none; cursor: ns-resize; user-select: none; -webkit-user-select: none; }
@keyframes aicx-slide-up { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
@keyframes aicx-fade-in { from { opacity: 0; } to { opacity: 1; } }
.aicx-enter-sheet { animation: aicx-slide-up 180ms ease-out both; }
.aicx-enter-fade { animation: aicx-fade-in 160ms ease-out both; }
@keyframes aicx-dot { 0%, 80%, 100% { opacity: .2; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
.aicx-dot { display:inline-block; width:6px; height:6px; margin:0 2px; background-color: currentColor; border-radius:50%; animation: aicx-dot 1.2s infinite; }
.aicx-dot:nth-child(2) { animation-delay: .15s; }
.aicx-dot:nth-child(3) { animation-delay: .3s; }

/* Floating action button — hand-written so appearance does not depend on
   Tailwind utilities resolving. */
.aicx-fab-btn {
  display: flex;
  position: relative; /* anchors the .aicx-busy ring below */
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 9999px;
  box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
  background-image: linear-gradient(to bottom right, rgb(99 102 241), rgb(124 58 237));
  color: rgb(255 255 255);
  transition: transform 150ms ease;
  cursor: pointer;
  border: 0;
  padding: 0;
}
.aicx-fab-btn:active { transform: scale(0.95); }
/* Generation in flight somewhere. Since a run now outlives the chat sheet,
   this ring is the only signal that work is still happening after the user
   closes the panel. Drawn as a pseudo-element ring rather than an animated
   box-shadow so the button's own shadow survives. */
@keyframes aicx-ring { 0% { transform: scale(1); opacity: .75; } 100% { transform: scale(1.4); opacity: 0; } }
.aicx-fab-btn.aicx-busy::after {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 9999px;
  border: 2px solid rgb(129 140 248);
  animation: aicx-ring 1.4s ease-out infinite;
  pointer-events: none;
}
/* Icon container: absolute px (no em) so the icon size is independent of
   inherited font-size. Without this, the default \`w-5 h-5\` span wrapped
   around the SVG resolves to 1.25em × inherited font-size — on hosts that
   compress the cascade (yahoo.co.jp, sites using \`html{font-size:62.5%}\`,
   viewport-unit-based root font-size, text-size-adjust, etc.) the icon
   visibly shrinks. \`flex-shrink:0\` prevents shrinkage in the FAB's flex
   layout; the inner SVG has \`width="100%" height="100%"\` attributes so
   it fills the container. */
.aicx-fab-btn .aicx-fab-icon {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.aicx-fab-btn .aicx-fab-icon svg { width: 100%; height: 100%; }
`;

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
      link:    '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
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
      download:'<path d="M12 3v12m0 0 4-4m-4 4-4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
      wrench:  '<path d="M20 5.5a5 5 0 0 1-6.6 6.6L6.3 19.2a2 2 0 0 1-2.8-2.8l7.1-7.1A5 5 0 0 1 17.2 2.7l-3 3 2.1 2.1 3-3c.4.5.7 1.1.7 1.7Z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/>',
      play:    '<path d="M8 5.5v13l11-6.5-11-6.5Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
      upload:  '<path d="M12 21V9m0 0 4 4m-4-4-4 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
      warn:    '<path d="M12 3.5 22 20H2L12 3.5Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><path d="M12 10v4M12 17v.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    };
    const svg = el('span', { class: 'inline-flex items-center justify-center ' + cls });
    svg.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
    return svg;
  };

  // =========================================================================
  // 11. UI: root container + notifications
  // =========================================================================
  const UI = {
    hostEl: null,   // light-DOM shadow host (#aicx-root)
    shadow: null,   // attached shadow root — every overlay element lives here
    root: null,     // .aicx-stage inside shadow — where `.dark` is toggled and children mount
    toastHost: null,
    _twPromise: null,
    init() {
      const hostEl = el('div', { id: 'aicx-root' });
      (document.body || document.documentElement).appendChild(hostEl);
      // Open mode on purpose: `composedPath()` invoked from light-DOM
      // listeners (document-level outside-click handlers, focus guard, etc.)
      // only returns the full shadow-internal path for OPEN shadow roots.
      // With a closed root the path is truncated at the shadow host, which
      // breaks every `eventPathIncludes(menuEl, e)` check — clicks inside
      // the overlay look identical to clicks outside, so popovers close the
      // instant the user clicks a menu item. Style isolation comes from the
      // shadow boundary itself, not from `closed` mode; leaving it open has
      // no effect on leak protection.
      const shadow = hostEl.attachShadow({ mode: 'open' });
      const baseStyle = document.createElement('style');
      baseStyle.textContent = BASE_CSS;
      shadow.appendChild(baseStyle);
      // TAILWIND_CSS injection is deferred to the first FAB click — see
      // `UI.ensureTailwindLoaded()` and `OverlayButton.toggleMenu()`. The
      // FAB itself renders from hand-written `.aicx-fab-btn` rules in
      // BASE_CSS above, so it is fully styled before Tailwind loads; pages
      // the user never engages with pay no cost for the large utility sheet.
      const stage = el('div', { class: 'aicx-stage' });
      shadow.appendChild(stage);
      this.hostEl = hostEl;
      this.shadow = shadow;
      this.root = stage;
      // Toast host uses Tailwind utilities, but no toast is emitted until
      // the user interacts with an overlay panel — by which time Tailwind
      // has already been injected via ensureTailwindLoaded().
      this.toastHost = el('div', { class: 'fixed bottom-4 left-1/2 -translate-x-1/2 flex flex-col gap-2 items-center pointer-events-none', style: { zIndex: 20 } });
      stage.appendChild(this.toastHost);
      Theme.install(stage);
    },
    // Lazily inject the precompiled Tailwind stylesheet on first demand.
    // Runs in a microtask so the click handler returns promptly; the menu
    // opens immediately after the returned promise resolves, so its first
    // frame already has utilities applied (no flash of unstyled content).
    ensureTailwindLoaded() {
      if (this._twPromise) return this._twPromise;
      this._twPromise = new Promise((resolve) => {
        queueMicrotask(() => {
          const twStyle = document.createElement('style');
          twStyle.textContent = TAILWIND_CSS;
          this.shadow.appendChild(twStyle);
          resolve();
        });
      });
      return this._twPromise;
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
    },

    // Centred modal skeleton shared by the dialogs below. Returns
    // { overlay, box, body, footer, close } with the title already mounted;
    // callers fill `body` / `footer` and call `close()` to dismiss.
    modal({ title, iconName, maxWidth = 'max-w-2xl', onDismiss }) {
      const overlay = el('div', { class: 'fixed inset-0 bg-black/40 aicx-panel aicx-enter-fade flex items-center justify-center p-4', style: { zIndex: 50 } });
      const box = el('div', { class: `bg-white dark:bg-zinc-900 rounded-2xl shadow-xl ${maxWidth} w-full max-h-[85dvh] flex flex-col overflow-hidden aicx-enter-sheet` });
      const header = el('div', { class: 'shrink-0 flex items-center gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800' });
      if (iconName) header.append(el('span', { class: 'shrink-0 text-indigo-600 dark:text-indigo-300' }, [icon(iconName, 'w-5 h-5')]));
      header.append(el('div', { class: 'flex-1 text-sm font-semibold truncate text-zinc-900 dark:text-zinc-100' }, title));
      const body = el('div', { class: 'flex-1 aicx-scroll overflow-y-auto p-4 space-y-3' });
      const footer = el('div', { class: 'shrink-0 flex flex-wrap justify-end gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-800' });
      const close = () => overlay.remove();
      const closeBtn = el('button', { class: 'w-8 h-8 shrink-0 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center aicx-tap text-zinc-500', 'aria-label': '閉じる', type: 'button' });
      closeBtn.appendChild(icon('close', 'w-4 h-4'));
      closeBtn.addEventListener('click', () => { close(); if (onDismiss) onDismiss(); });
      header.append(closeBtn);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { close(); if (onDismiss) onDismiss(); } });
      box.append(header, body, footer);
      overlay.appendChild(box);
      this.root.appendChild(overlay);
      return { overlay, box, body, footer, close };
    },

    // Multi-line text prompt. Resolves with the entered string, or null when
    // the user dismisses. `allowFile` adds a "read from file" button that
    // loads a local file's text into the textarea.
    promptText({ title, description, placeholder, initial, okLabel = 'OK', allowFile = false, iconName = 'edit' }) {
      return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; resolve(v); };
        const { body, footer, close } = this.modal({ title, iconName, onDismiss: () => done(null) });
        if (description) body.append(el('p', { class: 'text-xs text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap' }, description));
        const ta = el('textarea', {
          class: 'w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs font-mono px-3 py-2 h-64',
          rows: '14',
          placeholder: placeholder || ''
        });
        ta.value = initial || '';
        body.append(ta);
        if (allowFile) {
          const fileInput = el('input', { type: 'file', accept: '.js,.user.js,text/javascript,application/javascript,text/plain', class: 'hidden' });
          fileInput.addEventListener('change', async () => {
            const f = fileInput.files && fileInput.files[0];
            if (!f) return;
            try { ta.value = await f.text(); } catch (e) { this.toast('ファイルを読み込めませんでした', 'error'); }
          });
          const pick = el('button', { class: 'text-xs px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 aicx-tap inline-flex items-center gap-1', type: 'button' });
          pick.append(icon('upload', 'w-3.5 h-3.5'), el('span', {}, 'ファイルから読み込み'));
          pick.addEventListener('click', () => fileInput.click());
          body.append(el('div', { class: 'flex gap-2' }, [pick, fileInput]));
        }
        const cancel = el('button', { class: 'px-4 py-2 rounded-lg text-sm bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 aicx-tap', type: 'button' }, 'キャンセル');
        cancel.addEventListener('click', () => { close(); done(null); });
        const ok = el('button', { class: 'px-4 py-2 rounded-lg text-sm bg-indigo-600 text-white aicx-tap', type: 'button' }, okLabel);
        ok.addEventListener('click', () => { close(); done(ta.value); });
        footer.append(cancel, ok);
        setTimeout(() => ta.focus(), 50);
      });
    },

    // Presents a numbered list of options and resolves with what the user
    // picked: { cancelled } or { selected: [{ index, label, freeText }] }.
    //
    // `multiple` switches radio semantics for checkbox semantics. An option
    // with `allowFreeText` renders an extra input, so the model can offer
    // "その他 (自由入力)" style choices without a separate round trip; the
    // input is only enabled while that option is selected, and for a
    // free-text option that the user selected but left blank we still return
    // the label so the answer is never silently empty.
    chooseOptions({ question, description, multiple, options }) {
      return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; resolve(v); };
        const { body, footer, close } = this.modal({
          title: '選択してください',
          iconName: 'list',
          onDismiss: () => done({ cancelled: true })
        });

        body.append(el('p', { class: 'text-sm font-medium text-zinc-900 dark:text-zinc-100 whitespace-pre-wrap' }, question));
        if (description) body.append(el('p', { class: 'text-xs text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap' }, description));
        body.append(el('p', { class: 'text-[11px] text-zinc-500' }, multiple ? '複数選択できます。' : '1 つ選んでください。'));

        const name = 'aicx-choice-' + uid();
        const rows = [];
        const list = el('div', { class: 'space-y-2' });
        options.forEach((opt, i) => {
          const row = el('label', {
            class: 'flex items-start gap-2 p-2 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer'
          });
          const input = el('input', { type: multiple ? 'checkbox' : 'radio', class: 'w-4 h-4 mt-0.5 shrink-0' });
          if (!multiple) input.name = name;
          const col = el('div', { class: 'flex-1 min-w-0 space-y-1' });
          col.append(el('div', { class: 'text-xs text-zinc-800 dark:text-zinc-100 break-words' }, `${i + 1}. ${opt.label}`));
          if (opt.description) col.append(el('div', { class: 'text-[11px] text-zinc-500 dark:text-zinc-400 break-words' }, opt.description));
          let free = null;
          if (opt.allowFreeText) {
            free = el('input', {
              type: 'text',
              class: 'w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs px-2 py-1',
              placeholder: opt.freeTextPlaceholder || '自由入力'
            });
            free.disabled = true;
            // Clicking into the field should also pick the option it belongs
            // to, otherwise typing first and selecting second feels broken.
            free.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
            col.append(free);
          }
          row.append(input, col);
          const sync = () => {
            for (const r of rows) if (r.free) r.free.disabled = !r.input.checked;
            const mine = rows.find((r) => r.input === input);
            if (mine && mine.free && input.checked) mine.free.focus();
          };
          input.addEventListener('change', sync);
          rows.push({ input, free, opt, index: i + 1 });
          list.append(row);
        });
        body.append(list);

        const cancel = el('button', { class: 'px-4 py-2 rounded-lg text-sm bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 aicx-tap', type: 'button' }, 'キャンセル');
        cancel.addEventListener('click', () => { close(); done({ cancelled: true }); });
        const ok = el('button', { class: 'px-4 py-2 rounded-lg text-sm bg-indigo-600 text-white aicx-tap', type: 'button' }, '決定');
        ok.addEventListener('click', () => {
          const selected = rows.filter((r) => r.input.checked).map((r) => ({
            index: r.index,
            label: r.opt.label,
            freeText: r.free ? r.free.value.trim() : ''
          }));
          if (!selected.length) { this.toast('選択肢を選んでください', 'error'); return; }
          close();
          done({ selected });
        });
        footer.append(cancel, ok);
      });
    },

    // Approval dialog for model-authored code we are about to execute in the
    // page. Resolves { ok, always } — `always` opts the caller into skipping
    // this dialog for the rest of the conversation.
    confirmCode({ title, description, code, okLabel = '実行', rememberLabel = null }) {
      return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; resolve(v); };
        const { body, footer, close } = this.modal({ title, iconName: 'warn', onDismiss: () => done({ ok: false, always: false }) });
        if (description) body.append(el('p', { class: 'text-xs text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap' }, description));
        body.append(el('pre', {
          class: 'whitespace-pre-wrap break-words text-[11px] font-mono bg-zinc-900 text-zinc-100 rounded-lg p-3 max-h-64 overflow-auto'
        }, code || ''));
        let always = false;
        if (rememberLabel) {
          const wrap = el('label', { class: 'flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300 cursor-pointer' });
          const chk = el('input', { type: 'checkbox', class: 'w-4 h-4' });
          chk.addEventListener('change', () => { always = chk.checked; });
          wrap.append(chk, el('span', {}, rememberLabel));
          body.append(wrap);
        }
        const cancel = el('button', { class: 'px-4 py-2 rounded-lg text-sm bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 aicx-tap', type: 'button' }, '拒否');
        cancel.addEventListener('click', () => { close(); done({ ok: false, always: false }); });
        const ok = el('button', { class: 'px-4 py-2 rounded-lg text-sm bg-indigo-600 text-white aicx-tap', type: 'button' }, okLabel);
        ok.addEventListener('click', () => { close(); done({ ok: true, always }); });
        footer.append(cancel, ok);
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
      // FAB uses the hand-written `.aicx-fab-btn` rule in BASE_CSS so its
      // appearance does not depend on Tailwind utilities being present.
      this.host = el('div', { id: 'aicx-fab', class: 'aicx-panel aicx-tap', style: { position: 'fixed', zIndex: 10, touchAction: 'none' } });
      this.btn = el('button', {
        class: 'aicx-fab-btn',
        type: 'button',
        'aria-label': 'AI チャットを開く'
      });
      // `aicx-fab-icon` (see BASE_CSS) gives the icon container a hard 28px
      // size in px, immune to the host page's font-size cascade. Do NOT
      // fall back to the default `w-5 h-5` — those utilities are em-based
      // and can shrink on pages that tighten the cascade.
      this.btn.appendChild(icon('chat', 'aicx-fab-icon'));
      this.host.appendChild(this.btn);
      UI.root.appendChild(this.host);
      this.applyPosition();
      this.bindDrag();
      // Keep the busy ring in sync with the registry for the page's lifetime.
      Runs.subscribe(() => this.paintBusy());
      this.paintBusy();
      // Click listener on HOST (not btn): setPointerCapture on host causes the
      // click event to target the host itself, so a listener on btn never fires.
      this.host.addEventListener('click', (e) => {
        if (this.suppressClick) { this.suppressClick = false; return; }
        e.preventDefault();
        this.toggleMenu();
      });
      window.addEventListener('resize', () => this.applyPosition());
    },
    paintBusy() {
      if (!this.btn) return;
      const busy = Runs.count() > 0;
      this.btn.classList.toggle('aicx-busy', busy);
      this.btn.setAttribute('aria-label', busy ? 'AI チャットを開く (生成中)' : 'AI チャットを開く');
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
    async toggleMenu() {
      if (this.menuEl) { this.closeMenu(); return; }
      // Defer raw-doc prefetch to the first interaction so pages the user
      // never engages with pay zero runtime cost.
      try { Page.primeRawDoc(); } catch {}
      // Kick off the lazy library fetch too — fire-and-forget so it runs in
      // parallel with the Tailwind inject and raw-doc prefetch. Consumers
      // (ChatPanel.open / Page.snapshot) await LazyLibs.load() when they
      // need the globals, so it's fine if loading is still in flight here.
      try { LazyLibs.load(); } catch {}
      // Defer the precompiled Tailwind stylesheet to the first click too —
      // start it before the await so it runs in parallel with primeRawDoc.
      await UI.ensureTailwindLoaded();
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
        b.append(icon(iconName, 'w-5 h-5 text-zinc-500'), el('span', { class: 'flex-1 truncate' }, label));
        b.addEventListener('click', () => { this.closeMenu(); onClick(); });
        return b;
      };

      // Header
      const header = el('div', { class: 'px-4 pt-3 pb-2 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400' }, host);
      menu.appendChild(header);

      menu.appendChild(row('plus', '新規 AI チャット', () => ChatPanel.open({ newChat: true })));
      menu.appendChild(row('code', '新規 UserScript', () => ChatPanel.open({ newChat: true, mode: UserScriptMode.ID })));
      menu.appendChild(row('history', '会話履歴', () => HistoryPanel.open()));

      // Recent section
      if (recent.length) {
        menu.appendChild(el('div', { class: 'px-4 pt-2 pb-1 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400' }, '最近の会話'));
        recent.forEach((c) => {
          const firstUser = c.messages.find((m) => m.role === 'user' && !m._synthetic);
          const label = c.title || (firstUser && (firstUser.content || '').slice(0, 40)) || '(新規会話)';
          menu.appendChild(row(c.mode === UserScriptMode.ID ? 'code' : 'chat', label, () => ChatPanel.open({ conversationId: c.id })));
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
          b.addEventListener('click', () => { this.closeMenu(); ChatPanel.open({ newChat: true, initialPrompt: t.prompt || '', autoSend: true, webSearch: !!t.webSearch, urlContext: !!t.urlContext }); });
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
          if (!eventPathIncludes(menu, e) && !eventPathIncludes(this.host, e)) {
            document.removeEventListener('pointerdown', onDoc, true);
            this.closeMenu();
          }
        };
        document.addEventListener('pointerdown', onDoc, true);
      }, 0);
    }
  };

  // =========================================================================
  // 12.5 UserScript authoring mode
  // =========================================================================
  //
  // A chat started from the FAB menu's "新規 UserScript" entry runs in this
  // mode. It differs from a normal chat in three ways:
  //
  //   1. A dedicated system prompt (overridable in Settings → プロンプト).
  //   2. Gemini function-calling tools that let the model inspect the live
  //      page, fetch its assets, run verification snippets, ask the user for
  //      an existing script, and finally emit an installable userscript.
  //   3. Page-context auto-injection is off by default — the model pulls
  //      exactly the parts of the page it needs through the tools instead of
  //      being handed a large text dump up front.
  //
  // Every tool that touches the outside world or executes code is either
  // read-only against the current document, or gated behind an explicit user
  // confirmation (`run_snippet`, `request_existing_userscript`). `fetch_resource`
  // relies on the userscript manager's own @connect prompt for cross-origin
  // hosts, which is the user's per-domain gate.
  const UserScriptMode = {
    ID: 'userscript',
    // Cap on model→tool→model round trips within a single send(), so a
    // confused model can't loop forever burning quota. Non-trivial scripts
    // routinely need a dozen-plus inspect/verify cycles, so the default is
    // generous; `maxToolRounds()` resolves the user's override.
    DEFAULT_MAX_TOOL_ROUNDS: 50,
    // Guard rails for the user-supplied override. The ceiling is not a
    // safety limit (the user can always send again) — it just keeps a typo
    // like "5000" from silently committing to an enormous run.
    MIN_TOOL_ROUNDS: 1,
    MAX_TOOL_ROUNDS_CAP: 200,
    HTML_MAX_DEFAULT: 24000,
    HTML_MAX_CAP: 100000,
    FETCH_MAX_DEFAULT: 40000,
    FETCH_MAX_CAP: 160000,
    // Snippets run as async functions, so genuinely slow work (waiting on a
    // late-rendered element, a fetch the page makes) is expected — hence a
    // budget well above what a synchronous DOM probe needs.
    SNIPPET_TIMEOUT_MS: 15000,
    // Conversation ids for which the user ticked "don't ask again" on the
    // run_snippet approval dialog. Deliberately in-memory only: the opt-out
    // lasts for the session, never persists to storage.
    _autoRunConvIds: new Set(),

    DEFAULT_SYSTEM_PROMPT: `あなたは Tampermonkey 向け UserScript を作成する熟練のフロントエンドエンジニアです。ユーザーが今開いている Web ページを対象に、対話しながらスクリプトを設計・実装します。

## 進め方
1. 要件が曖昧なときや実現方法が複数あるときは、推測で進めずに ask_user_choice で選択肢を提示して確認する。単純な確認はチャットで質問してもよい。
2. セレクタや DOM 構造を推測しない。必ずツールで実際のページを確認する。
   - まず get_page_info でページ概要・読み込み済みリソース・推奨 @match を取得する。
   - 対象要素は query_selector で存在と構造を確かめる。広い範囲の構造を見たいときだけ get_page_html を使う。
   - ページ側のスクリプトやスタイルの実装を知りたいときは fetch_resource で取得する。
   - 挙動や値を確認したいときは run_snippet を使う（実行前にユーザーの承認が必要）。
3. 既存スクリプトの修正依頼なら、まず request_existing_userscript で現行コードを受け取る。
4. 完成したコードは必ず output_userscript ツールで出力する。チャット本文にスクリプト全文を貼らない。
5. output_userscript の後は、何をするスクリプトか・使い方・注意点を数行で説明する。修正版を出すときも毎回 output_userscript を呼び直す。

## コーディング規約
- 完全な ==UserScript== メタデータブロックを含める（@name, @namespace, @version, @description, @author, @match, @run-at, @grant）。
- メタデータブロックは 1 行目の \`// ==UserScript==\` で始め、\`// ==/UserScript==\` で閉じる。閉じ行の \`==\` の後のスラッシュを絶対に落とさないこと（\`// ==UserScript==\` で閉じると Tampermonkey がインストールに失敗する）。
- @match は必要最小限のスコープにする。サイト全体が対象でないならパス単位で絞る。
- 使用する GM_* API はすべて @grant に列挙する。何も使わないなら @grant none と明記する。
- 全体を (function(){ 'use strict'; ... })(); で囲み、グローバルを汚さない。
- 対象要素が遅れて描画される場合や SPA の画面遷移に備え、MutationObserver や待機処理を入れる。
- 既存ページの挙動を壊さない。多重実行ガードを入れる。
- コメントは日本語で簡潔に、処理の意図がわかる程度に留める。

回答はユーザーと同じ言語（基本は日本語）で行うこと。`,

    // ---------------------------------------------------------------------
    // Prompt assembly
    // ---------------------------------------------------------------------
    suggestedMatches() {
      try {
        const u = new URL(location.href);
        const out = [`${u.protocol}//${u.hostname}/*`];
        const dir = u.pathname.replace(/[^/]*$/, '');
        if (dir && dir !== '/') out.push(`${u.protocol}//${u.hostname}${dir}*`);
        return out;
      } catch { return ['*://*/*']; }
    },

    // Resolved round limit: the user's setting, clamped into range. Anything
    // unparseable (empty field, stray text, a value from an older build)
    // falls back to the default rather than disabling the loop.
    maxToolRounds() {
      const n = parseInt(Store.settings.userscriptMaxToolRounds, 10);
      if (!Number.isFinite(n) || n < this.MIN_TOOL_ROUNDS) return this.DEFAULT_MAX_TOOL_ROUNDS;
      return Math.min(n, this.MAX_TOOL_ROUNDS_CAP);
    },

    systemPrompt() {
      const custom = Store.settings.userscriptSystemPrompt;
      const base = (custom && custom.trim()) || this.DEFAULT_SYSTEM_PROMPT;
      const facts = [
        '## 対象ページ (ツール実行時点)',
        `URL: ${location.href}`,
        `Title: ${document.title || '(なし)'}`,
        `推奨 @match: ${this.suggestedMatches().join(' / ')}`
      ].join('\n');
      return `${base}\n\n${facts}`;
    },

    // ---------------------------------------------------------------------
    // Tool declarations (Gemini functionDeclarations schema)
    // ---------------------------------------------------------------------
    toolDeclarations() {
      const S = (description) => ({ type: 'STRING', description });
      const N = (description) => ({ type: 'INTEGER', description });
      return [
        {
          name: 'get_page_info',
          description: 'ユーザーが現在開いているページの概要を取得する。URL・タイトル・meta 情報・読み込まれている script/stylesheet の URL 一覧・検出したフレームワーク・推奨 @match を返す。UserScript 作成時は最初にこれを呼ぶこと。'
        },
        {
          name: 'query_selector',
          description: 'CSS セレクタでページ内の要素を検索し、一致数と各要素の outerHTML・テキスト・表示状態を返す。セレクタの妥当性確認や対象要素の構造把握に使う。get_page_html より軽いので優先して使うこと。',
          parameters: {
            type: 'OBJECT',
            properties: {
              selector: S('検索する CSS セレクタ。'),
              limit: N('返す要素の最大数。既定 5、最大 20。'),
              max_chars_per_match: N('各要素の outerHTML の最大文字数。既定 2000。')
            },
            required: ['selector']
          }
        },
        {
          name: 'get_page_html',
          description: '現在のページの HTML を取得する。class / id / data-* 属性は保持されるのでセレクタ設計に使える。inline script / style / svg の中身と巨大な data URI は省略される。セレクタを指定するとその要素のみを返す。',
          parameters: {
            type: 'OBJECT',
            properties: {
              selector: S('対象を絞る CSS セレクタ。省略時は <body> 全体。'),
              include_head: { type: 'BOOLEAN', description: 'true なら <html> 全体 (head を含む) を返す。selector 指定時は無視される。既定 false。' },
              max_chars: N(`返す HTML の最大文字数。既定 ${this.HTML_MAX_DEFAULT}、最大 ${this.HTML_MAX_CAP}。`)
            }
          }
        },
        {
          name: 'fetch_resource',
          description: 'URL を指定してリソース (.js / .css / .json / .html など) の中身を取得する。相対 URL は現在のページ基準で解決される。ページ側の実装を読んでフックすべき関数やクラス名を調べるのに使う。',
          parameters: {
            type: 'OBJECT',
            properties: {
              url: S('取得する URL。http/https または現在のページからの相対パス。'),
              max_chars: N(`返す本文の最大文字数。既定 ${this.FETCH_MAX_DEFAULT}、最大 ${this.FETCH_MAX_CAP}。`)
            },
            required: ['url']
          }
        },
        {
          name: 'run_snippet',
          description: `ページ上で JavaScript を実行し、その戻り値を受け取る。セレクタの一致確認、ページ内グローバル変数や DOM の値の調査、挙動の検証に使う。コードは async 関数の本体として評価されるので、await をそのまま使え、結果は return すること (最大 ${Math.round(this.SNIPPET_TIMEOUT_MS / 1000)} 秒)。実行前にユーザーの承認ダイアログが表示され、拒否される場合がある。副作用のある操作や破壊的な操作には使わないこと。`,
          parameters: {
            type: 'OBJECT',
            properties: {
              code: S('実行する JavaScript。async 関数の本体として評価されるので `await` を直接使える。`return` で値を返すこと。Promise を返した場合も解決を待つ。'),
              purpose: S('何を確認するためのコードかの短い説明。ユーザーの承認ダイアログに表示される。')
            },
            required: ['code', 'purpose']
          }
        },
        {
          name: 'ask_user_choice',
          description: '実現方法が複数考えられるときや、実装に必要な情報が足りないときに、ユーザーに選択肢を提示して選んでもらう。推測で進めずにこのツールで確認すること。長い質問文をチャットに書いて待つ代わりに使う。ユーザーはキャンセルすることもできる。',
          parameters: {
            type: 'OBJECT',
            properties: {
              question: S('ユーザーに尋ねる質問。1 文で簡潔に。'),
              description: S('補足説明。判断材料があれば書く。省略可。'),
              multiple: { type: 'BOOLEAN', description: 'true なら複数選択、false または省略なら択一。' },
              options: {
                type: 'ARRAY',
                description: '選択肢。2〜8 個程度。表示時に 1 から通し番号が振られる。',
                items: {
                  type: 'OBJECT',
                  properties: {
                    label: S('選択肢のテキスト。'),
                    description: S('この選択肢の補足・トレードオフ。省略可。'),
                    allow_free_text: { type: 'BOOLEAN', description: 'true にすると、この選択肢にユーザーが自由入力するテキスト欄が付く。「その他」「上記以外の条件を指定」などに使う。' },
                    free_text_placeholder: S('自由入力欄のプレースホルダ。省略可。')
                  },
                  required: ['label']
                }
              }
            },
            required: ['question', 'options']
          }
        },
        {
          name: 'request_existing_userscript',
          description: '既存の UserScript を修正する場合に、ユーザーに現在のコードの入力を求める。モーダルが開き、ユーザーが貼り付けたコードが返る。修正依頼を受けたら最初にこれを呼ぶこと。',
          parameters: {
            type: 'OBJECT',
            properties: {
              reason: S('なぜ既存コードが必要かの短い説明。ユーザーに表示される。')
            }
          }
        },
        {
          name: 'output_userscript',
          description: '完成した UserScript をユーザーに提示する。チャット内にインストールカードが表示され、ユーザーは Tampermonkey にインストールできる。code には ==UserScript== メタデータブロックを含む完全なスクリプトを渡すこと。スクリプトを提示するときは必ずこのツールを使い、チャット本文にコード全文を書かないこと。',
          parameters: {
            type: 'OBJECT',
            properties: {
              code: S('==UserScript== メタデータブロックを含む完全な UserScript のソースコード。'),
              name: S('スクリプト名。省略時はメタデータの @name から取得する。'),
              summary: S('このスクリプトが何をするかの 1〜2 行の説明。')
            },
            required: ['code']
          }
        }
      ];
    },

    // ---------------------------------------------------------------------
    // Dispatch
    // ---------------------------------------------------------------------
    // Returns the JSON-serialisable object sent back as the functionResponse.
    // Never throws: tool failures are reported to the model as `{ error }` so
    // it can recover (fix a selector, pick a different URL, ...) instead of
    // the whole turn dying.
    async execute(call, ctx) {
      const args = (call && call.args) || {};
      try {
        switch (call.name) {
          case 'get_page_info':               return this.toolPageInfo();
          case 'query_selector':              return this.toolQuerySelector(args);
          case 'get_page_html':               return this.toolPageHtml(args);
          case 'fetch_resource':              return await this.toolFetchResource(args);
          case 'run_snippet':                 return await this.toolRunSnippet(args, ctx);
          case 'ask_user_choice':             return await this.toolAskUserChoice(args);
          case 'request_existing_userscript': return await this.toolRequestExisting(args);
          case 'output_userscript':           return this.toolOutputUserscript(args);
          default:
            return { error: `未知のツールです: ${call.name}` };
        }
      } catch (e) {
        return { error: (e && e.message) || String(e) };
      }
    },

    // Short human-readable label for a tool call, used on the chat pill.
    describeCall(call) {
      const a = (call && call.args) || {};
      switch (call.name) {
        case 'get_page_info':               return 'ページ情報を取得';
        case 'query_selector':              return `セレクタを検索: ${a.selector || ''}`;
        case 'get_page_html':               return a.selector ? `HTML を取得: ${a.selector}` : 'ページ HTML を取得';
        case 'fetch_resource':              return `リソースを取得: ${a.url || ''}`;
        case 'run_snippet':                 return `ページで検証: ${a.purpose || ''}`;
        case 'ask_user_choice':             return `質問: ${a.question || ''}`;
        case 'request_existing_userscript': return '既存 UserScript の入力を要求';
        case 'output_userscript':           return 'UserScript を出力';
        default:                            return call.name;
      }
    },

    // ---------------------------------------------------------------------
    // Tool: get_page_info
    // ---------------------------------------------------------------------
    toolPageInfo() {
      const metaOf = (sel) => { const n = document.querySelector(sel); return (n && n.content) || ''; };
      const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
      const scripts = [];
      for (const s of document.querySelectorAll('script[src]')) {
        const src = abs(s.getAttribute('src'));
        if (src && scripts.indexOf(src) === -1) scripts.push(src);
        if (scripts.length >= 40) break;
      }
      const styles = [];
      for (const l of document.querySelectorAll('link[rel~="stylesheet"][href]')) {
        const href = abs(l.getAttribute('href'));
        if (href && styles.indexOf(href) === -1) styles.push(href);
        if (styles.length >= 30) break;
      }
      // Framework sniffing is best-effort and only advisory — it tells the
      // model whether to expect re-rendered DOM (and therefore whether a
      // MutationObserver is warranted).
      const frameworks = [];
      const w = window;
      if (document.querySelector('#__next') || w.__NEXT_DATA__) frameworks.push('Next.js');
      if (document.querySelector('#__nuxt') || w.__NUXT__) frameworks.push('Nuxt');
      if (document.querySelector('[data-reactroot],[data-reactid]') || w.React || w.__REACT_DEVTOOLS_GLOBAL_HOOK__) frameworks.push('React');
      if (document.querySelector('[data-v-app],[data-server-rendered]') || w.Vue || w.__VUE__) frameworks.push('Vue');
      if (document.querySelector('[ng-version],[ng-app]')) frameworks.push('Angular');
      if (document.querySelector('[data-svelte-h]')) frameworks.push('Svelte');
      if (w.jQuery) frameworks.push('jQuery ' + (w.jQuery.fn && w.jQuery.fn.jquery || ''));
      if (document.querySelector('meta[name="generator"][content*="WordPress" i]')) frameworks.push('WordPress');

      let shadowHosts = 0;
      try {
        for (const n of document.querySelectorAll('*')) { if (n.shadowRoot) shadowHosts++; if (shadowHosts >= 50) break; }
      } catch {}

      return {
        url: location.href,
        origin: location.origin,
        pathname: location.pathname,
        title: document.title || '',
        description: metaOf('meta[name="description"]'),
        og_type: metaOf('meta[property="og:type"]'),
        lang: document.documentElement.getAttribute('lang') || '',
        charset: document.characterSet || '',
        viewport: metaOf('meta[name="viewport"]'),
        suggested_match: this.suggestedMatches(),
        body_classes: (document.body && document.body.className) || '',
        body_id: (document.body && document.body.id) || '',
        element_count: document.getElementsByTagName('*').length,
        iframe_count: document.getElementsByTagName('iframe').length,
        shadow_host_count: shadowHosts,
        frameworks,
        scripts,
        stylesheets: styles,
        note: shadowHosts
          ? 'このページには Shadow DOM を使う要素があります。通常の querySelector では内部要素に到達できない点に注意してください。'
          : undefined
      };
    },

    // ---------------------------------------------------------------------
    // Tool: query_selector
    // ---------------------------------------------------------------------
    toolQuerySelector(args) {
      const selector = String(args.selector || '').trim();
      if (!selector) return { error: 'selector は必須です。' };
      let nodes;
      try { nodes = Array.from(document.querySelectorAll(selector)); }
      catch (e) { return { error: `セレクタが無効です: ${selector} (${(e && e.message) || e})` }; }
      // Never let the overlay's own DOM leak back into the model's view of
      // the page — it would happily write selectors against our chat UI.
      nodes = nodes.filter((n) => !(UI.hostEl && (n === UI.hostEl || UI.hostEl.contains(n))));
      if (!nodes.length) return { selector, count: 0, matches: [], hint: '一致する要素がありません。get_page_html で構造を確認してください。' };

      const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
      const per = Math.max(200, Math.min(20000, Number(args.max_chars_per_match) || 2000));
      const matches = nodes.slice(0, limit).map((n, i) => {
        const clone = this._cloneForHtml(n);
        let html = clone.outerHTML || '';
        const truncated = html.length > per;
        if (truncated) html = html.slice(0, per) + '\n<!-- …truncated… -->';
        let rect = null;
        try { const r = n.getBoundingClientRect(); rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch {}
        const text = (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
        return {
          index: i,
          tag: n.tagName ? n.tagName.toLowerCase() : '',
          id: n.id || '',
          classes: (typeof n.className === 'string' ? n.className : '').trim(),
          visible: !!(rect && rect.w > 0 && rect.h > 0),
          rect,
          text: text.length > 300 ? text.slice(0, 300) + '…' : text,
          outer_html: html,
          outer_html_truncated: truncated
        };
      });
      return { selector, count: nodes.length, returned: matches.length, matches };
    },

    // ---------------------------------------------------------------------
    // Tool: get_page_html
    // ---------------------------------------------------------------------
    toolPageHtml(args) {
      const selector = args.selector ? String(args.selector).trim() : '';
      let root;
      if (selector) {
        try { root = document.querySelector(selector); }
        catch (e) { return { error: `セレクタが無効です: ${selector} (${(e && e.message) || e})` }; }
        if (!root) return { error: `セレクタに一致する要素がありません: ${selector}` };
      } else {
        root = args.include_head ? document.documentElement : (document.body || document.documentElement);
      }
      const max = Math.max(1000, Math.min(this.HTML_MAX_CAP, Number(args.max_chars) || this.HTML_MAX_DEFAULT));
      const clone = this._cloneForHtml(root);
      let html = clone.outerHTML || '';
      const full = html.length;
      const truncated = full > max;
      if (truncated) html = html.slice(0, max) + '\n<!-- …truncated… -->';
      return {
        selector: selector || (args.include_head ? 'html' : 'body'),
        length: full,
        truncated,
        hint: truncated ? 'HTML が打ち切られました。selector を指定して範囲を絞るか query_selector を使ってください。' : undefined,
        html
      };
    },

    // Clone a subtree for serialisation: drops our own overlay, empties the
    // bodies of script/style/svg (structurally irrelevant but enormous), and
    // shortens inline data URIs. Attributes that matter for selector authoring
    // — class, id, data-*, aria-*, role — are deliberately preserved, which is
    // the opposite of what `Page._extractRaw` does for prose context.
    _cloneForHtml(root) {
      const clone = root.cloneNode(true);
      if (!clone.querySelectorAll) return clone;
      clone.querySelectorAll('#aicx-root').forEach((n) => n.remove());
      clone.querySelectorAll('script').forEach((n) => {
        if ((n.textContent || '').length > 120) n.textContent = ' /* …inline script omitted… */ ';
      });
      clone.querySelectorAll('style').forEach((n) => {
        if ((n.textContent || '').length > 200) n.textContent = ' /* …inline CSS omitted… */ ';
      });
      clone.querySelectorAll('svg,canvas,noscript').forEach((n) => { n.textContent = ''; });
      const all = [clone, ...clone.querySelectorAll('*')];
      for (const n of all) {
        if (!n.attributes || !n.attributes.length) continue;
        for (const attr of Array.from(n.attributes)) {
          const v = attr.value;
          if (v && v.length > 300 && /^data:/i.test(v)) {
            n.setAttribute(attr.name, v.slice(0, 60) + '…[truncated data URI]');
          } else if (v && v.length > 2000) {
            n.setAttribute(attr.name, v.slice(0, 2000) + '…');
          }
        }
      }
      return clone;
    },

    // ---------------------------------------------------------------------
    // Tool: fetch_resource
    // ---------------------------------------------------------------------
    async toolFetchResource(args) {
      const raw = String(args.url || '').trim();
      if (!raw) return { error: 'url は必須です。' };
      let url;
      try { url = new URL(raw, location.href).href; }
      catch { return { error: `URL を解決できません: ${raw}` }; }
      if (!/^https?:/i.test(url)) return { error: 'http / https の URL のみ取得できます。' };
      const max = Math.max(1000, Math.min(this.FETCH_MAX_CAP, Number(args.max_chars) || this.FETCH_MAX_DEFAULT));

      let status = 0, contentType = '', text = null;
      // Plain fetch first (cheap, no permission prompt); GM XHR is the CORS /
      // CSP fallback and is where the userscript manager asks the user for
      // per-domain permission on hosts outside our @connect list.
      try {
        const res = await fetch(url, { credentials: 'omit' });
        status = res.status;
        contentType = res.headers.get('content-type') || '';
        text = await res.text();
      } catch (e) {
        try {
          const r = await gmRequest({ method: 'GET', url });
          status = r.status;
          text = r.responseText;
        } catch (e2) {
          return { error: `取得に失敗しました: ${(e2 && e2.message) || e2}`, url };
        }
      }
      if (text == null) return { error: '本文を取得できませんでした。', url, status };
      const full = text.length;
      const truncated = full > max;
      return {
        url,
        status,
        content_type: contentType,
        length: full,
        truncated,
        content: truncated ? text.slice(0, max) + '\n/* …truncated… */' : text
      };
    },

    // ---------------------------------------------------------------------
    // Tool: run_snippet
    // ---------------------------------------------------------------------
    async toolRunSnippet(args, ctx) {
      const code = String(args.code || '').trim();
      if (!code) return { error: 'code は必須です。' };
      const convId = ctx && ctx.conv && ctx.conv.id;
      if (!(convId && this._autoRunConvIds.has(convId))) {
        const verdict = await UI.confirmCode({
          title: 'ページ上でコードを実行しますか?',
          description: `AI が以下のコードをこのページで実行しようとしています。\n目的: ${args.purpose || '(説明なし)'}`,
          code,
          okLabel: '実行する',
          rememberLabel: 'この会話では以後確認しない'
        });
        if (!verdict.ok) {
          return { error: 'ユーザーが実行を拒否しました。別の方法 (query_selector / get_page_html) で確認してください。', denied: true };
        }
        if (verdict.always && convId) this._autoRunConvIds.add(convId);
      }
      return await this._runInPage(code);
    },

    // Evaluate `code` as a function body in the PAGE's realm and return a
    // JSON-safe view of its result.
    //
    // Page realm matters: userscript managers run us in a sandbox, so
    // page-owned globals (__NUXT__, jQuery, app stores) are invisible from
    // here — exactly the values worth inspecting. We inject a <script> and
    // hand the result back through a DOM node's textContent, which crosses
    // the sandbox boundary without needing `unsafeWindow`. If the page's CSP
    // blocks the injection (detected via a synchronously-set marker), we fall
    // back to evaluating in our own realm.
    _runInPage(code) {
      return new Promise((resolve) => {
        const outId = 'aicx-snip-' + uid();
        const out = document.createElement('script');
        out.type = 'application/json';
        out.id = outId;
        (document.documentElement || document.head).appendChild(out);

        const cleanup = () => { try { out.remove(); } catch {} };
        const source = `(function(){
  var out = document.getElementById(${JSON.stringify(outId)});
  if (!out) return;
  out.setAttribute('data-started', '1');
  function safe(v, depth, seen) {
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === 'string') return v.length > 4000 ? v.slice(0, 4000) + '…' : v;
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'function') return '[function ' + (v.name || 'anonymous') + ']';
    if (t === 'symbol' || t === 'bigint') return String(v);
    if (typeof Element !== 'undefined' && v instanceof Element) {
      var cls = (typeof v.className === 'string' && v.className.trim()) ? '.' + v.className.trim().split(/\\s+/).join('.') : '';
      return '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + cls + '>';
    }
    if (typeof Node !== 'undefined' && v instanceof Node) return '[' + v.nodeName + ']';
    if (depth > 4) return '[…]';
    if (seen.indexOf(v) !== -1) return '[circular]';
    seen.push(v);
    var isList = Array.isArray(v) || (typeof v.length === 'number' && typeof v.item === 'function');
    if (isList) {
      var arr = [], n = Math.min(v.length, 50), i;
      for (i = 0; i < n; i++) { try { arr.push(safe(v[i], depth + 1, seen)); } catch (e) { arr.push('[unreadable]'); } }
      if (v.length > n) arr.push('…(' + v.length + ' items total)');
      return arr;
    }
    var o = {}, keys;
    try { keys = Object.keys(v).slice(0, 50); } catch (e) { return String(v); }
    for (var j = 0; j < keys.length; j++) {
      try { o[keys[j]] = safe(v[keys[j]], depth + 1, seen); } catch (e) { o[keys[j]] = '[unreadable]'; }
    }
    return o;
  }
  function emit(payload) {
    try { out.textContent = JSON.stringify(payload); }
    catch (e) { out.textContent = JSON.stringify({ ok: false, error: 'result could not be serialized: ' + ((e && e.message) || e) }); }
  }
  function finish(value) { emit({ ok: true, result: safe(value, 0, []) }); }
  function fail(e) { emit({ ok: false, error: ((e && e.message) || String(e)), stack: (e && e.stack) ? String(e.stack).split('\\n').slice(0, 4).join('\\n') : undefined }); }
  try {
    // async wrapper: lets the snippet use \`await\` directly (a plain function
    // body would throw a SyntaxError on it) while a synchronous \`return\`
    // still works — it just arrives as an already-resolved promise.
    var r = (async function(){ ${code}
    })();
    if (r && typeof r.then === 'function') r.then(finish, fail); else finish(r);
  } catch (e) { fail(e); }
})();`;

        let started = false;
        try {
          const s = document.createElement('script');
          s.textContent = source + '\n//# sourceURL=aicx-snippet.js';
          (document.head || document.documentElement).appendChild(s);
          s.remove();
          started = out.hasAttribute('data-started');
        } catch (e) { started = false; }

        if (!started) {
          // CSP blocked the page-realm injection — run in our own realm. The
          // DOM is shared so selector checks still work; only page-owned
          // globals are out of reach.
          try {
            // Mirror the page-realm wrapper: build an async function so the
            // snippet may `await`. `new Function` only makes sync functions,
            // so reach the AsyncFunction constructor through a prototype.
            const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
            const r = (new AsyncFunction(code))();
            const wrap = (v) => resolve({ ok: true, realm: 'sandbox', result: this._safeSandbox(v, 0, []) });
            if (r && typeof r.then === 'function') { r.then(wrap, (e) => resolve({ ok: false, realm: 'sandbox', error: (e && e.message) || String(e) })); }
            else wrap(r);
          } catch (e) {
            resolve({ ok: false, realm: 'sandbox', error: (e && e.message) || String(e) });
          }
          cleanup();
          return;
        }

        const started_at = now();
        const poll = setInterval(() => {
          const raw = out.textContent;
          if (raw) {
            clearInterval(poll);
            cleanup();
            let parsed;
            try { parsed = JSON.parse(raw); } catch { parsed = { ok: false, error: '結果を解析できませんでした。' }; }
            parsed.realm = 'page';
            resolve(parsed);
            return;
          }
          if (now() - started_at > this.SNIPPET_TIMEOUT_MS) {
            clearInterval(poll);
            cleanup();
            resolve({ ok: false, realm: 'page', error: `${Math.round(this.SNIPPET_TIMEOUT_MS / 1000)} 秒以内に結果が返りませんでした (Promise が解決していない可能性があります)。` });
          }
        }, 50);
      });
    },

    // Sandbox-realm mirror of the injected `safe()` above.
    _safeSandbox(v, depth, seen) {
      if (v === null || v === undefined) return null;
      const t = typeof v;
      if (t === 'string') return v.length > 4000 ? v.slice(0, 4000) + '…' : v;
      if (t === 'number' || t === 'boolean') return v;
      if (t === 'function') return '[function ' + (v.name || 'anonymous') + ']';
      if (t === 'symbol' || t === 'bigint') return String(v);
      if (typeof Element !== 'undefined' && v instanceof Element) {
        const cls = (typeof v.className === 'string' && v.className.trim()) ? '.' + v.className.trim().split(/\s+/).join('.') : '';
        return '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + cls + '>';
      }
      if (typeof Node !== 'undefined' && v instanceof Node) return '[' + v.nodeName + ']';
      if (depth > 4) return '[…]';
      if (seen.indexOf(v) !== -1) return '[circular]';
      seen.push(v);
      const isList = Array.isArray(v) || (typeof v.length === 'number' && typeof v.item === 'function');
      if (isList) {
        const arr = [];
        const n = Math.min(v.length, 50);
        for (let i = 0; i < n; i++) { try { arr.push(this._safeSandbox(v[i], depth + 1, seen)); } catch { arr.push('[unreadable]'); } }
        if (v.length > n) arr.push(`…(${v.length} items total)`);
        return arr;
      }
      const o = {};
      let keys;
      try { keys = Object.keys(v).slice(0, 50); } catch { return String(v); }
      for (const k of keys) {
        try { o[k] = this._safeSandbox(v[k], depth + 1, seen); } catch { o[k] = '[unreadable]'; }
      }
      return o;
    },

    // ---------------------------------------------------------------------
    // Tool: ask_user_choice
    // ---------------------------------------------------------------------
    async toolAskUserChoice(args) {
      const question = String(args.question || '').trim();
      if (!question) return { error: 'question は必須です。' };
      const raw = Array.isArray(args.options) ? args.options : [];
      const options = raw
        .map((o) => (o && typeof o === 'object') ? o : { label: String(o) })
        .filter((o) => o.label != null && String(o.label).trim())
        .slice(0, 12)
        .map((o) => ({
          label: String(o.label).trim(),
          description: o.description ? String(o.description) : '',
          allowFreeText: !!o.allow_free_text,
          freeTextPlaceholder: o.free_text_placeholder ? String(o.free_text_placeholder) : ''
        }));
      if (options.length < 2) return { error: 'options は 2 件以上必要です。' };

      const multiple = !!args.multiple;
      const verdict = await UI.chooseOptions({
        question,
        description: args.description ? String(args.description) : '',
        multiple,
        options
      });
      if (verdict.cancelled) {
        return {
          answered: false,
          cancelled: true,
          message: 'ユーザーは選択をキャンセルしました。別の質問をするか、無難な既定案で進めてよいか確認してください。'
        };
      }
      return {
        answered: true,
        multiple,
        // `index` is the number the user actually saw next to the option, so
        // the model can refer to "2番" and mean the same thing they did.
        selected: verdict.selected.map((s) => ({
          index: s.index,
          label: s.label,
          free_text: s.freeText || undefined
        }))
      };
    },

    // ---------------------------------------------------------------------
    // Tool: request_existing_userscript
    // ---------------------------------------------------------------------
    async toolRequestExisting(args) {
      const code = await UI.promptText({
        title: '既存の UserScript を読み込む',
        iconName: 'code',
        description: `AI が既存のスクリプトを必要としています。\n理由: ${args.reason || '(説明なし)'}\n\nTampermonkey のエディタからコードをコピーして貼り付けるか、.user.js ファイルを選択してください。`,
        placeholder: '// ==UserScript==\n// @name ...\n// ==/UserScript==\n...',
        okLabel: 'AI に渡す',
        allowFile: true
      });
      if (code == null || !code.trim()) {
        return { provided: false, message: 'ユーザーは既存スクリプトを提供しませんでした。新規作成として進めるか、ユーザーに確認してください。' };
      }
      const MAX = 120000;
      const truncated = code.length > MAX;
      return {
        provided: true,
        length: code.length,
        truncated,
        code: truncated ? code.slice(0, MAX) + '\n/* …truncated… */' : code
      };
    },

    // ---------------------------------------------------------------------
    // Tool: output_userscript
    // ---------------------------------------------------------------------
    // Tampermonkey only accepts a metadata block that OPENS with a line that is
    // exactly `// ==UserScript==` and CLOSES with exactly `// ==/UserScript==`.
    // Anything else fails at install time with a parse error, so the block is
    // validated before an install card is ever offered.
    //
    // Line-anchored on purpose. The previous check just asked whether each
    // marker appeared *somewhere* in the source, which let two real defects
    // through:
    //   1. The model occasionally repeats the OPENING marker where the closing
    //      one belongs (`// ==UserScript==` with the `/` missing). The old
    //      close test then failed on a truncated-looking script and produced a
    //      vague message, or — worse — passed because of (2).
    //   2. A marker sitting inside a string literal satisfied the substring
    //      test. That is easy to hit here: scripts generated in this mode are
    //      themselves sometimes userscript templates carrying both markers as
    //      data.
    // Order and uniqueness are checked too, and each error names the concrete
    // defect (with a line number) so the model can fix it in one turn.
    META_OPEN_RE: /^[ \t]*\/\/[ \t]*==UserScript==[ \t]*$/,
    META_CLOSE_RE: /^[ \t]*\/\/[ \t]*==\/UserScript==[ \t]*$/,

    validateScript(code) {
      const text = String(code || '');
      if (!text.trim()) return { ok: false, error: 'code が空です。' };
      const lines = text.split(/\r?\n/);
      const opens = [];
      const closes = [];
      lines.forEach((l, i) => {
        if (this.META_OPEN_RE.test(l)) opens.push(i);
        else if (this.META_CLOSE_RE.test(l)) closes.push(i);
      });

      if (!opens.length) {
        return { ok: false, error: 'メタデータブロックの開始行 `// ==UserScript==` がありません。スクリプトはこの行 (前後に余分な文字を付けない) で始めてください。' };
      }
      const open = opens[0];
      // Tampermonkey expects the block at the very top of the file, so only
      // blank lines may precede it.
      if (lines.slice(0, open).join('').trim()) {
        return { ok: false, error: `メタデータブロックの前に余分な内容があります (${open} 行目まで)。スクリプトは 1 行目の \`// ==UserScript==\` で始めてください。` };
      }

      const close = closes.find((i) => i > open);
      if (close === undefined) {
        const stray = opens.find((i) => i > open);
        if (stray !== undefined) {
          return {
            ok: false,
            error: `メタデータブロックの閉じ行が \`// ==/UserScript==\` ではなく \`// ==UserScript==\` になっています (${stray + 1} 行目 — \`==\` の後の \`/\` が抜けています)。この行を \`// ==/UserScript==\` に直した完全なスクリプトを渡し直してください。`
          };
        }
        return { ok: false, error: 'メタデータブロックの終了行 `// ==/UserScript==` がありません。ブロックはこの行で閉じてください。' };
      }
      if (close === open + 1) {
        return { ok: false, error: 'メタデータブロックが空です。@name / @description / @match / @grant などを記述してください。' };
      }
      const dupe = opens.find((i) => i > open && i < close);
      if (dupe !== undefined) {
        return { ok: false, error: `メタデータブロック内に \`// ==UserScript==\` が重複しています (${dupe + 1} 行目)。開始行は 1 つだけにしてください。` };
      }
      return { ok: true, openLine: open + 1, closeLine: close + 1 };
    },

    toolOutputUserscript(args) {
      const code = String(args.code || '');
      const verdict = this.validateScript(code);
      if (!verdict.ok) return { error: verdict.error };
      const meta = this.parseMeta(code);
      return {
        ok: true,
        delivered: true,
        name: args.name || meta.name || 'userscript',
        matches: meta.match,
        grants: meta.grant,
        message: 'チャットにインストールカードを表示しました。ユーザーがボタンを押すとインストールできます。続けて、このスクリプトの動作と使い方を簡潔に説明してください。'
      };
    },

    // Minimal ==UserScript== metadata-block parser. Returns single-value keys
    // as strings and repeatable keys (@match / @grant / @require / @connect)
    // as arrays.
    parseMeta(code) {
      const out = { match: [], grant: [], require: [], connect: [] };
      const lines = String(code || '').split(/\r?\n/);
      // Same line-anchored markers as validateScript, so what we display can
      // never be read out of a marker that merely appears inside a string.
      const open = lines.findIndex((l) => this.META_OPEN_RE.test(l));
      if (open === -1) return out;
      let close = lines.findIndex((l, i) => i > open && this.META_CLOSE_RE.test(l));
      // Unclosed block: still parse to end-of-file so the install card can show
      // whatever metadata exists next to its validation warning.
      if (close === -1) close = lines.length;
      for (const line of lines.slice(open + 1, close)) {
        const m = /^\s*\/\/\s*@([\w:-]+)\s+(.*?)\s*$/.exec(line);
        if (!m) continue;
        const key = m[1];
        const val = m[2];
        if (Object.prototype.hasOwnProperty.call(out, key) && Array.isArray(out[key])) out[key].push(val);
        else if (out[key] === undefined) out[key] = val;
      }
      return out;
    },

    // ---------------------------------------------------------------------
    // Install card + install dialog
    // ---------------------------------------------------------------------
    fileNameFor(name) {
      const base = String(name || 'userscript')
        .replace(/[\\/:*?"<>|\s]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'userscript';
      return base.replace(/\.user\.js$/i, '') + '.user.js';
    },

    // Chat card rendered in place of a raw code dump when the model calls
    // `output_userscript`. The code is stored on the message, so the card
    // (and its install button) survive a page reload.
    renderInstallCard(args) {
      const code = String((args && args.code) || '');
      const meta = this.parseMeta(code);
      const name = (args && args.name) || meta.name || 'UserScript';
      const summary = (args && args.summary) || meta.description || '';
      const filename = this.fileNameFor(name);

      const card = el('div', { class: 'w-full my-2 rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-900/30 overflow-hidden' });

      const head = el('div', { class: 'flex items-start gap-2 p-3' });
      head.append(el('span', { class: 'shrink-0 mt-0.5 text-indigo-600 dark:text-indigo-300' }, [icon('code', 'w-5 h-5')]));
      const headText = el('div', { class: 'flex-1 min-w-0' });
      headText.append(el('div', { class: 'text-sm font-semibold text-zinc-900 dark:text-zinc-100 break-words' }, name));
      if (summary) headText.append(el('div', { class: 'text-xs text-zinc-600 dark:text-zinc-300 mt-0.5 break-words' }, summary));
      const facts = [];
      if (meta.version) facts.push(`v${meta.version}`);
      if (meta.match && meta.match.length) facts.push(meta.match.join(', '));
      if (meta.grant && meta.grant.length) facts.push(`@grant ${meta.grant.join(' ')}`);
      facts.push(`${code.length.toLocaleString()} 文字`);
      headText.append(el('div', { class: 'text-[10px] text-zinc-500 dark:text-zinc-400 mt-1 break-all font-mono' }, facts.join(' · ')));
      head.append(headText);
      card.append(head);

      // Second gate. `output_userscript` already refuses a malformed metadata
      // block, so a card built in this session is valid — but cards re-rendered
      // from conversations stored before that check existed can still carry a
      // broken block. Warn rather than hide the buttons: the code is worth
      // copying out and fixing by hand even when Tampermonkey would reject it.
      const verdict = this.validateScript(code);
      if (!verdict.ok) {
        const warn = el('div', { class: 'flex items-start gap-2 mx-3 mb-3 p-2 rounded-lg bg-red-50 dark:bg-red-900/30 text-[11px] text-red-700 dark:text-red-300' });
        warn.append(el('span', { class: 'shrink-0 pt-0.5' }, [icon('warn', 'w-3.5 h-3.5')]));
        warn.append(el('div', { class: 'flex-1 min-w-0 break-words' },
          `このままでは Tampermonkey がインストールに失敗します: ${verdict.error}`));
        card.append(warn);
      }

      const btnRow = el('div', { class: 'flex flex-wrap gap-2 px-3 pb-3' });
      const install = el('button', { class: 'px-3 py-2 rounded-lg text-xs font-medium bg-indigo-600 text-white aicx-tap inline-flex items-center gap-1', type: 'button' });
      install.append(icon('download', 'w-3.5 h-3.5'), el('span', {}, 'UserScript インストール'));
      install.addEventListener('click', () => this.openInstallDialog({ code, name, filename }));

      const copy = el('button', { class: 'px-3 py-2 rounded-lg text-xs bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 aicx-tap inline-flex items-center gap-1', type: 'button' });
      copy.append(icon('copy', 'w-3.5 h-3.5'), el('span', {}, 'コピー'));
      copy.addEventListener('click', async () => {
        const ok = await copyToClipboard(code);
        UI.toast(ok ? 'コピーしました' : 'コピーに失敗しました', ok ? 'success' : 'error');
      });

      const pre = el('pre', { class: 'whitespace-pre-wrap break-words text-[11px] font-mono bg-zinc-900 text-zinc-100 p-3 max-h-80 overflow-auto hidden' }, code);
      const toggle = el('button', { class: 'px-3 py-2 rounded-lg text-xs bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 aicx-tap inline-flex items-center gap-1', type: 'button' });
      toggle.append(icon('code', 'w-3.5 h-3.5'), el('span', {}, 'コードを表示'));
      toggle.addEventListener('click', () => {
        const hidden = pre.classList.toggle('hidden');
        toggle.lastChild.textContent = hidden ? 'コードを表示' : 'コードを隠す';
      });

      // Offer the install button only for a script Tampermonkey will actually
      // accept. Handing the user a prominent "install" affordance for a block
      // we already know is malformed just walks them into the parse error the
      // warning above describes. Copy / show-code stay available so the code is
      // still recoverable by hand.
      if (verdict.ok) btnRow.append(install);
      btnRow.append(copy, toggle);
      card.append(btnRow, pre);
      return card;
    },

    // Tampermonkey has no API for handing it a script directly from a page —
    // it installs by intercepting navigations to URLs ending in `.user.js`,
    // which a blob:/data: URL can never satisfy. So we offer the three routes
    // that do work and let the user pick, rather than pretending one click is
    // enough.
    openInstallDialog({ code, name, filename }) {
      const { body, footer, close } = UI.modal({ title: 'Tampermonkey にインストール', iconName: 'download', maxWidth: 'max-w-xl' });

      const step = (n, heading, desc, button) => {
        const row = el('div', { class: 'flex gap-3 p-3 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50' });
        row.append(el('div', { class: 'shrink-0 w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-semibold flex items-center justify-center' }, String(n)));
        const col = el('div', { class: 'flex-1 min-w-0 space-y-2' });
        col.append(el('div', { class: 'text-xs font-semibold text-zinc-800 dark:text-zinc-100' }, heading));
        col.append(el('div', { class: 'text-[11px] text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap' }, desc));
        col.append(button);
        row.append(col);
        return row;
      };

      const dlBtn = el('button', { class: 'px-3 py-2 rounded-lg text-xs font-medium bg-indigo-600 text-white aicx-tap inline-flex items-center gap-1', type: 'button' });
      dlBtn.append(icon('download', 'w-3.5 h-3.5'), el('span', {}, `${filename} をダウンロード`));
      dlBtn.addEventListener('click', () => {
        this.downloadScript(filename, code);
        UI.toast('ダウンロードしました。ファイルを開くとインストール画面が出ます', 'success');
      });

      const copyBtn = el('button', { class: 'px-3 py-2 rounded-lg text-xs bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 aicx-tap inline-flex items-center gap-1', type: 'button' });
      copyBtn.append(icon('copy', 'w-3.5 h-3.5'), el('span', {}, 'コードをコピー'));
      copyBtn.addEventListener('click', async () => {
        const ok = await copyToClipboard(code);
        UI.toast(ok ? 'コピーしました' : 'コピーに失敗しました', ok ? 'success' : 'error');
      });

      const openBtn = el('button', { class: 'px-3 py-2 rounded-lg text-xs bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 aicx-tap inline-flex items-center gap-1', type: 'button' });
      openBtn.append(icon('web', 'w-3.5 h-3.5'), el('span', {}, '新しいタブでソースを開く'));
      openBtn.addEventListener('click', () => this.openScriptTab(code));

      body.append(
        step(1, 'ファイルとして保存してインストール (推奨)',
          'ダウンロード後、ブラウザのダウンロード一覧からファイルを開くと Tampermonkey のインストール画面が開きます。開かない場合は、拡張機能の詳細設定で「ファイルの URL へのアクセスを許可する」を有効にしてください。',
          dlBtn),
        step(2, 'コピーして新規スクリプトに貼り付け',
          'Tampermonkey ダッシュボード →「+」(新規スクリプト) を開き、エディタの内容をすべて置き換えて保存 (Ctrl / Cmd + S) します。iOS の Userscripts アプリなど、ダウンロード方式が使えない環境ではこちらを使ってください。',
          copyBtn),
        step(3, 'ソースを確認する',
          'インストールする前に全文をブラウザで確認したい場合に使います。',
          openBtn)
      );

      const done = el('button', { class: 'px-4 py-2 rounded-lg text-sm bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 aicx-tap', type: 'button' }, '閉じる');
      done.addEventListener('click', close);
      footer.append(done);
    },

    _blobUrl(code) {
      return URL.createObjectURL(new Blob([code], { type: 'text/plain;charset=utf-8' }));
    },

    downloadScript(filename, code) {
      const url = this._blobUrl(code);
      // The anchor must live in the light DOM: a click on a detached node (or
      // one inside our shadow root) is ignored by some browsers' download path.
      const a = el('a', { href: url, download: filename, style: { display: 'none' } });
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(() => { try { a.remove(); } catch {} URL.revokeObjectURL(url); }, 60000);
    },

    openScriptTab(code) {
      const url = this._blobUrl(code);
      const gmOpen = (typeof GM_openInTab === 'function') ? GM_openInTab
        : (typeof GM !== 'undefined' && GM && typeof GM.openInTab === 'function') ? GM.openInTab.bind(GM)
        : null;
      try {
        if (gmOpen) gmOpen(url, { active: true, insert: true });
        else window.open(url, '_blank', 'noopener');
      } catch {
        window.open(url, '_blank', 'noopener');
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },

    // ---------------------------------------------------------------------
    // Tool-activity rendering (chat transcript)
    // ---------------------------------------------------------------------
    // Compact expandable pill so the user can audit exactly what the agent
    // asked for and what it got back, without the transcript being swamped by
    // 20 KB of HTML.
    renderActivityPill({ iconName, label, detail, tone = 'neutral' }) {
      const tones = {
        neutral: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300',
        error: 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300'
      };
      const wrap = el('div', { class: 'w-full my-1' });
      const btn = el('button', {
        class: `inline-flex items-center gap-2 max-w-full px-3 py-1.5 rounded-full text-[11px] aicx-tap ${tones[tone] || tones.neutral}`,
        type: 'button'
      });
      btn.append(icon(iconName, 'w-3.5 h-3.5'), el('span', { class: 'truncate' }, label));
      const pre = el('pre', {
        class: 'hidden mt-1 whitespace-pre-wrap break-words text-[11px] font-mono bg-zinc-50 dark:bg-zinc-800 rounded-lg p-2 max-h-64 overflow-auto text-zinc-700 dark:text-zinc-200'
      }, detail || '(詳細なし)');
      btn.addEventListener('click', () => pre.classList.toggle('hidden'));
      wrap.append(btn, pre);
      return wrap;
    },

    // Assistant turn that carried functionCall parts.
    renderCalls(msg) {
      const frag = document.createDocumentFragment();
      for (const call of msg.functionCalls || []) {
        if (call.name === 'output_userscript') {
          frag.appendChild(this.renderInstallCard(call.args || {}));
          continue;
        }
        let detail;
        try { detail = JSON.stringify(call.args || {}, null, 2); } catch { detail = String(call.args); }
        frag.appendChild(this.renderActivityPill({
          iconName: call.name === 'run_snippet' ? 'play' : 'wrench',
          label: this.describeCall(call),
          detail
        }));
      }
      return frag;
    },

    // Our matching tool-result turn.
    renderResponses(msg) {
      const frag = document.createDocumentFragment();
      for (const fr of msg.functionResponses || []) {
        // output_userscript's ack carries no information the install card
        // above doesn't already show.
        if (fr.name === 'output_userscript' && fr.response && !fr.response.error) continue;
        const r = fr.response || {};
        let detail;
        try { detail = JSON.stringify(r, null, 2); } catch { detail = String(r); }
        if (detail.length > 20000) detail = detail.slice(0, 20000) + '\n…(省略)';
        const isErr = !!r.error;
        let label;
        if (isErr) label = `${fr.name}: ${r.error}`;
        else if (fr.name === 'ask_user_choice') {
          label = r.answered
            ? `回答: ${r.selected.map((s) => `${s.index}. ${s.label}${s.free_text ? ` (${s.free_text})` : ''}`).join(' / ')}`
            : '回答: (キャンセル)';
        } else if (typeof r.count === 'number') label = `${fr.name}: ${r.count} 件一致`;
        else if (typeof r.length === 'number') label = `${fr.name}: ${r.length.toLocaleString()} 文字`;
        else if (r.ok === false) label = `${fr.name}: 失敗`;
        else label = `${fr.name}: 完了`;
        frag.appendChild(this.renderActivityPill({
          iconName: isErr ? 'warn' : 'check',
          label: '↳ ' + label,
          detail,
          tone: isErr ? 'error' : 'neutral'
        }));
      }
      return frag;
    }
  };

  // =========================================================================
  // 12.7 In-flight generation registry
  // =========================================================================
  //
  // A generation used to live on ChatPanel and was aborted by `close()`, so
  // dismissing the sheet threw away the answer — painful in UserScript mode
  // where one send can span a minute of tool round trips. Runs are keyed by
  // conversation id here instead, which decouples them from the panel: closing
  // the sheet (or opening a different conversation) leaves the run going, and
  // reopening re-attaches to it because the conversation object streamed into
  // is the very same one `Store.domains` hands back.
  //
  // Scope note: this survives the panel, not the page. A reload or navigation
  // still tears the run down — a userscript has nowhere else to run.
  const Runs = {
    _map: new Map(),      // convId -> { aborter, host }
    _subs: new Set(),
    has(convId) { return !!convId && this._map.has(convId); },
    count() { return this._map.size; },
    add(convId, entry) { this._map.set(convId, entry); this._notify(); },
    // Entry-checked so a finished run can't delete the registration of a
    // newer run started for the same conversation.
    remove(convId, entry) {
      if (this._map.get(convId) === entry) { this._map.delete(convId); this._notify(); }
    },
    stop(convId) {
      const e = this._map.get(convId);
      if (e) { try { e.aborter.abort(); } catch {} }
    },
    stopAll() { for (const id of [...this._map.keys()]) this.stop(id); },
    subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); },
    _notify() { for (const fn of this._subs) { try { fn(); } catch {} } }
  };

  // =========================================================================
  // 13. UI: Chat Panel
  // =========================================================================
  const ChatPanel = {
    panel: null, host: null, conv: null, els: null, attachments: [],
    open(opts = {}) {
      this.close();
      // Kick off the lazy library load if it wasn't already started from
      // the FAB menu (e.g. programmatic open). Re-render once finished so
      // the plaintext fallback used during the initial paint upgrades to
      // proper markdown + sanitization when the libs land.
      LazyLibs.load().then(() => {
        if (this.panel) this.render();
      });
      const host = getDomain();
      const domain = Store.getDomain(host);
      let conv = null;
      if (opts.conversationId) {
        conv = domain.conversations.find((c) => c.id === opts.conversationId) || null;
      }
      // Defer creating a new conversation until the user actually sends something,
      // to avoid leaving empty conversations in history if they close the panel.
      this.host = host;
      // Chat mode. Restoring a conversation always wins over the caller's
      // request so a stored UserScript chat reopens with its tools intact.
      this.mode = (conv && conv.mode) || opts.mode || 'chat';
      const isUserscript = this.mode === UserScriptMode.ID;
      // Web grounding defaults to off for every newly opened chat panel,
      // unless the caller (e.g. a template shortcut) explicitly requests it.
      this.webGrounding = !!opts.webSearch;
      // URL Context tool defaults OFF — only enabled when the user opts in
      // per-chat via the composer toggle.
      this.urlContext = !!opts.urlContext;
      // Session-level extraction-mode override. Seeded from the resolved
      // domain/global setting for fresh chats, but forced to 'none' when
      // restoring from history so the conversation-time `conv.pageSnapshot`
      // — not whatever page the user happens to be on now — is what the
      // model continues to see. Changeable from the composer picker for
      // the duration of this panel session (no persistence — closing the
      // panel reverts to settings). The 'none' value is also user-selectable
      // and means "do not attach any page context to outgoing messages".
      // UserScript mode starts at 'none' as well: the agent pulls precisely
      // the markup it needs through `get_page_html` / `query_selector`, so a
      // blanket text dump would only duplicate context and burn tokens. The
      // picker stays available if the user wants prose context anyway.
      this.pageExtractMode = (conv || isUserscript) ? 'none' : Store.resolvePageExtractMode(host);
      // Remembers the URL whose snapshot we most recently injected into the
      // API stream during this panel session. Used to avoid re-sending the
      // same context on every follow-up message while still re-injecting
      // when the user navigates to a different page (or explicitly toggles
      // the feature back on after turning it off — handled below).
      this._lastInjectedUrl = null;
      this.conv = conv;
      this.attachments = [];

      const panel = el('div', { class: 'fixed inset-0 aicx-panel aicx-enter-fade flex items-end justify-center', style: { zIndex: 30 } });
      const overlay = el('div', { class: 'absolute inset-0 bg-black/30' });
      overlay.addEventListener('click', () => this.close());

      // Keyboard-event isolation — stop events that originate inside the
      // panel from bubbling to site-level handlers that would otherwise
      // intercept typing or trigger shortcuts (e.g. Gmail "j/k", Twitter
      // hotkeys, Slack). Panel-internal handlers (Enter→send, input-grow,
      // IME) fire in the target/bubble phase on inner elements first and
      // are unaffected; we only block at the panel boundary on the way
      // up to document/window. Site handlers registered in the CAPTURE
      // phase on ancestors still fire (they run before the event reaches
      // the panel) — an unavoidable limitation of running at
      // document-idle, but in practice most sites use bubble-phase hooks.
      const stopKeyBubble = (e) => e.stopPropagation();
      for (const type of [
        'keydown', 'keyup', 'keypress',
        'beforeinput', 'input',
        'compositionstart', 'compositionupdate', 'compositionend',
        // Clipboard / context events — Ctrl/Cmd+C/V/X fire both keydown
        // (already blocked above) and the dedicated clipboard events.
        // Sites like Gmail and X listen to the latter at document level,
        // so without these entries copy/paste inside the composer still
        // leaks out and can be hijacked.
        'copy', 'cut', 'paste', 'contextmenu'
      ]) {
        panel.addEventListener(type, stopKeyBubble);
      }

      // Focus containment — some sites aggressively refocus their own
      // inputs on certain events; without this guard, subsequent typing
      // would route to the page instead of the composer. Redirects only
      // when focus lands on a real element outside the panel, so native
      // dialogs (file picker, camera) that blur to body are left alone.
      // With shadow DOM, focusin events from inside the shadow retarget
      // their `target` to the shadow host (`UI.hostEl`); we use that as
      // the "focus is inside the overlay" signal and consult
      // `shadow.activeElement` for the actual focused element.
      const focusGuard = (e) => {
        if (!this.panel) return;
        const t = e.target;
        if (!t || t === document.body || t === document.documentElement) return;
        if (t === UI.hostEl) return;
        const ta = this.els && this.els.ta;
        if (!ta) return;
        setTimeout(() => {
          const active = (UI.shadow && UI.shadow.activeElement) || document.activeElement;
          if (this.panel && !this.panel.contains(active)) {
            ta.focus({ preventScroll: true });
          }
        }, 0);
      };
      document.addEventListener('focusin', focusGuard, true);
      this._focusGuard = focusGuard;

      const heightPct = Math.max(25, Math.min(100, Number(Store.settings.chatHeightPct) || 70));
      const sheet = el('div', {
        class: 'relative bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 w-full sm:max-w-6xl sm:mb-4 sm:rounded-2xl rounded-t-2xl shadow-2xl flex flex-col aicx-enter-sheet overflow-hidden',
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
      const titleRow = el('div', { class: 'flex items-center gap-2 min-w-0' });
      const titleTop = el('div', { class: 'flex-1 min-w-0 text-sm font-semibold truncate' },
        (conv && conv.title) || (isUserscript ? '新しい UserScript' : '新しい会話'));
      if (isUserscript) {
        titleRow.append(el('span', {
          class: 'shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-200'
        }, 'UserScript'));
      }
      titleRow.append(titleTop);
      const titleSub = el('div', { class: 'text-[11px] text-zinc-500 dark:text-zinc-400 flex items-center gap-1 min-w-0' });
      // Rebuild the subtitle from the stored pageUrl/pageTitle on the conv
      // (set at first-send time) so reopening a stored conversation on a
      // different page still shows the page it was originally about.
      const updateTitleSub = () => {
        clear(titleSub);
        const pageUrl = (this.conv && this.conv.pageUrl) || location.href;
        const pageTitle = (this.conv && this.conv.pageTitle) || document.title || pageUrl;
        const link = el('a', {
          href: pageUrl, target: '_blank', rel: 'noopener noreferrer',
          class: 'truncate hover:underline text-zinc-600 dark:text-zinc-300 min-w-0',
          title: pageUrl
        }, pageTitle);
        link.addEventListener('click', (e) => e.stopPropagation());
        const tail = el('span', { class: 'shrink-0 text-zinc-500 dark:text-zinc-400' },
          ` · ${Store.settings.model || '(モデル未選択)'}`);
        titleSub.append(link, tail);
      };
      updateTitleSub();
      title.append(titleRow, titleSub);

      // "New" keeps the current mode, so a UserScript session's + button
      // starts another UserScript session rather than dropping to plain chat.
      const btnNewChat = el('button', { class: 'w-9 h-9 shrink-0 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center aicx-tap', 'aria-label': '新規チャット', title: isUserscript ? '新規 UserScript' : '新規チャット' });
      btnNewChat.appendChild(icon('plus'));
      btnNewChat.addEventListener('click', () => this.open({ newChat: true, mode: this.mode }));

      const btnHistory = el('button', { class: 'w-9 h-9 shrink-0 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center aicx-tap', 'aria-label': '会話履歴', title: '会話履歴' });
      btnHistory.appendChild(icon('history'));
      btnHistory.addEventListener('click', () => HistoryPanel.open());

      const closeBtn = el('button', { class: 'w-9 h-9 shrink-0 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center aicx-tap', 'aria-label': '閉じる' });
      closeBtn.appendChild(icon('close'));
      closeBtn.addEventListener('click', () => this.close());

      header.append(title, btnNewChat, btnHistory, closeBtn);

      // Messages
      const list = el('div', { class: 'flex-1 aicx-scroll overflow-y-auto p-4 space-y-3' });

      // Composer: textarea + send button on top row, action buttons below
      const composer = el('div', { class: 'shrink-0 border-t border-zinc-200 dark:border-zinc-800 p-3 bg-white dark:bg-zinc-900 flex flex-col gap-2' });
      const selBar = el('div', { class: 'empty:hidden' });
      const attBar = el('div', { class: 'flex flex-wrap gap-2 empty:hidden' });
      const ta = el('textarea', {
        class: 'flex-1 min-w-0 min-h-[40px] max-h-40 px-3 py-2 rounded-2xl bg-zinc-100 dark:bg-zinc-800 text-sm',
        placeholder: isUserscript ? '作りたい UserScript を説明 (Shift+Enter で改行)' : 'メッセージを入力 (Shift+Enter で改行)',
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

      // Input row: textarea + send/stop pinned to its right. Buttons align
      // to the bottom so they stay flush with the last line as the textarea
      // grows.
      const inputRow = el('div', { class: 'flex items-end gap-2' });

      // Action button row (below input). Wraps onto multiple lines on narrow
      // viewports (phones).
      const btnRow = el('div', { class: 'flex items-end gap-2' });
      const actionsWrap = el('div', { class: 'flex flex-wrap items-center gap-2 flex-1 min-w-0' });

      // Unified attachment button: opens a popover with "ファイル添付" and
      // "カメラ撮影" so the composer row stays compact on narrow screens
      // (the two used to be side-by-side pills).
      const attachWrap = el('div', { class: 'relative shrink-0' });
      const btnAttach = el('button', {
        class: 'w-10 h-10 shrink-0 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 flex items-center justify-center aicx-tap',
        type: 'button',
        'aria-label': 'ファイル / カメラを追加',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        title: 'ファイル添付 / カメラ撮影'
      });
      btnAttach.appendChild(icon('attach'));
      let attachPopover = null;
      const onAttachDocDown = (e) => {
        if (attachPopover && !eventPathIncludes(attachPopover, e) && !eventPathIncludes(btnAttach, e)) closeAttachPop();
      };
      const closeAttachPop = () => {
        if (!attachPopover) return;
        attachPopover.remove(); attachPopover = null;
        btnAttach.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', onAttachDocDown, true);
      };
      btnAttach.addEventListener('click', () => {
        if (attachPopover) { closeAttachPop(); return; }
        attachPopover = el('div', {
          class: 'absolute z-20 bottom-full mb-2 left-0 p-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl min-w-[220px]',
          role: 'menu'
        });
        const mkItem = (iconName, label, onClick) => {
          const item = el('button', {
            class: 'w-full text-left text-xs px-3 py-2 rounded flex items-center gap-2 aicx-tap hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200',
            type: 'button',
            role: 'menuitem'
          });
          item.append(icon(iconName, 'w-4 h-4'), el('span', {}, label));
          item.addEventListener('click', () => { closeAttachPop(); onClick(); });
          return item;
        };
        attachPopover.append(
          mkItem('attach', 'ファイル添付', () => fileInput.click()),
          mkItem('camera', 'カメラ撮影', () => cameraInput.click())
        );
        attachWrap.append(attachPopover);
        btnAttach.setAttribute('aria-expanded', 'true');
        setTimeout(() => document.addEventListener('pointerdown', onAttachDocDown, true), 0);
      });
      attachWrap.append(btnAttach);

      const btnWeb = el('button', { class: '', type: 'button', 'aria-label': 'Web 検索 (Grounding)', 'aria-pressed': 'false', title: 'Gemini の Google 検索 Grounding を有効/無効 (このチャット内のみ)' });
      btnWeb.appendChild(icon('web'));
      const updateWebBtn = () => {
        const on = !!this.webGrounding;
        btnWeb.setAttribute('aria-pressed', on ? 'true' : 'false');
        btnWeb.className = `w-10 h-10 shrink-0 rounded-full flex items-center justify-center aicx-tap transition ${on ? 'bg-indigo-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300'}`;
      };
      updateWebBtn();
      btnWeb.addEventListener('click', () => {
        this.webGrounding = !this.webGrounding;
        updateWebBtn();
      });

      const btnUrlCtx = el('button', { class: '', type: 'button', 'aria-label': 'URL Context', 'aria-pressed': 'false', title: 'Gemini の URL Context を有効/無効 (プロンプト内の URL をツールが取得・解析します)' });
      btnUrlCtx.appendChild(icon('link'));
      const updateUrlCtxBtn = () => {
        const on = !!this.urlContext;
        btnUrlCtx.setAttribute('aria-pressed', on ? 'true' : 'false');
        btnUrlCtx.className = `w-10 h-10 shrink-0 rounded-full flex items-center justify-center aicx-tap transition ${on ? 'bg-indigo-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300'}`;
      };
      updateUrlCtxBtn();
      btnUrlCtx.addEventListener('click', () => {
        this.urlContext = !this.urlContext;
        updateUrlCtxBtn();
      });

      // Extraction-mode picker — lets the user switch the extraction mode
      // (including "抽出なし", which turns off page-context injection
      // entirely) for this chat without touching the global/domain setting.
      // Changing the mode invalidates _lastInjectedUrl so the next send
      // attaches a fresh snapshot built with the new mode.
      const MODE_OPTIONS = [
        { value: 'auto',  short: '自動',     label: '自動 (Readability)' },
        { value: 'clean', short: 'クリーン', label: 'クリーン (chrome 除外)' },
        { value: 'raw',   short: '生',       label: 'ほぼそのまま (HTML)' },
        { value: 'none',  short: 'なし',     label: '抽出なし (ページを含めない)' }
      ];
      const modeWrap = el('div', { class: 'relative shrink-0' });
      const btnMode = el('button', {
        type: 'button',
        'aria-label': '抽出モード',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false'
      });
      const btnModeLabel = el('span', { class: 'text-xs font-medium' }, '');
      btnMode.append(icon('summary'), btnModeLabel);
      const paintModeBtn = () => {
        const opt = MODE_OPTIONS.find((o) => o.value === this.pageExtractMode) || MODE_OPTIONS[0];
        btnModeLabel.textContent = opt.short;
        btnMode.title = `抽出モード: ${opt.label}`;
        btnMode.className = 'h-10 shrink-0 rounded-full flex items-center justify-center gap-1 px-3 aicx-tap transition bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300';
      };
      paintModeBtn();
      let modePopover = null;
      const onModeDocDown = (e) => {
        if (modePopover && !eventPathIncludes(modePopover, e) && !eventPathIncludes(btnMode, e)) closeModePop();
      };
      const closeModePop = () => {
        if (!modePopover) return;
        modePopover.remove(); modePopover = null;
        btnMode.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', onModeDocDown, true);
      };
      btnMode.addEventListener('click', () => {
        if (modePopover) { closeModePop(); return; }
        modePopover = el('div', {
          class: 'absolute z-20 bottom-full mb-2 left-0 p-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl min-w-[220px]',
          role: 'menu'
        });
        for (const opt of MODE_OPTIONS) {
          const active = opt.value === this.pageExtractMode;
          const item = el('button', {
            class: `w-full text-left text-xs px-3 py-2 rounded flex items-center gap-2 aicx-tap ${active ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-200' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200'}`,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': active ? 'true' : 'false'
          });
          const mark = el('span', { class: 'w-3.5 h-3.5 inline-flex items-center justify-center shrink-0' });
          if (active) mark.appendChild(icon('check', 'w-3.5 h-3.5'));
          item.append(mark, el('span', {}, opt.label));
          item.addEventListener('click', () => {
            if (this.pageExtractMode !== opt.value) {
              this.pageExtractMode = opt.value;
              this._lastInjectedUrl = null;
              paintModeBtn();
            }
            closeModePop();
          });
          modePopover.append(item);
        }
        modeWrap.append(modePopover);
        btnMode.setAttribute('aria-expanded', 'true');
        setTimeout(() => document.addEventListener('pointerdown', onModeDocDown, true), 0);
      });
      modeWrap.append(btnMode);

      // Model picker — compact pill in the action row showing the
      // abbreviated current model. Opening reveals only the models the
      // user has added in Settings; selecting persists globally via
      // Store.settings.model. Placed in the composer area so the popover
      // naturally paints above the messages list.
      const modelBtnWrap = el('div', { class: 'relative shrink-0' });
      const btnModel = el('button', {
        type: 'button',
        class: 'h-10 shrink-0 rounded-full flex items-center justify-center gap-1 px-3 aicx-tap transition bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300',
        'aria-label': 'モデルを選択',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false'
      });
      btnModel.append(icon('bot'));
      const btnModelLabel = el('span', { class: 'text-xs font-medium' }, '');
      btnModel.append(btnModelLabel);
      const paintModelBtn = () => {
        btnModelLabel.textContent = Gemini.abbreviate(Store.settings.model || '');
        btnModel.title = `モデル: ${Store.settings.model || '(未選択)'}`;
      };
      paintModelBtn();
      let modelPopover = null;
      const onModelDocDown = (e) => {
        if (modelPopover && !eventPathIncludes(modelPopover, e) && !eventPathIncludes(btnModel, e)) closeModelPop();
      };
      const closeModelPop = () => {
        if (!modelPopover) return;
        modelPopover.remove(); modelPopover = null;
        btnModel.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', onModelDocDown, true);
      };
      btnModel.addEventListener('click', async () => {
        if (modelPopover) { closeModelPop(); return; }
        modelPopover = el('div', {
          class: 'absolute z-20 bottom-full mb-2 left-0 p-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl max-h-80 overflow-auto w-72',
          role: 'menu'
        });
        modelBtnWrap.append(modelPopover);
        btnModel.setAttribute('aria-expanded', 'true');
        setTimeout(() => document.addEventListener('pointerdown', onModelDocDown, true), 0);

        const models = Store.settings.addedModels || [];
        if (!models.length) {
          modelPopover.append(el('div', { class: 'text-xs text-zinc-500 p-3' }, '使用するモデルが追加されていません。設定画面の「一般」タブから追加してください。'));
          return;
        }
        const current = Store.settings.model || '';
        for (const m of models) {
          const active = m.id === current;
          const item = el('button', {
            type: 'button',
            class: `w-full text-left px-3 py-2 rounded flex items-start gap-2 aicx-tap ${active ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-200' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200'}`,
            role: 'menuitemradio',
            'aria-checked': active ? 'true' : 'false'
          });
          const mark = el('span', { class: 'w-3.5 h-3.5 inline-flex items-center justify-center shrink-0 mt-0.5' });
          if (active) mark.appendChild(icon('check', 'w-3.5 h-3.5'));
          const text = el('div', { class: 'flex-1 min-w-0' });
          text.append(
            el('div', { class: 'text-xs font-medium truncate' }, m.display || m.id),
            el('div', { class: 'text-[10px] text-zinc-500 dark:text-zinc-400 truncate' }, m.id)
          );
          item.append(mark, text);
          item.addEventListener('click', async () => {
            if (Store.settings.model !== m.id) {
              Store.settings.model = m.id;
              await Store.saveSettings();
              paintModelBtn();
              updateTitleSub();
            }
            closeModelPop();
          });
          modelPopover.append(item);
        }
      });
      modelBtnWrap.append(btnModel);

      const btnCtx = el('button', { class: 'w-10 h-10 shrink-0 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 flex items-center justify-center aicx-tap', type: 'button', 'aria-label': 'コンテキストを確認', title: 'AI に送られるページコンテキストをプレビュー' });
      btnCtx.appendChild(icon('search'));
      btnCtx.addEventListener('click', () => this.showContextPreview());

      const btnSend = el('button', { class: 'w-10 h-10 shrink-0 rounded-full bg-indigo-600 text-white flex items-center justify-center disabled:opacity-50 aicx-tap', 'aria-label': '送信' });
      btnSend.appendChild(icon('send'));
      btnSend.addEventListener('click', () => this.send());

      const btnStop = el('button', { class: 'w-10 h-10 shrink-0 rounded-full bg-red-600 text-white flex items-center justify-center aicx-tap hidden', 'aria-label': '停止' });
      btnStop.appendChild(icon('stop'));
      btnStop.addEventListener('click', () => this.stop());

      actionsWrap.append(attachWrap, btnWeb, btnUrlCtx, modeWrap, modelBtnWrap, btnCtx, fileInput, cameraInput);
      btnRow.append(actionsWrap);
      inputRow.append(ta, btnSend, btnStop);
      composer.append(selBar, attBar, inputRow, btnRow);

      sheet.append(resizeHandle, header, list, composer);
      panel.append(overlay, sheet);
      UI.root.appendChild(panel);
      this.panel = panel;
      this.sheet = sheet;
      this.els = { list, ta, btnSend, btnStop, attBar, selBar, titleTop, updateTitleSub };

      // Reflect the tracked page selection in the composer chip, and re-render
      // whenever the user changes their selection while the panel is open.
      this.renderSelectionChip();
      this._selUnsub = Selection.subscribe(() => this.renderSelectionChip());

      // Render initial messages
      this.render();

      // Re-attach to a generation already running for this conversation. The
      // run streams into the same conv object, so render() above already shows
      // the text produced while the sheet was closed and later chunks repaint
      // through the run's own `this.conv === conv` guard — only the composer
      // state needs restoring here.
      this.paintBusy();

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

    // Tears down the sheet ONLY. Any generation for this conversation keeps
    // running in `Runs` and re-attaches if the user opens it again; use the
    // stop button (or `stop()`) to actually cancel.
    close() {
      if (this._focusGuard) {
        document.removeEventListener('focusin', this._focusGuard, true);
        this._focusGuard = null;
      }
      if (this.panel) { this.panel.remove(); this.panel = null; }
      if (this._selUnsub) { try { this._selUnsub(); } catch {} this._selUnsub = null; }
      this.sheet = null;
      this.conv = null;
      // Dropped so nothing paints into the detached tree after this point;
      // an in-flight run's render calls are additionally gated on `this.conv`.
      this.els = null;
      this.attachments = [];
    },

    // Reflect "is this conversation generating right now" in the composer.
    // Driven by the registry rather than a panel-local flag, so reopening a
    // conversation mid-run shows the stop button instead of a send button
    // that would refuse to fire.
    paintBusy() {
      if (!this.els) return;
      const busy = Runs.has(this.conv && this.conv.id);
      this.els.btnSend.classList.toggle('hidden', busy);
      this.els.btnStop.classList.toggle('hidden', !busy);
    },

    renderSelectionChip() {
      const bar = this.els && this.els.selBar;
      if (!bar) return;
      clear(bar);
      const text = Selection.get();
      if (!text) return;
      const chip = el('div', {
        class: 'flex items-start gap-2 p-2 rounded-lg border-l-4 border-indigo-500 bg-indigo-50 dark:bg-indigo-900/40 text-xs'
      });
      const icoWrap = el('div', { class: 'shrink-0 text-indigo-600 dark:text-indigo-300 pt-0.5' });
      icoWrap.appendChild(icon('edit', 'w-3.5 h-3.5'));
      const col = el('div', { class: 'flex-1 min-w-0' });
      col.appendChild(el('div', {
        class: 'text-[10px] uppercase tracking-wider font-semibold text-indigo-700 dark:text-indigo-300'
      }, `選択中のテキスト · ${text.length.toLocaleString()} 文字`));
      const preview = text.length > 160 ? text.slice(0, 160) + '…' : text;
      col.appendChild(el('div', {
        class: 'mt-0.5 text-zinc-700 dark:text-zinc-200 whitespace-pre-wrap break-words line-clamp-3'
      }, preview));
      const dismiss = el('button', {
        class: 'shrink-0 w-6 h-6 rounded-full text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center aicx-tap',
        'aria-label': '選択を外す',
        title: '選択をクリア',
        type: 'button'
      });
      dismiss.appendChild(icon('close', 'w-3 h-3'));
      dismiss.addEventListener('click', () => Selection.clear());
      chip.append(icoWrap, col, dismiss);
      bar.appendChild(chip);
    },

    stop() {
      if (this.conv) Runs.stop(this.conv.id);
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

    async showContextPreview() {
      // Pick which page snapshot the preview reflects:
      //   - toggle ON  → the live current page (what will actually be sent)
      //   - toggle OFF → the conversation's stored pageSnapshot if any
      //                  (captured when the conversation was originally sent),
      //                  so a restored chat shows the page it was about rather
      //                  than whatever page the user happens to be on now.
      //   - otherwise  → fall back to a fresh snapshot
      let snap;
      let snapSource = 'current';
      if (this.pageExtractMode === 'none') {
        // "抽出なし" — do not fetch a fresh snapshot. For restored chats
        // we still show the baked-in snapshot since it is what the model
        // will see on the next user message (same as the old toggle-OFF
        // fallback). For fresh chats with no stored snapshot there is
        // simply nothing to preview.
        if (this.conv && this.conv.pageSnapshot) {
          snap = this.conv.pageSnapshot;
          snapSource = 'stored';
        } else {
          snap = null;
          snapSource = 'skipped';
        }
      } else {
        try {
          snap = await Page.snapshot(this.pageExtractMode);
        } catch (e) {
          UI.toast('コンテキストの取得に失敗しました: ' + (e && e.message || e), 'error');
          return;
        }
      }
      const MODE_LABEL = {
        auto: '自動 (Readability)',
        clean: 'クリーン (chrome 除外)',
        raw: 'ほぼそのまま (HTML)',
        none: '抽出なし (ページを含めない)'
      };
      const modeLabel = MODE_LABEL[(snap && snap.mode) || this.pageExtractMode] || this.pageExtractMode;
      const systemPrompt = Store.resolveSystemPrompt(this.host);
      const promptText = snap ? Page.formatForPrompt(snap) : '';
      // Selection shown in the preview comes from the live tracker (what will
      // actually be attached on the next send), not from the one-shot snapshot
      // which may already have been collapsed by focusing the preview button.
      const trackedSelection = Selection.get() || (snap && snap.selection) || '';

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
      const sourceLabel = snapSource === 'stored'
        ? '保存済み (会話開始時点)'
        : (snapSource === 'skipped' ? '送信されません (抽出なし)' : '現在のページ');
      const statsChildren = [
        kv('ソース', sourceLabel),
        kv('抽出モード', modeLabel)
      ];
      if (snap) {
        statsChildren.push(kv('本文文字数', `${snap.text.length.toLocaleString()} 文字${snap.text.endsWith('...[truncated]') ? ' (打ち切り)' : ''}`));
      }
      statsChildren.push(kv('選択文字数', `${trackedSelection.length.toLocaleString()} 文字`));
      statsChildren.push(kv('添付ファイル', this.attachments.length ? this.attachments.map((a) => a.name).join(', ') : 'なし'));
      const stats = el('div', { class: 'space-y-1 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700' }, statsChildren);
      body.append(section('概要', stats));

      // Page meta (only when a snapshot exists)
      if (snap) {
        body.append(section('ページ情報', el('div', { class: 'space-y-1' }, [
          kv('URL', snap.url),
          kv('Title', snap.title || '(なし)'),
          kv('Description', snap.metaDesc || '(なし)')
        ])));
      }

      // Selection (attached per-message, not embedded in page context)
      if (trackedSelection) body.append(section('選択中のテキスト (次回送信時に添付)', preBlock(trackedSelection)));

      if (snap) {
        // Extracted text
        body.append(section('抽出された本文', preBlock(snap.text)));
      }

      // System prompt
      body.append(section('システムプロンプト', preBlock(systemPrompt || '(なし)')));

      if (snap) {
        // Full prompt (what actually gets sent as context)
        body.append(section('送信される Page Context (整形済み)', preBlock(promptText)));
      }

      // Actions — only shown when there is an actual snapshot to copy.
      if (snap) {
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
      }

      UI.root.appendChild(panel);
    },

    render() {
      const list = this.els.list;
      clear(list);
      // Hide the synthetic "(context received)" ack from the chat; the paired
      // user-side context message is rendered as a compact banner below.
      const visible = this.conv
        ? this.conv.messages.filter((m) => m.role !== 'system' && !(m._synthetic && m.role === 'assistant'))
        : [];
      if (!visible.length) {
        list.appendChild(el('div', { class: 'text-center text-xs text-zinc-500 py-8 whitespace-pre-wrap' },
          this.mode === UserScriptMode.ID
            ? 'このページ向けの Tampermonkey UserScript を作ります。\n作りたい動作を説明してください。\nAI がページを解析し、完成したらインストールボタンを表示します。'
            : 'このページについて質問してみましょう。ページのテキストが文脈として送信されます。'));
      }
      for (const m of visible) {
        const node = this.renderMessage(m);
        if (node) list.appendChild(node);
      }
      list.scrollTop = list.scrollHeight;
    },

    renderMessage(m) {
      // Synthetic page-context injection: render as a compact centered
      // banner instead of a normal chat bubble. Clicking opens the full
      // snapshot in the context preview so the user can inspect what was
      // sent. The paired assistant ack is filtered out in render().
      if (m._synthetic) {
        const label = m._contextTitle || m._contextUrl || 'ページコンテキスト';
        const banner = el('div', { class: 'w-full flex justify-center' });
        const pill = el('div', {
          class: 'inline-flex items-center gap-2 max-w-[90%] px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-[11px] text-zinc-600 dark:text-zinc-300'
        });
        pill.appendChild(icon('summary', 'w-3.5 h-3.5'));
        pill.appendChild(el('span', { class: 'truncate' }, `ページコンテキストを追加: ${label}`));
        banner.appendChild(pill);
        return banner;
      }

      // Tool-result turn (our functionResponse payload). Rendered as audit
      // pills, never as a user bubble — the user did not type this.
      if (m._tool || (m.functionResponses && m.functionResponses.length)) {
        const wrap = el('div', { class: 'w-full' });
        wrap.appendChild(UserScriptMode.renderResponses(m));
        return wrap;
      }

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
        const wrap = el('div', { class: 'flex flex-col items-end gap-1' });
        // Highlighted selection attached at send-time is rendered above the
        // bubble as a quoted excerpt so the user can see what page context
        // they emphasized for this turn.
        if (m.selection) {
          const quote = el('div', {
            class: 'max-w-[85%] border-l-4 border-indigo-500 bg-indigo-50 dark:bg-indigo-900/40 rounded-r-lg px-3 py-2 text-xs'
          });
          quote.appendChild(el('div', {
            class: 'text-[10px] uppercase tracking-wider font-semibold text-indigo-700 dark:text-indigo-300 mb-1'
          }, '選択中のテキスト'));
          const body = el('div', {
            class: 'whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-200'
          });
          body.textContent = m.selection;
          quote.appendChild(body);
          wrap.appendChild(quote);
        }
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
      // Suppress the typing indicator when the turn already produced tool
      // calls — the activity pills below convey progress better than dots.
      const hasCalls = !!(m.functionCalls && m.functionCalls.length);
      const placeholder = (m._pending && !hasCalls)
        ? '<span class="aicx-dot"></span><span class="aicx-dot"></span><span class="aicx-dot"></span>'
        : '';
      const text = m.content || placeholder;
      if (text) {
        const body = el('div', { class: 'aicx-md' });
        body.innerHTML = MD.render(text);
        wrap.appendChild(body);
      }
      if (hasCalls) wrap.appendChild(UserScriptMode.renderCalls(m));
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
      // One generation per conversation. Another conversation may generate
      // concurrently — each run owns its own AbortController and conv object.
      if (this.conv && Runs.has(this.conv.id)) return;
      const text = this.els.ta.value.trim();
      const atts = this.attachments;
      // Allow a selection-only send (empty composer, no files) so the user can
      // ask "what about this?" just by highlighting a passage.
      if (!text && atts.length === 0 && !Selection.get()) return;
      if (!Store.settings.apiKey) { UI.toast('API キーを設定してください', 'error'); SettingsPanel.open(); return; }

      // Lazily create the conversation on first send, snapshotting the page
      // URL/title at creation time so the chat header keeps showing the
      // original page even after navigation or when reopened from history.
      if (!this.conv) {
        this.conv = Store.newConversation(this.host, this.mode === UserScriptMode.ID ? UserScriptMode.ID : undefined);
        this.conv.pageUrl = location.href;
        this.conv.pageTitle = document.title || '';
        if (this.els && this.els.updateTitleSub) this.els.updateTitleSub();
      }

      // Snapshot locals so this run isn't affected if user closes/opens another panel mid-stream
      const host = this.host;
      const conv = this.conv;
      const els = this.els;
      const firstRealUserMsg = conv.messages.filter((m) => m.role === 'user' && !m._synthetic).length === 0;

      // Decide whether to inject a page-context snapshot pair on this turn.
      //
      // Extraction mode ≠ 'none': snapshot the current page, *unless* we've
      //   already injected this same URL during this panel session — that
      //   keeps same-page follow-ups from re-paying the context token cost.
      //   When the user navigates to a different page (URL changes) or
      //   switches the mode from 'none' to an extracting mode (any mode
      //   change clears _lastInjectedUrl), the next send triggers a fresh
      //   injection. Injections are *additive*: they're persisted as
      //   synthetic message pairs inside conv.messages (not replacing prior
      //   context), so the model sees every page the user chose to share,
      //   in chronological order.
      //
      // Extraction mode = 'none': only inject on the very first real
      //   message of a conversation, and only if a stored snapshot is
      //   available — lets a restored chat re-use its conversation-time
      //   page without the user having to change the extraction mode.
      let pendingSnap = null;
      if (this.pageExtractMode !== 'none') {
        const currentUrl = location.href;
        if (this._lastInjectedUrl !== currentUrl) {
          pendingSnap = await Page.snapshot(this.pageExtractMode);
          this._lastInjectedUrl = currentUrl;
        }
      } else if (firstRealUserMsg && conv.pageSnapshot) {
        pendingSnap = conv.pageSnapshot;
      }
      if (pendingSnap) {
        // Synthetic pair: a "user" message carrying the formatted context
        // and an "assistant" ack. _synthetic flags them so the renderer
        // shows a compact banner instead of a normal bubble; the API
        // payload builder below emits them verbatim.
        conv.messages.push({
          id: uid(), role: 'user', _synthetic: true,
          _contextUrl: pendingSnap.url, _contextTitle: pendingSnap.title,
          content: Page.formatForPrompt(pendingSnap), createdAt: now()
        });
        conv.messages.push({
          id: uid(), role: 'assistant', _synthetic: true,
          content: '(context received)', createdAt: now()
        });
        // Keep the conv's latest snapshot handy for the context preview
        // (and for the toggle-OFF fallback in future sessions).
        conv.pageSnapshot = pendingSnap;
      }

      // Capture the user's page selection at send-time (tracked by the
      // selectionchange listener since focusing the composer on mobile
      // collapses window.getSelection()). The selection becomes part of the
      // message itself — shown as a quote above the bubble, and emphasized
      // in the outgoing API payload. Consumed on send, so the next message
      // requires a fresh selection unless the user changes/keeps it.
      const selectedText = Selection.get();
      const userMsg = {
        id: uid(), role: 'user', content: text, createdAt: now(),
        attachments: atts.length ? atts.map(({ id, name, mimeType, dataUrl }) => ({ id, name, mimeType, dataUrl })) : undefined,
        selection: selectedText || undefined
      };
      Selection.clear();
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

      const aborter = new AbortController();
      const run = { aborter, host };
      Runs.add(conv.id, run);
      this.paintBusy();
      let failed = false;

      const isUserscript = this.mode === UserScriptMode.ID;
      const systemPrompt = isUserscript ? UserScriptMode.systemPrompt() : Store.resolveSystemPrompt(host);

      // The assistant message currently being streamed into. Each tool round
      // finishes one and opens the next, so `pending` — not `asstMsg` — is
      // what the error handler must annotate.
      let pending = asstMsg;

      try {
        // Google Search grounding (requires Gemini 2.0+ for `googleSearch`; 1.5 uses `googleSearchRetrieval`)
        // URL Context asks Gemini to fetch and read URLs present in the prompt.
        // It's a Gemini 2.x tool, so we skip it on 1.x and on 1.x only the
        // legacy retrieval tool is offered. UserScript mode adds our local
        // function declarations on top (unsupported on 1.x, hence the guard).
        const modelId = Store.settings.model || '';
        const isLegacy = /\b1\.[05]\b/.test(modelId);
        let tools;
        if (isLegacy) {
          if (this.webGrounding) tools = [{ googleSearchRetrieval: {} }];
          if (isUserscript) UI.toast('UserScript モードは Gemini 2.0 以降のモデルが必要です', 'error');
        } else {
          const t = [];
          if (this.webGrounding) t.push({ googleSearch: {} });
          if (this.urlContext) t.push({ urlContext: {} });
          if (isUserscript) t.push({ functionDeclarations: UserScriptMode.toolDeclarations() });
          if (t.length) tools = t;
        }
        // Agent loop: stream a turn, run whatever tools it asked for, feed the
        // results back, repeat. A turn with no function calls ends the loop —
        // which is every turn outside UserScript mode, so plain chat still
        // makes exactly one pass through here.
        //
        // The round budget is read once per send() so that changing the
        // setting mid-run can't move the goalposts under an in-flight loop.
        const maxRounds = UserScriptMode.maxToolRounds();
        let rounds = 0;
        while (true) {
          const apiMessages = this._buildApiMessages(conv, pending);
          let acc = '';
          let calls = [];
          let grounding = null;
          // Retry on MALFORMED_FUNCTION_CALL — a sporadic Gemini 2.5 fault (the
          // model emits a stray function-call token even with no tools opted in),
          // not a deterministic refusal, so re-running the identical request
          // usually succeeds. The fault can fire midway through the stream, so
          // each attempt discards whatever partial text AND partial tool calls
          // were already collected and restarts the turn from scratch.
          const MAX_ATTEMPTS = 3;
          let attempts = 0;
          while (true) {
            acc = '';
            calls = [];
            grounding = null;
            pending.content = '';
            pending._pending = true;
            delete pending.thoughtSignature;
            if (this.conv === conv) this.renderLastAssistant();
            const stream = Gemini.streamGenerate({
              apiKey: Store.settings.apiKey,
              model: Store.settings.model,
              messages: apiMessages,
              systemPrompt,
              tools,
              onMetadata: (meta) => { grounding = meta; },
              // The signature must be stored alongside the call it came with:
              // Gemini 3 rejects the next request outright if a replayed
              // functionCall part has lost it.
              onFunctionCall: (fc, sig) => { calls.push({ id: fc.id, name: fc.name, args: fc.args || {}, thoughtSignature: sig }); },
              onThoughtSignature: (sig) => { pending.thoughtSignature = sig; },
              signal: aborter.signal
            });
            try {
              for await (const chunk of stream) {
                acc += chunk;
                pending.content = acc;
                pending._pending = false;
                if (this.conv === conv) this.renderLastAssistant();
              }
              break;
            } catch (err) {
              if (err && err.retryable && attempts < MAX_ATTEMPTS - 1 && !aborter.signal.aborted) {
                attempts++;
                // Brief backoff so a transient server-side hiccup can clear.
                await new Promise((r) => setTimeout(r, 400 * attempts));
                continue;
              }
              throw err;
            }
          }
          pending._pending = false;

          // Append grounding sources (web citations) if any.
          // Rendered as <details> so the list is collapsed by default — it can
          // get long and dominate the bubble otherwise.
          if (grounding && grounding.groundingChunks && grounding.groundingChunks.length) {
            const items = grounding.groundingChunks
              .map((c) => (c.web && c.web.uri) ? `<li><a href="${esc(c.web.uri)}" target="_blank" rel="noopener noreferrer">${esc(c.web.title || c.web.uri)}</a></li>` : null)
              .filter(Boolean);
            if (items.length) {
              const html = `\n\n<details class="aicx-sources"><summary>ソース (${items.length} 件)</summary>\n<ol>\n${items.join('\n')}\n</ol>\n</details>`;
              pending.content = (pending.content || '') + html;
              if (this.conv === conv) this.renderLastAssistant();
            }
          }

          if (!calls.length) break;

          pending.functionCalls = calls;
          if (this.conv === conv) this.render();

          // Run the tools sequentially: several of them open modals, and two
          // competing dialogs would be unusable.
          const responses = [];
          for (const call of calls) {
            const response = await UserScriptMode.execute(call, { conv, host, panel: this });
            responses.push({ id: call.id, name: call.name, response });
          }
          conv.messages.push({
            id: uid(), role: 'user', _tool: true,
            functionResponses: responses, createdAt: now()
          });
          Store.upsertConversation(host, conv);
          Store.saveDomains();

          rounds++;
          if (rounds >= maxRounds) {
            conv.messages.push({
              id: uid(), role: 'assistant', createdAt: now(),
              content: `_(ツール実行が上限 ${maxRounds} 回に達したため中断しました。「続けて」と送れば再開できます。上限は設定 → プロンプト から変更できます。)_`
            });
            if (this.conv === conv) this.render();
            break;
          }

          pending = { id: uid(), role: 'assistant', content: '', createdAt: now(), _pending: true };
          conv.messages.push(pending);
          if (this.conv === conv) this.render();
        }
      } catch (err) {
        pending._pending = false;
        const aborted = err && err.name === 'AbortError';
        failed = !aborted;
        if (aborted) {
          pending.content = (pending.content || '') + '\n\n_(停止しました)_';
        } else if (err && err.code === 'MALFORMED_FUNCTION_CALL') {
          // Exhausted retries on the sporadic Gemini fault — give an
          // actionable message instead of the raw finishReason marker.
          pending.content = '**エラー:** 応答の生成に失敗しました（Gemini の一時的な不具合により中断されました）。もう一度送信するか、別のモデルをお試しください。';
        } else {
          pending.content = `**エラー:** ${esc(err && err.message || String(err))}`;
        }
        if (this.conv === conv) this.render();
      } finally {
        Runs.remove(conv.id, run);
        if (this.conv === conv) {
          // Panel still showing this conversation — just restore the composer.
          this.paintBusy();
        } else if (!aborter.signal.aborted) {
          // Finished while the user was elsewhere. Without this the result
          // would land silently and they would have no reason to come back.
          const label = (conv.title || '会話').slice(0, 24);
          UI.toast(failed ? `「${label}」の生成が失敗しました` : `「${label}」の生成が完了しました`, failed ? 'error' : 'success');
        }
        Store.upsertConversation(host, conv);
        await Store.saveDomains();
        ScheduleBackup.mark();
      }
    },

    // Flatten conv.messages into the shape Gemini.buildContents expects.
    // Synthetic page-context pairs and tool call/response turns are part of
    // that stream, so they flow to the model in the same chronological
    // position the user (or the agent) created them — a later-injected page
    // appears AFTER earlier conversation turns, not collapsed to the front.
    _buildApiMessages(conv, exclude) {
      const out = [];
      for (const m of conv.messages) {
        if (m === exclude) continue;
        if (m.functionResponses && m.functionResponses.length) {
          out.push({ role: 'user', functionResponses: m.functionResponses });
          continue;
        }
        let content = m.content;
        // Prepend the highlighted page selection as emphasized context so the
        // model focuses its reply on the quoted passage. Kept per-message
        // (not collapsed into the first-message page context) so follow-up
        // turns can reference fresh selections the user makes mid-chat.
        if (m.role === 'user' && !m._synthetic && m.selection) {
          const quoted = `The user has highlighted the following passage on the page. Treat it as the primary focus of this turn:\n"""\n${m.selection}\n"""`;
          content = content ? `${quoted}\n\n${content}` : `${quoted}\n\nこの選択箇所について解説してください。`;
        }
        out.push({
          role: m.role, content, attachments: m.attachments,
          functionCalls: m.functionCalls, thoughtSignature: m.thoughtSignature
        });
      }
      return out;
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
        class: 'relative bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 w-full sm:max-w-4xl sm:mx-auto sm:my-4 sm:rounded-2xl rounded-t-2xl shadow-2xl flex flex-col aicx-enter-sheet aicx-full sm:h-[calc(100dvh-2em)] overflow-hidden',
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
      const isUserscript = c.mode === UserScriptMode.ID;
      const row = el('div', { class: 'flex items-center gap-3 p-4 hover:bg-zinc-50 dark:hover:bg-zinc-800/50' });
      const badge = el('div', {
        class: `shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${isUserscript ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500'}`,
        title: isUserscript ? 'UserScript 作成モード' : 'AI チャット'
      });
      badge.appendChild(icon(isUserscript ? 'code' : 'chat', 'w-4 h-4'));
      const main = el('button', { class: 'flex-1 min-w-0 text-left aicx-tap' });
      const snippet = (c.messages.find((m) => m.role === 'user' && !m._synthetic && !m._tool) || {}).content || '';
      main.append(
        el('div', { class: 'text-sm font-medium truncate' }, c.title || snippet.slice(0, 50) || '(無題)'),
        el('div', { class: 'text-xs text-zinc-500 truncate' }, `${fmtDate(c.updatedAt || c.createdAt)} · ${c.messages.filter((m) => m.role !== 'system' && !m._synthetic && !m._tool).length} msg`)
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
      row.append(badge, main, del);
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
      const onDoc = (e) => { if (!eventPathIncludes(wrap, e)) closePop(); };
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
    sheet({ title, onBack, onClose, leading, trailing, subheader, maxWidth = 'sm:max-w-5xl' }) {
      const panel = el('div', { class: 'fixed inset-0 aicx-panel aicx-enter-fade flex items-end sm:items-stretch justify-center', style: { zIndex: 30 } });
      const overlay = el('div', { class: 'absolute inset-0 bg-black/30' });
      overlay.addEventListener('click', () => { (onBack || onClose || (() => panel.remove()))(); });
      const sheet = el('div', {
        class: `relative bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 w-full ${maxWidth} sm:mx-auto sm:my-4 sm:rounded-2xl rounded-t-2xl shadow-2xl flex flex-col aicx-enter-sheet aicx-full sm:h-[calc(100dvh-2em)] overflow-hidden`,
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
          body.append(this.sectionGlobalPrompt(), this.sectionUserscriptPrompt(), this.sectionPageExtract(), this.sectionGlobalTemplates());
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
      const keyInput = Form.input(Store.settings.apiKey, (v) => { Store.settings.apiKey = v.trim(); Store.saveSettings(); renderAvailable(); }, { type: 'password', placeholder: 'AIza...' });
      keyWrap.append(keyInput);
      keyWrap.append(el('p', { class: 'text-[11px] text-zinc-500 mt-1' }, [
        'キーは ',
        (() => { const a = el('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener', class: 'underline text-indigo-600 dark:text-indigo-400' }, 'Google AI Studio'); return a; })(),
        ' で取得できます。'
      ]));
      box.append(keyWrap);

      const modelWrap = el('div', { class: 'space-y-2' });
      modelWrap.append(Form.label('使用するモデル'));
      modelWrap.append(el('p', { class: 'text-[11px] text-zinc-500' }, '追加したモデルだけがチャット画面のモデル選択に表示されます。チェックの付いた行が現在のアクティブモデルです。'));

      const listWrap = el('div', { class: 'space-y-1' });
      modelWrap.append(listWrap);

      const addRow = el('div', { class: 'flex gap-2 pt-1' });
      const addSel = el('select', { class: 'flex-1 min-w-0 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg text-sm px-3 py-2' });
      const addBtn = Form.btn('追加', () => addSelected(), 'bg-indigo-600 text-white shrink-0');
      addBtn.prepend(icon('plus', 'w-3 h-3 mr-1 inline'));
      const refreshBtn = Form.btn('再取得', () => renderAvailable(true), 'bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100 shrink-0');
      refreshBtn.prepend(icon('refresh', 'w-3 h-3 mr-1 inline'));
      addRow.append(addSel, addBtn, refreshBtn);
      modelWrap.append(addRow);

      const hint = el('p', { class: 'text-[11px] text-zinc-500' }, '');
      modelWrap.append(hint);
      box.append(modelWrap);

      const renderAdded = () => {
        clear(listWrap);
        const added = Store.settings.addedModels || [];
        if (!added.length) {
          listWrap.append(el('p', { class: 'text-xs text-zinc-500 px-3 py-3 border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg text-center' }, 'モデルが追加されていません。下のドロップダウンから選んで「追加」してください。'));
          return;
        }
        for (const m of added) {
          const active = Store.settings.model === m.id;
          const row = el('div', { class: 'flex items-center gap-2 p-2 rounded-lg border border-zinc-200 dark:border-zinc-700' });
          const radio = el('button', {
            type: 'button',
            class: `w-7 h-7 shrink-0 rounded-full flex items-center justify-center aicx-tap ${active ? 'bg-indigo-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200'}`,
            'aria-label': active ? 'アクティブなモデル' : 'アクティブにする',
            title: active ? 'アクティブなモデル' : 'アクティブにする'
          });
          if (active) radio.appendChild(icon('check', 'w-4 h-4'));
          radio.addEventListener('click', async () => {
            if (Store.settings.model === m.id) return;
            Store.settings.model = m.id;
            await Store.saveSettings();
            renderAdded();
          });
          const text = el('div', { class: 'flex-1 min-w-0' });
          text.append(
            el('div', { class: 'text-sm font-medium truncate' }, m.display || m.id),
            el('div', { class: 'text-[11px] text-zinc-500 dark:text-zinc-400 truncate' }, m.id)
          );
          const del = el('button', { class: 'w-9 h-9 shrink-0 rounded-lg text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30 flex items-center justify-center aicx-tap', type: 'button', 'aria-label': 'モデルを削除' });
          del.appendChild(icon('trash', 'w-4 h-4'));
          del.addEventListener('click', async () => {
            const list = Store.settings.addedModels || [];
            const idx = list.findIndex((x) => x.id === m.id);
            if (idx >= 0) list.splice(idx, 1);
            if (Store.settings.model === m.id) {
              Store.settings.model = list[0] ? list[0].id : '';
            }
            await Store.saveSettings();
            renderAdded();
            renderAvailable();
          });
          row.append(radio, text, del);
          listWrap.append(row);
        }
      };

      const addSelected = async () => {
        const id = addSel.value;
        if (!id || !this.models) return;
        const m = this.models.find((x) => x.id === id);
        if (!m) return;
        Store.settings.addedModels = Store.settings.addedModels || [];
        if (Store.settings.addedModels.some((x) => x.id === id)) return;
        Store.settings.addedModels.push({ id: m.id, display: m.display });
        if (!Store.settings.model) Store.settings.model = m.id;
        await Store.saveSettings();
        renderAdded();
        renderAvailable();
      };

      const renderAvailable = async (force = false) => {
        if (!Store.settings.apiKey) {
          clear(addSel);
          addSel.appendChild(el('option', { value: '' }, '(API キー未設定)'));
          addSel.disabled = true;
          addBtn.disabled = true;
          refreshBtn.disabled = true;
          hint.textContent = 'API キーを入力するとモデル一覧を取得できます。';
          return;
        }
        refreshBtn.disabled = false;
        if (!this.models || force) {
          addSel.disabled = true;
          addBtn.disabled = true;
          clear(addSel);
          addSel.appendChild(el('option', { value: '' }, '取得中...'));
          hint.textContent = 'モデル一覧を取得中...';
          try {
            this.models = await Gemini.listModels(Store.settings.apiKey);
            hint.textContent = `${this.models.length} 件のモデルを取得しました。`;
          } catch (e) {
            hint.textContent = 'モデル一覧の取得に失敗しました: ' + (e && e.message || e);
            this.models = [];
          }
        }
        clear(addSel);
        const addedIds = new Set((Store.settings.addedModels || []).map((x) => x.id));
        const available = (this.models || []).filter((m) => !addedIds.has(m.id));
        if (!available.length) {
          addSel.appendChild(el('option', { value: '' }, '(追加できるモデルはありません)'));
          addSel.disabled = true;
          addBtn.disabled = true;
        } else {
          for (const m of available) {
            addSel.appendChild(el('option', { value: m.id }, `${m.display} (${m.id})`));
          }
          addSel.disabled = false;
          addBtn.disabled = false;
        }
      };

      renderAdded();
      renderAvailable();

      return box;
    },

    sectionGlobalPrompt() {
      const box = el('section', { class: 'space-y-2' });
      box.append(Form.sectionTitle('グローバル システムプロンプト'));
      box.append(el('p', { class: 'text-xs text-zinc-500' }, '全ドメインで共通して使われます。ドメインごとの上書きは「ドメイン」タブから行えます。'));
      box.append(Form.textarea(Store.settings.globalSystemPrompt, (v) => { Store.settings.globalSystemPrompt = v; Store.saveSettings(); }, 5));
      return box;
    },

    sectionUserscriptPrompt() {
      const box = el('section', { class: 'space-y-2' });
      box.append(Form.sectionTitle('UserScript 作成モード システムプロンプト'));
      box.append(el('p', { class: 'text-xs text-zinc-500' }, 'メニューの「新規 UserScript」から始めたチャットで使われます。空欄なら組み込みの既定プロンプトが使われます。現在のページの URL・タイトル・推奨 @match は送信時に自動で追記されます。'));
      const ta = Form.textarea(Store.settings.userscriptSystemPrompt, (v) => { Store.settings.userscriptSystemPrompt = v; Store.saveSettings(); }, 6);
      ta.setAttribute('placeholder', '(空欄 = 既定のプロンプトを使用)');
      box.append(ta);
      const row = el('div', { class: 'flex flex-wrap gap-2' });
      row.append(Form.btn('既定プロンプトを読み込む', () => {
        ta.value = UserScriptMode.DEFAULT_SYSTEM_PROMPT;
        Store.settings.userscriptSystemPrompt = ta.value;
        Store.saveSettings();
      }, 'bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100'));
      row.append(Form.btn('既定に戻す (空欄)', () => {
        ta.value = '';
        Store.settings.userscriptSystemPrompt = '';
        Store.saveSettings();
      }, 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200'));
      box.append(row);

      const roundsWrap = el('div', { class: 'pt-2' });
      roundsWrap.append(Form.label('ツール実行の上限 (1 回の送信あたり)'));
      const roundsInput = Form.input(UserScriptMode.maxToolRounds(), (v) => {
        const n = parseInt(v, 10);
        Store.settings.userscriptMaxToolRounds =
          Number.isFinite(n) && n >= UserScriptMode.MIN_TOOL_ROUNDS
            ? Math.min(n, UserScriptMode.MAX_TOOL_ROUNDS_CAP)
            : DEFAULT_SETTINGS.userscriptMaxToolRounds;
        Store.saveSettings();
      }, {
        type: 'number', min: String(UserScriptMode.MIN_TOOL_ROUNDS),
        max: String(UserScriptMode.MAX_TOOL_ROUNDS_CAP), step: '1', inputmode: 'numeric'
      });
      roundsWrap.append(roundsInput);
      roundsWrap.append(el('p', { class: 'text-[11px] text-zinc-500 mt-1' },
        `AI が 1 回の送信で「ページを調べる → コードを書く」を何往復できるかの上限です。上限に達すると一旦停止し、「続けて」と送れば再開できます。複雑なスクリプトほど多く必要になります。空または無効な値は既定 (${DEFAULT_SETTINGS.userscriptMaxToolRounds}) を使います。最大 ${UserScriptMode.MAX_TOOL_ROUNDS_CAP}。`));
      box.append(roundsWrap);

      return box;
    },

    sectionPageExtract() {
      const box = el('section', { class: 'space-y-2' });
      box.append(Form.sectionTitle('ページ本文の抽出方法'));
      box.append(el('p', { class: 'text-xs text-zinc-500' }, 'AI に送るページのコンテキスト抽出方法を選びます。ドメインごとに個別設定することもできます。'));
      const opts = [
        { value: 'auto', label: '自動 (Readability で本文抽出 · 推奨)' },
        { value: 'clean', label: 'クリーン (ヘッダー/ナビ/フッター/サイドバー等を除外)' },
        { value: 'raw', label: 'ほぼそのまま (HTML · スクリプト/スタイル/装飾属性のみ除外)' },
        { value: 'none', label: '抽出なし (ページをコンテキストに含めない)' }
      ];
      box.append(Form.select(opts, Store.settings.pageExtractMode || 'auto', (v) => {
        Store.settings.pageExtractMode = v;
        Store.saveSettings();
      }));

      const limitWrap = el('div', { class: 'pt-2' });
      limitWrap.append(Form.label('ページコンテキストの取り込み上限 (文字数)'));
      const current = Number(Store.settings.pageContextMaxChars);
      const initial = Number.isFinite(current) && current > 0 ? current : DEFAULT_SETTINGS.pageContextMaxChars;
      const limitInput = Form.input(initial, (v) => {
        const n = parseInt(v, 10);
        Store.settings.pageContextMaxChars = Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.pageContextMaxChars;
        Store.saveSettings();
      }, { type: 'number', min: '1', step: '1000', inputmode: 'numeric' });
      limitWrap.append(limitInput);
      limitWrap.append(el('p', { class: 'text-[11px] text-zinc-500 mt-1' }, `ページから抽出した本文をこの文字数で打ち切ります。空または無効な値はデフォルト (${DEFAULT_SETTINGS.pageContextMaxChars.toLocaleString()}) を使います。`));
      box.append(limitWrap);

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
          const urlChk = Form.checkbox('URL Context を有効にする', !!t.urlContext, async (v) => { t.urlContext = v; await Store.saveSettings(); });
          row.append(head, ta, webChk, urlChk);
          list.append(row);
        }
        if (!tpls.length) list.append(el('p', { class: 'text-xs text-zinc-500' }, 'テンプレートはまだありません。'));
      };
      render();
      const addBtn = Form.btn('+ テンプレートを追加', async () => {
        tpls.push({ id: uid(), icon: 'template', name: '新規テンプレート', prompt: '', webSearch: false, urlContext: false });
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

      // Bulk action: delete all conversation history across every domain,
      // while keeping templates / system prompt overrides / settings intact.
      const totals = Object.values(Store.domains).reduce((a, d) => ({
        convs: a.convs + ((d.conversations || []).length),
        domains: a.domains + ((d.conversations || []).length ? 1 : 0)
      }), { convs: 0, domains: 0 });
      const bulkWrap = el('div', { class: 'pt-4 mt-2 border-t border-zinc-200 dark:border-zinc-800 space-y-2' });
      bulkWrap.append(el('p', { class: 'text-xs text-zinc-500' },
        totals.convs
          ? `全ドメインの会話履歴: ${totals.convs.toLocaleString()} 件 (${totals.domains} ドメイン)`
          : '会話履歴はまだありません。'
      ));
      const bulkBtn = Form.btn('全ドメインの会話履歴を一括削除', async () => {
        if (!totals.convs) return;
        if (!await UI.confirm(`全 ${totals.domains} ドメインの会話履歴 (${totals.convs.toLocaleString()} 件) をすべて削除します。テンプレート・プロンプト上書き・その他設定は残ります。続行しますか?`)) return;
        for (const host of Object.keys(Store.domains)) {
          if (Store.domains[host]) Store.domains[host].conversations = [];
        }
        // After the wipe, drop any domain entry whose templates / prompt
        // override / extract-mode are also empty — otherwise domains that
        // existed only to hold now-deleted history would linger forever in
        // the domain list.
        const pruned = Store.pruneEmptyDomains();
        await Store.saveDomains();
        const msg = pruned
          ? `${totals.convs.toLocaleString()} 件の会話履歴を削除しました (空ドメイン ${pruned} 件も削除)`
          : `${totals.convs.toLocaleString()} 件の会話履歴を削除しました`;
        UI.toast(msg, 'success');
        this.close();
        this.open();
      }, 'bg-red-600 text-white w-full disabled:opacity-50');
      if (!totals.convs) bulkBtn.disabled = true;
      bulkWrap.append(bulkBtn);
      box.append(bulkWrap);

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
        { value: 'raw', label: 'ほぼそのまま (HTML · スクリプト/スタイル/装飾属性のみ除外)' },
        { value: 'none', label: '抽出なし (ページをコンテキストに含めない)' }
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
          const urlChk = Form.checkbox('URL Context を有効にする', !!t.urlContext, async (v) => { t.urlContext = v; await Store.saveDomains(); });
          row.append(head, ta, webChk, urlChk);
          list.append(row);
        }
        if (!dom.templates.length) list.append(el('p', { class: 'text-xs text-zinc-500' }, 'テンプレートはまだありません。'));
      };
      render();
      const addBtn = Form.btn('+ テンプレートを追加', async () => {
        dom.templates.push({ id: uid(), icon: 'template', name: '新規テンプレート', prompt: '', webSearch: false, urlContext: false });
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
          const preview = (c.messages.find((m) => m.role === 'user' && !m._synthetic) || {}).content || '';
          main.append(
            el('div', { class: 'text-sm font-medium truncate' }, c.title || preview.slice(0, 50) || '(無題)'),
            el('div', { class: 'text-xs text-zinc-500 truncate' }, `${fmtDate(c.updatedAt || c.createdAt)} · ${c.messages.filter((m) => m.role !== 'system' && !m._synthetic).length} msg`)
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
    // Styles ship as a precompiled CSS string injected into a Shadow Root,
    // so there is no runtime class scan, no MutationObserver on the host
    // document, and no network fetch for a styling library. The large
    // utility sheet (`TAILWIND_CSS`) is deferred until the FAB is first
    // clicked — only the tiny `BASE_CSS` runs at startup, so pages the
    // user never engages with — Speedometer, benchmarks, embedded third-
    // party frames — pay essentially zero runtime cost from the overlay,
    // and the host page's CSS is fully insulated from overlay styles (and
    // vice versa).
    UI.init();
    Selection.init();
    OverlayButton.init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }
})();
