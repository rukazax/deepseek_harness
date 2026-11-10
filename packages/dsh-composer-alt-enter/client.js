/**
 * dsh-composer-alt-enter — Alt+Enter в редакторе композера вставляет перенос строки.
 *
 * Гонка с событий: Enter отправляет сообщение, Ctrl/Cmd+Enter — дополнительный режим,
 * Shift+Enter — встроенный перенос. Alt+Enter DSH сознательно не использует и отдаёт
 * application shortcuts — этот модуль занимает её: capture-фаза keydown, цель —
 * активный Lexical-редактор композера. Вставка — через официальный мост
 * inputActions.insertText ('\\n' — undoable редактирование), при недоступности —
 * execCommand fallback. Событие гасится, чтобы Lexical его не видел.
 */
window.__ModuleLoader__.load({
  id: 'dsh-composer-alt-enter',
  factory(require) {
    let insertBreak = null;

    function fallbackInsert() {
      try { if (document.execCommand('insertLineBreak')) return true; } catch { /* try next */ }
      try { document.execCommand('insertText', false, '\n'); return true; } catch { return false; }
    }

    function handler(ev) {
      if (ev.key !== 'Enter' || ev.altKey !== true || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
      if (ev.isComposing || ev.repeat) return;
      const el = document.activeElement;
      const editor = el && typeof el.closest === 'function' ? el.closest('[data-lexical-editor]') : null;
      if (!editor) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (insertBreak) { try { if (insertBreak()) return; } catch { /* fall through */ } }
      fallbackInsert();
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        document.addEventListener('keydown', handler, { capture: true });
        ctx.effect?.(() => () => document.removeEventListener('keydown', handler, { capture: true }));
        // забрать inputActions из стандартных пропсов композера (официальный мост вставки)
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'alt-enter-newline', order: 95 },
          (props) => {
            const ia = props?.inputActions;
            if (ia && typeof ia.insertText === 'function') {
              insertBreak = (text) => {
                try {
                  const span = typeof ia.captureInsertion === 'function' ? ia.captureInsertion() : null;
                  return Boolean(ia.insertText(text, span));
                } catch { return false; }
              };
            }
            return null;
          },
        ));
      },
    };
  },
});
