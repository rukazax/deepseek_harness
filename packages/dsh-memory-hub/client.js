window.__ModuleLoader__.load({
  id: 'dsh-memory-hub',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = {
      async stats() {
        try {
          const res = await fetch('/api/memory-hub/stats', { headers: { accept: 'application/json' } });
          return res.ok ? await res.json() : null;
        } catch { return null; }
      },
      async analysis() {
        try {
          const res = await fetch('/api/memory-hub/analysis', { headers: { accept: 'application/json' } });
          return res.ok ? await res.json() : null;
        } catch { return null; }
      },
      async run(path) {
        try {
          const res = await fetch(path, { headers: { accept: 'application/json' } });
          return res.ok ? await res.json() : null;
        } catch { return null; }
      },
    };

    const css = {
      row: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 30, padding: '2px 12px', color: 'var(--dsw-alias-fg-secondary, inherit)', fontSize: 12 },
      link: { color: 'var(--dsw-alias-accent, #4b6bfb)', cursor: 'pointer' },
      dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
      icon: { fontSize: 13 },
    };

    function fmtInt(value) { return typeof value === 'number' ? value.toLocaleString('ru-RU') : '0'; }

    function Informer({ onOpen }) {
      const [stats, setStats] = React.useState(null);
      const pollRef = React.useRef(0);
      const load = React.useCallback(() => { API.stats().then((next) => next && setStats(next)); }, []);
      React.useEffect(() => {
        load();
        pollRef.current = setInterval(load, 20000);
        return () => clearInterval(pollRef.current);
      }, [load]);
      const fresh = stats !== null && Date.now() - (stats.lastEventAt ?? 0) < 5 * 60 * 1000;
      return h('div', { style: css.row, role: 'status', title: 'Memory Hub · общий контекст всех чатов и workspace' },
        h('span', { style: { ...css.dot, background: fresh ? 'var(--dsw-alias-success, #3fb27f)' : 'var(--dsw-alias-border, #8a93a6)' } }),
        h('span', { style: { ...css.icon }, 'aria-hidden': true }, '🧠'),
        h('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
          `память: ${fmtInt(stats?.chunks)} чанк. · ${fmtInt(stats?.routines)} рут. · экономия ≈ ${fmtInt(stats?.estimatedTokensSaved)} ток`),
        h('button', {
          style: { all: 'unset', ...css.link, fontSize: 12, whiteSpace: 'nowrap' },
          onClick: onOpen,
          title: 'Открыть дашборд памяти',
        }, 'дашборд ↗'));
    }

    const cardCss = {
      card: { border: '1px solid var(--dsw-alias-border, rgba(128,140,166,0.35))', borderRadius: 12, padding: '10px 14px', minWidth: 150, display: 'flex', flexDirection: 'column', gap: 4 },
      big: { fontSize: 22, fontWeight: 600, lineHeight: 1.15 },
      small: { fontSize: 11, color: 'var(--dsw-alias-fg-secondary, inherit)' },
      chip: { display: 'inline-block', padding: '1px 8px', border: '1px solid var(--dsw-alias-border, rgba(128,140,166,0.35))', borderRadius: 999, fontSize: 11, marginRight: 6 },
      grid: { display: 'flex', flexWrap: 'wrap', gap: 10, margin: '10px 0' },
      section: { margin: '14px 0' },
      title: { fontSize: 13, fontWeight: 600, margin: '0 0 6px' },
      pre: { fontFamily: 'var(--dsw-alias-font-mono, monospace)', fontSize: 11, whiteSpace: 'pre-wrap', lineHeight: 1.45, padding: 10, border: '1px solid var(--dsw-alias-border, rgba(128,140,166,0.35))', borderRadius: 10, margin: 0, maxHeight: 420, overflow: 'auto' },
      btn: { all: 'unset', cursor: 'pointer', border: '1px solid var(--dsw-alias-border, rgba(128,140,166,0.35))', borderRadius: 8, padding: '3px 10px', fontSize: 12 },
    };

    function Dashboard() {
      const [stats, setStats] = React.useState(null);
      const [analysis, setAnalysis] = React.useState(null);
      const load = React.useCallback(async () => {
        const [nextStats, nextAnalysis] = await Promise.all([API.stats(), API.analysis()]);
        if (nextStats) setStats(nextStats);
        if (nextAnalysis) setAnalysis(nextAnalysis);
      }, []);
      React.useEffect(() => {
        load();
        const timer = setInterval(load, 20000);
        return () => clearInterval(timer);
      }, [load]);
      if (stats === null) return h('div', { style: { padding: 20, color: 'var(--dsw-alias-fg-secondary, inherit)' } }, 'Загрузка…');
      const kinds = Object.entries(stats.kinds ?? {});
      return h('div', { style: { padding: 16, overflow: 'auto', height: '100%', boxSizing: 'border-box' } },
        h('div', { style: css.row }, h('strong', null, '🧠 Memory Hub — дашборд общей памяти'), h('span', { style: { marginLeft: 'auto', fontSize: 12 } },
          h('button', { style: css.btn, onClick: load }, 'Обновить'))),
        h('div', { style: css.grid },
          h('div', { style: cardCss.card }, h('div', { style: cardCss.big }, fmtInt(stats.chunks)), h('div', { style: cardCss.small }, 'чанков в базе')),
          h('div', { style: cardCss.card }, h('div', { style: cardCss.big }, fmtInt(stats.sessions)), h('div', { style: cardCss.small }, 'сессий связано')),
          h('div', { style: cardCss.card }, h('div', { style: cardCss.big }, fmtInt(stats.routines)), h('div', { style: cardCss.small }, 'авто-рутин')),
          h('div', { style: cardCss.card }, h('div', { style: cardCss.big }, fmtInt(stats.injections)), h('div', { style: cardCss.small }, 'подстановок в контекст')),
          h('div', { style: cardCss.card }, h('div', { style: cardCss.big }, `≈${fmtInt(stats.estimatedTokensSaved)}`), h('div', { style: cardCss.small }, 'токенов сэкономлено')),
          h('div', { style: cardCss.card }, h('div', { style: cardCss.big }, stats.vault?.ok ? '✅' : '➖'), h('div', { style: cardCss.small }, 'Obsidian vault')),
        ),
        h('div', { style: css.section }, h('div', { style: css.title }, 'Состав по типам'),
          kinds.map(([kind, n]) => h('span', { key: kind, style: cardCss.chip }, `${kind}: ${fmtInt(n)}`)),
          (stats.styleSamples ?? 0) > 0 ? h('span', { style: cardCss.chip }, `стиль: ${fmtInt(stats.styleSamples)} ответов`) : null),
        h('div', { style: css.section }, h('div', { style: css.title }, 'Частотные темы'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, (stats.hotTerms ?? []).map((t) => h('span', { key: t.term, style: cardCss.chip }, `${t.term} (${t.n})`)))),
        h('div', { style: css.section }, h('div', { style: css.title }, 'Недельный анализ'),
          h('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
            h('button', { style: css.btn, onClick: async () => { const r = await API.run('/api/memory-hub/run-analysis'); if (r) setAnalysis({ at: Date.now(), analysis: r.analysis }); } }, '▶ Запустить анализ'),
            h('button', { style: css.btn, onClick: async () => { await API.run('/api/memory-hub/run-mining'); load(); } }, '⛏ Пересобрать рутины')),
          h('div', { style: cardCss.small }, `Обновлён: ${analysis?.at ? new Date(analysis.at).toLocaleString('ru-RU') : '—'}`),
          h('pre', { style: cardCss.pre }, analysis?.analysis || 'Анализ ещё не выполнялся.')),
        h('div', { style: { ...cardCss.small, marginTop: 12 } }, `Vault: ${String(stats.vault?.path ?? '')} · запущен: ${new Date(stats.startedAt).toLocaleString('ru-RU')}`));
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        ctx.effect?.(() => () => { /* registrations below are effect-owned via slots.inject */ });
        // Informer under the composer
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'memory-hub-informer', order: 5 },
          () => Informer({ onOpen: () => ctx.sidebarRight?.openTab?.('memoryHubDashboard') })
        ));
        // Dashboard tab type in the right sidebar
        ctx.sidebarRightTabs?.register?.({
          id: 'dsh-memory-hub/dashboard',
          kind: 'memoryHubDashboard',
          title: () => '🧠 Память',
          guide: [{ id: 'dashboard', kind: 'memoryHubDashboard', title: 'Memory Hub', description: 'Дашборд общей памяти: Recall, рутины, экономия токенов, Obsidian' }],
        });
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: 'dsh-memory-hub/dashboard' },
          Dashboard
        ));
      },
    };
  },
});
