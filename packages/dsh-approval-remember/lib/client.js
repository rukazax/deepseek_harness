/**
 * dsh-approval-remember — client plugin for DeepSeek Harness.
 *
 * Adds a "Remember choice / Запомнить выбор" checkbox to the approval panel action row
 * (right of "Reject" and "Allow once"). Remembered decisions auto-approve later requests
 * with the same headline, and are stored in localStorage.
 */
window.__ModuleLoader__.load({
  id: "dsh-approval-remember",
  factory: () => {
    const STORE_KEY = "dsh.approvalRemember.v1";
    const PANEL_ATTR = "dshApprovalPatched";
    const LABEL_ATTR = "data-dsh-approval-remember";

    const load = () => {
      try {
        return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {};
      } catch {
        return {};
      }
    };
    let remembered = load();
    const save = () => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(remembered));
      } catch {}
    };

    const isRussian = () => {
      const lang = (document.documentElement.lang || "").toLowerCase();
      if (lang.startsWith("ru")) return true;
      const text = document.body?.innerText || "";
      return text.includes("Разрешить") || text.includes("Запомнить");
    };

    const injectCss = () => {
      if (document.querySelector("style[data-dsh-approval-remember-css]")) return;
      const style = document.createElement("style");
      style.dataset.dshApprovalRememberCss = "1";
      style.textContent = `
        [${LABEL_ATTR}] {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin-left: 4px;
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-label-secondary, #8a93a8);
          cursor: pointer;
          user-select: none;
          white-space: nowrap;
        }
        [${LABEL_ATTR}] input {
          width: 14px;
          height: 14px;
          margin: 0;
          accent-color: var(--dsw-alias-interactive-bg-primary, #4b6bfb);
          cursor: pointer;
        }
        [${LABEL_ATTR}]:hover { color: var(--dsw-alias-label-primary, #dfe6f5); }
        [${LABEL_ATTR}][data-auto] { color: var(--dsw-alias-state-ok-primary, #3fb950); }
      `;
      document.head.appendChild(style);
    };

    const headlineOf = (panel) => {
      const node = panel.querySelector('[class*="headline"]');
      const text = (node?.textContent || "").trim();
      return text || panel.getAttribute("data-approval-key") || "approval";
    };

    const actionRowOf = (panel) => {
      const rows = panel.querySelectorAll("div");
      for (const row of rows) {
        const buttons = row.querySelectorAll(":scope > button");
        if (buttons.length >= 2) return row;
      }
      return null;
    };

    const patchPanel = (panel) => {
      if (!panel || panel.dataset[PANEL_ATTR]) return;
      const row = actionRowOf(panel);
      if (!row) return;
      const buttons = row.querySelectorAll(":scope > button");
      const allow = buttons[buttons.length - 1];
      if (!allow) return;
      panel.dataset[PANEL_ATTR] = "1";
      const headline = headlineOf(panel);

      const label = document.createElement("label");
      label.setAttribute(LABEL_ATTR, "1");
      label.title = isRussian()
        ? "Запомнить выбор: одинаковые запросы будут разрешаться автоматически"
        : "Remember choice: identical requests will be allowed automatically";
      const box = document.createElement("input");
      box.type = "checkbox";
      const text = document.createElement("span");
      text.textContent = isRussian() ? "Запомнить выбор" : "Remember choice";
      label.append(box, text);
      if (remembered[headline]) box.checked = true;

      box.addEventListener("change", () => {
        if (box.checked) remembered[headline] = Date.now();
        else delete remembered[headline];
        save();
      });

      row.appendChild(label);

      if (remembered[headline] && !panel.dataset.dshAutoApproved) {
        panel.dataset.dshAutoApproved = "1";
        setTimeout(() => {
          const btn = row.querySelectorAll(":scope > button");
          const last = btn[btn.length - 1];
          if (last && !last.disabled) {
            last.click();
            label.setAttribute("data-auto", "1");
          }
        }, 80);
      }
    };

    const scan = () => {
      injectCss();
      for (const panel of document.querySelectorAll("[data-approval-key]")) {
        try {
          patchPanel(panel);
        } catch {}
      }
    };

    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        scan();
      });
    };

    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", scan, { once: true });
    } else {
      scan();
    }
    window.__dshApprovalRemember = {
      list: () => ({ ...remembered }),
      clear: () => {
        remembered = {};
        save();
        for (const panel of document.querySelectorAll("[data-approval-key]")) {
          delete panel.dataset[PANEL_ATTR];
          panel.querySelector("[" + LABEL_ATTR + "]")?.remove();
        }
        scan();
      },
    };
  },
});
