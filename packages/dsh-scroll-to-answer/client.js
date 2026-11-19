/**
 * dsh-scroll-to-answer — Client half.
 *
 * Когда ход завершён (стрим ответа закончился), лента чата прокручивается к
 * НАЧАЛУ только что полученного ответа, а не остаётся внизу.
 *
 * Опоры — публичные атрибуты UI-слоя чата:
 *   [data-slot="conversation.chat.flow"] / [data-chat-flow] — лента,
 *   [data-chat-turn]      — блок хода,
 *   [data-chat-running]   — индикатор активной генерации.
 * Никаких зависимостей от внутренних классов и от чужих стилей.
 */
window.__ModuleLoader__.load({
  id: 'dsh-scroll-to-answer',
  factory(require) {
    const React = require('react');

    const FLOW_SELECTOR = '[data-slot="conversation.chat.flow"], [data-chat-flow]';
    const TURN_SELECTOR = '[data-chat-turn]';
    const RUNNING_SELECTOR = '[data-chat-running]';
    const QUIET_MS = 1100;   // тишина в DOM после последнего чанка
    const EDGE_PX = 10;      // допуск «уже на месте»

    const log = (...args) => {
      try { console.info('[scroll-to-answer]', ...args); } catch { /* нет консоли */ }
    };

    function findFlow() {
      try { return document.querySelector(FLOW_SELECTOR); } catch { return null; }
    }

    /** Ближайший предок ленты, который реально прокручивается. */
    function findScroller(from) {
      let node = from;
      for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
        try {
          const style = window.getComputedStyle(node);
          const scrollable = style.overflowY === 'auto' || style.overflowY === 'scroll';
          if (scrollable && node.scrollHeight - node.clientHeight > 24) return node;
        } catch { /* ignore */ }
      }
      return null;
    }

    /** Блок последнего хода внутри ленты. */
    function findTarget(flow) {
      const turns = flow.querySelectorAll(TURN_SELECTOR);
      if (turns.length > 0) return turns[turns.length - 1];
      const kids = Array.from(flow.children).filter((el) => {
        if (el.hasAttribute('hidden')) return false;
        return (el.textContent || '').trim().length > 30;
      });
      return kids.length > 0 ? kids[kids.length - 1] : null;
    }

    function isRunning(flow) {
      try { return Boolean(flow.querySelector(RUNNING_SELECTOR)) || flow.hasAttribute('data-chat-running'); }
      catch { return false; }
    }

    function jumpToStartOnce() {
      const flow = findFlow();
      if (!flow || isRunning(flow)) return;
      const scroller = findScroller(flow);
      const target = findTarget(flow);
      if (!scroller || !target) return;
      let delta = 0;
      try {
        delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      } catch { return; }
      if (Math.abs(delta) <= EDGE_PX) return; // уже в начале ответа
      const top = Math.max(0, scroller.scrollTop + delta - 8);
      try {
        scroller.scrollTo({ top, behavior: 'smooth' });
      } catch {
        scroller.scrollTop = top;
      }
      log('переход к началу ответа', Math.round(delta));
    }

    /** Подписка на одну ленту: ждём затишья и отсутствия индикатора генерации. */
    function bindFlow(flow) {
      let timer = 0;
      let armed = false;      // взводимся, когда генерация началась
      let lastKey = '';
      let lastAt = 0;

      const fire = () => {
        timer = 0;
        if (isRunning(flow)) return;
        if (!armed) return;
        armed = false;
        const target = findTarget(flow);
        const key = target ? `${target.getAttribute('data-chat-turn') || ''}:${(target.textContent || '').length}` : '';
        if (key && key === lastKey && Date.now() - lastAt < 5000) return;
        lastKey = key;
        lastAt = Date.now();
        jumpToStartOnce();
      };

      const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(fire, QUIET_MS);
      };

      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes') {
            // появление [data-chat-running] = началась генерация → взводимся
            if (record.attributeName === 'data-chat-running') armed = true;
          }
        }
        if (isRunning(flow)) armed = true;
        // любые изменения контента после взведения — повод перезапустить тишину
        if (armed) schedule();
      });

      try {
        observer.observe(flow, {
          attributes: true,
          attributeFilter: ['data-chat-running'],
          childList: true,
          characterData: true,
          subtree: true,
        });
      } catch { /* не удалось подписаться — тихо выходим */ }

      // Лента может не иметь собственного [data-chat-running]; следим и за ним.
      let runningObserver = null;
      const runningNode = flow.querySelector(RUNNING_SELECTOR);
      if (runningNode) {
        runningObserver = new MutationObserver(() => {
          if (isRunning(flow)) {
            armed = true;
            schedule();
          } else {
            schedule();
          }
        });
        try { runningObserver.observe(runningNode, { attributes: true, attributeFilter: ['data-chat-running'] }); } catch { /* ignore */ }
      }

      return () => {
        if (timer) clearTimeout(timer);
        observer.disconnect();
        runningObserver?.disconnect();
      };
    }

    /** Компонент без разметки: живёт внутри области чата и держит подписку. */
    function ScrollToAnswer() {
      React.useEffect(() => {
        let unbind = null;
        let boundFlow = null;

        const sync = () => {
          const flow = findFlow();
          if (flow === boundFlow) return;
          unbind?.();
          unbind = null;
          boundFlow = flow;
          if (flow) unbind = bindFlow(flow);
        };

        sync();
        const watcher = setInterval(sync, 1500);   // смена чата / пересоздание ленты
        return () => {
          clearInterval(watcher);
          unbind?.();
        };
      }, []);
      return null;
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Слот в области композера всегда смонтирован вместе с чатом; компонент
        // невидим и не занимает места (null в потоке).
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'scroll-to-answer-anchor', order: 90 },
          ScrollToAnswer
        ));
      },
    };
  },
});
