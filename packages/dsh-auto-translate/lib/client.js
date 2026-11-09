/**
 * Auto-translate for DeepSeek Harness — browser half.
 *
 * A floating, always-on-top toggle (off by default) starts a MutationObserver
 * over the whole document. Text nodes are translated through a third-party
 * service and can always be restored to the originals by switching the toggle
 * off. Services: Google (keyless gtx endpoint), Lingva (keyless proxy), DeepL
 * (free API key entered by the user). The state, choice of service and key live
 * in localStorage; a per-service cache keeps repeat renders offline-cheap.
 * Elements marked data-dsh-at-skip, code/pre/inputs and already-ru text stay
 * untouched.
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-translate',
  factory(require) {
    const module = { exports: {} };

    /** Services this plugin needs from the client tree (locale is a cheap guarantee of late loading order). */
    const inject = ['locale'];

    /** Storage keys and defaults. */
    const LS = {
      enabled: 'dsh-auto-translate.enabled',
      service: 'dsh-auto-translate.service',
      key: 'dsh-auto-translate.key',
    };
    const DEFAULT_SERVICE = 'mymemory';
    const SERVICES = ['mymemory', 'google', 'lingva', 'deepl'];
    const TARGET = 'ru';

    /** Elements whose text must never be translated. */
    // Переводим всё видимое: code/pre/kbd тоже. Технические теги исключены.
    const SKIP_TAGS = new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'TEXTAREA',
      'INPUT', 'SELECT', 'CANVAS', 'MATH', 'OBJECT', 'EMBED',
    ]);
    const MAX_NODE_CHARS = 4500;
    const CONCURRENCY = 5;
    const FAILURE_LIMIT = 5;

    const state = {
      observer: null,
      queue: new Set(),
      pumpRunning: false,
      pending: 0,
      originals: new Map(),   // textNode -> original text (for switch-off restore)
      applied: new Map(),     // textNode -> last applied text (skip unchanged nodes)
      cache: new Map(),       // service + '\u0000' + text -> translated text
      failures: new Map(),    // service -> consecutive failures
      timer: 0,
      decay: 0,
      button: null,
      status: 'off',
      attrTargets: new Set(),  // {el, attr, value}
      attrApplied: new WeakMap(),
    };

    const getString = (key, fallback) => {
      try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
    };
    const setString = (key, value) => {
      try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
    };
    const currentService = () => {
      const service = getString(LS.service, DEFAULT_SERVICE);
      return SERVICES.includes(service) ? service : DEFAULT_SERVICE;
    };

    /** Simple script-based detection: do not translate text already written in Cyrillic. */
    function looksTarget(text) {
      const letters = text.replace(/[^\p{L}]/gu, '');
      if (!letters) return true;
      let cyr = 0;
      for (const ch of letters) if (/\p{Script=Cyrillic}/u.test(ch)) cyr += 1;
      return cyr / letters.length > 0.5;
    }

    function isSkippable(node) {
      let cur = node;
      while (cur && cur !== document.body) {
        if (cur.nodeType === 1) {
          if (SKIP_TAGS.has(cur.tagName)) return true;
          if (cur.isContentEditable) return true;
          if (cur.getAttribute?.('aria-hidden') === 'true') return true;
          if (cur.getAttribute?.('data-dsh-at-skip') !== null) return true;
        }
        cur = cur.parentNode;
      }
      return false;
    }

    function isMeaningful(text) {
      return typeof text === 'string'
        && text.trim().length >= 2
        && text.trim().length <= MAX_NODE_CHARS
        && !/^\s*[\d.,:%\-–—\s()/#№*+«»"'\[\]]+\s*$/.test(text);
    }

    // --- adapters -----------------------------------------------------------

    /** MyMemory allows ~500 bytes per request: split long strings on soft boundaries. */
    function splitChunks(text, limit) {
      if (text.length <= limit) return [text];
      const chunks = [];
      let rest = text;
      while (rest.length > limit) {
        let cut = rest.lastIndexOf('. ', limit);
        if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
        if (cut < limit * 0.5) cut = limit;
        chunks.push(rest.slice(0, cut + 1));
        rest = rest.slice(cut + 1).replace(/^\s+/, '');
      }
      if (rest) chunks.push(rest);
      return chunks;
    }

    async function translateMymemory(text) {
      const parts = splitChunks(text, 480);
      const out = [];
      for (const part of parts) {
        const res = await fetch('https://api.mymemory.translated.net/get?q='
          + encodeURIComponent(part) + '&langpair=en|ru');
        if (!res.ok) throw new Error('mymemory ' + res.status);
        const data = await res.json();
        const translated = data?.responseData?.translatedText;
        if (typeof translated !== 'string' || (data?.responseStatus ?? 200) !== 200) {
          throw new Error('mymemory: ' + (data?.responseDetails || 'no translation'));
        }
        out.push(translated);
      }
      return out.join(' ') || text;
    }

    async function translateGoogle(text) {
      const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='
        + TARGET + '&dt=t&q=' + encodeURIComponent(text);
      const res = await fetch(url);
      if (!res.ok) throw new Error('google ' + res.status);
      const data = await res.json();
      return (data?.[0] ?? []).map((part) => part?.[0] ?? '').join('') || text;
    }

    async function translateLingva(text) {
      const res = await fetch('https://lingva.ml/api/v1/auto/' + TARGET + '/' + encodeURIComponent(text));
      if (!res.ok) throw new Error('lingva ' + res.status);
      const data = await res.json();
      return data?.translation ?? text;
    }

    async function translateDeepl(text) {
      const key = getString(LS.key, '').trim();
      if (!key) throw new Error('deepl: no key (правый клик по кнопке)');
      const res = await fetch('https://api-free.deepl.com/v2/translate', {
        method: 'POST',
        headers: { 'Authorization': 'DeepL-Auth-Key ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: [text], target_lang: TARGET.toUpperCase() }),
      });
      if (!res.ok) throw new Error('deepl ' + res.status);
      const data = await res.json();
      return data?.translations?.[0]?.text ?? text;
    }

    const ADAPTERS = { mymemory: translateMymemory, google: translateGoogle, lingva: translateLingva, deepl: translateDeepl };

    /** Translate one string through the chosen service, falling back to the reachable keyless ones. */
    async function translateText(text, service) {
      const chain = service === 'deepl'
        ? ['deepl', 'mymemory', 'google', 'lingva']
        : service === 'google'
          ? ['google', 'mymemory', 'lingva']
          : service === 'lingva'
            ? ['lingva', 'mymemory', 'google']
            : ['mymemory', 'google', 'lingva'];
      for (const name of chain) {
        const hit = state.cache.get(name + '\u0000' + text);
        if (hit !== undefined) return hit;
      }
      let lastError = null;
      for (const name of chain) {
        if ((state.failures.get(name) ?? 0) >= FAILURE_LIMIT) continue;
        try {
          const translated = await ADAPTERS[name](text);
          if (typeof translated !== 'string' || translated.trim() === '') throw new Error(name + ': empty');
          rememberCache(name + '\u0000' + text, translated);
          state.failures.set(name, 0);
          return translated;
        } catch (error) {
          state.failures.set(name, (state.failures.get(name) ?? 0) + 1);
          lastError = error;
        }
      }
      if (lastError && SERVICES.every((n) => (state.failures.get(n) ?? 0) >= FAILURE_LIMIT)) state.status = 'error';
      return null;
    }

    const CACHE_LIMIT = 2000;
    function rememberCache(key, value) {
      if (state.cache.size >= CACHE_LIMIT) {
        const first = state.cache.keys().next().value;
        state.cache.delete(first);
      }
      state.cache.set(key, value);
    }

    // Slow recovery: each passing minute gives a throttled service one attempt back.
    state.decay = setInterval(() => {
      for (const name of SERVICES) {
        const at = state.failures.get(name) ?? 0;
        if (at > 0) state.failures.set(name, at - 1);
      }
    }, 60_000);


    // --- атрибуты (подсказки/плейсхолдеры) и вкладка ------------------------
    const ATTRS = ['title', 'placeholder', 'aria-label'];

    function attrScan(root) {
      if (state.status === 'off' || state.status === 'error') return;
      const els = root.querySelectorAll
        ? root.querySelectorAll('[title],[placeholder],[aria-label]')
        : [];
      for (const el of els) {
        if (el.closest?.('[data-dsh-at-skip]')) continue;
        const applied = state.attrApplied.get(el) ?? {};
        for (const attr of ATTRS) {
          const value = el.getAttribute(attr);
          if (typeof value !== 'string') continue;
          if (!isMeaningful(value) || looksTarget(value)) continue;
          if (applied[attr] === value) continue;
          state.attrTargets.add({ el, attr, value });
        }
      }
    }

    async function drainAttrTargets() {
      const service = currentService();
      const items = [...state.attrTargets];
      for (const item of items) {
        state.attrTargets.delete(item);
        if (!item.el.isConnected || item.el.getAttribute(item.attr) !== item.value) continue;
        const done = await translateText(item.value, service);
        const cur = state.attrApplied.get(item.el) ?? {};
        if (done && typeof done === 'string' && done.trim() !== '') {
          try { item.el.setAttribute(item.attr, done); } catch {}
          cur[item.attr] = done;
        } else {
          cur[item.attr] = item.value;
        }
        state.attrApplied.set(item.el, cur);
      }
    }

    async function translateTitleOnce() {
      if (!document.title || looksTarget(document.title)) return;
      const done = await translateText(document.title, currentService());
      if (done && typeof done === 'string' && done.trim() !== '') document.title = done;
    }
    // --- DOM walk and queue -------------------------------------------------

    function collect(root) {
      const found = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !isMeaningful(node.nodeValue)) return NodeFilter.FILTER_REJECT;
          if (node.parentNode?.closest?.('[data-dsh-at-skip]')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let current;
      while ((current = walker.nextNode())) found.push(current);
      return found;
    }

    function enqueue(root) {
      if (state.status === 'off' || state.status === 'error') return;
      try { attrScan(root); } catch {}
      for (const node of collect(root)) {
        if (isSkippable(node)) continue;
        if (state.applied.get(node) === node.nodeValue) continue;
        state.queue.add(node);
      }
      if (state.queue.size > 0) {
        if (state.status === 'on') state.status = 'busy';
        renderButton();
        schedulePump();
      }
    }

    function schedulePump() {
      if (state.pumpRunning) return;
      state.pumpRunning = true;
      setTimeout(pump, 50);
    }

    async function pump() {
      const service = currentService();
      for (let i = 0; i < CONCURRENCY; i += 1) {
        const node = nextQueued();
        if (!node) break;
        fire(service, node);
      }
      drainAttrTargets().then(() => { try { translateTitleOnce(); } catch {} }).catch(() => {});
      if (state.queue.size > 0 && state.attrTargets.size > 0) setTimeout(pump, 220);
      else if (state.queue.size > 0) setTimeout(pump, 100);
      else if (state.pending === 0 && state.status === 'busy') idle();
    }

    function idle() {
      state.pumpRunning = false;
      state.status = 'on';
      renderButton();
    }

    function nextQueued() {
      for (const node of state.queue) {
        state.queue.delete(node);
        if (!node.isConnected || state.applied.get(node) === node.nodeValue) continue;
        return node;
      }
      return null;
    }

    async function fire(service, node) {
      const original = node.nodeValue;
      state.originals.set(node, original);
      state.pending += 1;
      try {
        if (!looksTarget(original)) {
          const translated = await translateText(original, service);
          // A re-render may have replaced the text meanwhile: only overwrite the same string.
          if (translated && node.nodeValue.trim() === original.trim()) {
            node.nodeValue = translated;
            state.applied.set(node, translated);
          }
        } else {
          state.applied.set(node, original);
        }
      } finally {
        state.pending -= 1;
        if (state.queue.size > 0) schedulePump();
        else if (state.pending === 0 && state.status === 'busy') idle();
      }
    }

    function onMutations(records) {
      if (state.status === 'off' || state.status === 'error') return;
      const roots = [];
      for (const record of records) {
        if (record.target === state.button || record.target?.parentElement === state.button) continue;
        for (const added of record.addedNodes) {
          if (added.nodeType === 1 || added.nodeType === 3) roots.push(added);
        }
        if (record.type === 'characterData') roots.push(record.target);
      }
      if (roots.length === 0) return;
      clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        for (const root of roots) if (root.isConnected) enqueue(root);
      }, 250);
    }

    function start() {
      state.observer = new MutationObserver(onMutations);
      state.observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      state.status = 'on';
      enqueue(document.body);
      renderButton();
    }

    function restoreAll() {
      if (state.observer) {
        state.observer.disconnect();
        state.observer = null;
      }
      clearTimeout(state.timer);
      state.queue.clear();
      for (const [node, original] of state.originals) {
        if (node.isConnected) node.nodeValue = original;
      }
      state.originals = new Map();
      state.applied = new Map();
      state.status = 'off';
      renderButton();
    }

    // --- floating toggle ----------------------------------------------------

    function renderButton() {
      if (!state.button) return;
      const on = state.status !== 'off';
      const marker = state.status === 'error' ? '⚠' : state.status === 'busy' ? '…' : '';
      state.button.textContent = '🌐 автоперевод' + (on ? ' ' + currentService() : '') + (marker ? ' ' + marker : '');
      state.button.dataset.dshAtState = state.status;
      state.button.setAttribute('aria-pressed', String(on));
      state.button.title = 'Автоперевод всех окон и страниц DSH через ' + currentService()
        + '.\nЛевый клик — включить/выключить и вернуть оригиналы.'
        + '\nПравый клик — выбор сервиса и ключ DeepL.'
        + '\nCtrl+клик — переключить сервис (' + SERVICES.join(' → ') + ')';
    }

    function installButton() {
      if (state.button) return;
      const button = document.createElement('button');
      button.id = 'dsh-auto-translate-toggle';
      button.type = 'button';
      button.setAttribute('data-dsh-at-skip', 'on');
      Object.assign(button.style, {
        position: 'fixed',
        right: '12px',
        bottom: '88px',
        zIndex: '2147483646',
        padding: '4px 10px',
        borderRadius: '16px',
        border: '1px solid var(--dsw-alias-border, rgba(128,140,166,0.4))',
        background: 'var(--dsw-alias-bg, rgba(20,22,28,0.85))',
        color: 'var(--dsw-alias-fg, inherit)',
        font: '12px/1.4 system-ui, sans-serif',
        cursor: 'pointer',
        opacity: '0.55',
      });
      button.addEventListener('mouseenter', () => { button.style.opacity = '1'; });
      button.addEventListener('mouseleave', () => { button.style.opacity = '0.55'; });
      button.addEventListener('click', (event) => {
        if (event.ctrlKey) {
          setString(LS.service, SERVICES[(SERVICES.indexOf(currentService()) + 1) % SERVICES.length]);
          renderButton();
          return;
        }
        if (state.status === 'off') {
          setString(LS.enabled, '1');
          for (const name of SERVICES) state.failures.set(name, 0);
          start();
        } else {
          setString(LS.enabled, '0');
          restoreAll();
        }
      });
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const entered = (window.prompt('Сервис автоперевода (google / lingva / deepl):', currentService()) ?? '')
          .trim().toLowerCase();
        if (SERVICES.includes(entered)) setString(LS.service, entered);
        if (entered === 'deepl') {
          const key = window.prompt('DeepL API-ключ (api-free.deepl.com; хранится только в localStorage):', getString(LS.key, ''));
          if (key !== null) setString(LS.key, key.trim());
        }
        renderButton();
      });
      document.body.appendChild(button);
      state.button = button;
      renderButton();
    }

    function boot() {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
        return;
      }
      installButton();
      if (getString(LS.enabled, '') === '1') start();
    }

    module.exports.inject = inject;
    module.exports.apply = (ctx) => {
      boot();
      ctx.effect?.(() => () => {
        restoreAll();
        clearInterval(state.decay);
        state.button?.remove();
        state.button = null;
      }, 'dsh-auto-translate: lifecycle');
    };
    return module.exports;
  },
});
