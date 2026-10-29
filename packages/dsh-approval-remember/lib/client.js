/**
 * dsh-approval-remember — client plugin for DeepSeek Harness.
 *
 * Adds an "Always allow / Разрешать всегда" button to the approval panel action row
 * (right of "Reject" and "Allow once"). Clicking it approves the current request and
 * remembers the rule for this and similar scenarios (same normalized action class);
 * later matching requests are approved automatically. Rules live in localStorage.
 */
window.__ModuleLoader__.load({
  id: "dsh-approval-remember",
  factory: () => {
    const STORE_KEY = "dsh.approvalRules.v2";
    const LEGACY_KEY = "dsh.approvalRemember.v1";
    const PANEL_ATTR = "dshApprovalPatched";
    const BTN_ATTR = "data-dsh-approval-always";

    const load = () => {
      let rules = {};
      try {
        rules = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {};
      } catch {
        rules = {};
      }
      try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "{}") || {};
        for (const headline of Object.keys(legacy)) {
          const sig = signature({ headline });
          if (!rules[sig]) rules[sig] = { label: headline, addedAt: legacy[headline], migrated: true };
        }
      } catch {}
      return rules;
    };
    let rules = load();
    const save = () => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(rules));
      } catch {}
    };

    const isRussian = () => {
      const lang = (document.documentElement.lang || "").toLowerCase();
      if (lang.startsWith("ru")) return true;
      const text = document.body?.innerText || "";
      return text.includes("Разрешить") || text.includes("Отклонить");
    };

    /** Normalize text so that similar scenarios share the same signature. */
    const normalize = (text) => {
      let s = String(text || "").toLowerCase();
      s = s.replace(/[a-z]:\\[^\s"'<>]+/gi, "<path>");
      s = s.replace(/(?:\/[\w.\-]+){2,}/g, "<path>");
      s = s.replace(/https?:\/\/\S+/gi, "<url>");
      s = s.replace(/["'`«»“”„][^"'`«»“”„]*["'`«»“”„]/g, "<text>");
      s = s.replace(/\d+(?:[.,]\d+)*/g, "#");
      s = s.replace(/[^\p{L}\p{N}<>#]+/gu, " ");
      return s.replace(/\s+/g, " ").trim();
    };
    const signature = ({ headline }) => normalize(headline) || "approval";

    const injectCss = () => {
      if (document.querySelector("style[data-dsh-approval-remember-css]")) return;
      const style = document.createElement("style");
      style.dataset.dshApprovalRememberCss = "1";
      style.textContent = `
        [${BTN_ATTR}] {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin-left: 4px;
          padding: 6px 12px;
          border-radius: 8px;
          border: 1px solid var(--dsw-alias-border-interactive, #4a5570);
          background: transparent;
          color: var(--dsw-alias-label-secondary, #c8d1e6);
          font-size: 13px;
          line-height: 18px;
          cursor: pointer;
          white-space: nowrap;
          font-family: inherit;
        }
        [${BTN_ATTR}]:hover:not(:disabled) {
          border-color: var(--dsw-alias-interactive-bg-primary, #4b6bfb);
          color: var(--dsw-alias-label-primary, #ffffff);
        }
        [${BTN_ATTR}]:disabled { opacity: .55; cursor: default; }
        [${BTN_ATTR}][data-active] {
          border-color: var(--dsw-alias-state-ok-primary, #3fb950);
          color: var(--dsw-alias-state-ok-primary, #3fb950);
        }
      `;
      document.head.appendChild(style);
    };

    const headlineOf = (panel) => {
      const node = panel.querySelector('[class*="headline"]');
      const text = (node?.textContent || "").trim();
      return text || panel.getAttribute("data-approval-key") || "approval";
    };

    const actionRowOf = (panel) => {
      for (const row of panel.querySelectorAll("div")) {
        if (row.querySelectorAll(":scope > button").length >= 2) return row;
      }
      return null;
    };

    /** Buttons of the original approval UI only (without our injected one). */
    const originalButtons = (row) =>
      [...row.querySelectorAll(":scope > button")].filter((b) => !b.hasAttribute(BTN_ATTR));

    const patchPanel = (panel) => {
      if (!panel || panel.dataset[PANEL_ATTR]) return;
      const row = actionRowOf(panel);
      if (!row) return;
      if (originalButtons(row).length < 2) return;
      panel.dataset[PANEL_ATTR] = "1";

      const headline = headlineOf(panel);
      const sig = signature({ headline });

      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute(BTN_ATTR, "1");
      btn.title = isRussian()
        ? "Разрешать всегда: это и подобные запросы больше не будут спрашивать"
        : "Always allow: this and similar requests will not ask again";
      btn.textContent = rules[sig]
        ? (isRussian() ? "✓ Разрешено всегда" : "✓ Allowed always")
        : (isRussian() ? "Разрешать всегда" : "Always allow");
      if (rules[sig]) btn.dataset.active = "1";

      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const allowBtn = originalButtons(row).pop();
        if (!allowBtn || allowBtn.disabled) return;
        rules[sig] = { label: headline, addedAt: Date.now() };
        save();
        btn.textContent = isRussian() ? "✓ Разрешено всегда" : "✓ Allowed always";
        btn.dataset.active = "1";
        btn.disabled = true;
        allowBtn.click();
      });

      row.appendChild(btn);

      if (rules[sig] && !panel.dataset.dshAutoApproved) {
        panel.dataset.dshAutoApproved = "1";
        setTimeout(() => {
          const allowBtn = originalButtons(row).pop();
          if (allowBtn && !allowBtn.disabled) allowBtn.click();
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
      list: () => ({ ...rules }),
      clear: () => {
        rules = {};
        save();
        for (const panel of document.querySelectorAll("[data-approval-key]")) {
          delete panel.dataset[PANEL_ATTR];
          panel.querySelector("[" + BTN_ATTR + "]")?.remove();
        }
        scan();
      },
    };
  },
});
