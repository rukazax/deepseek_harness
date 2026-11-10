# dsh-web-mobile-shell

**RU** · [English](#english)

## RU

Клиентский патч оболочки DSH для мобильных браузеров. Внедряется в файл
`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html`
(отдаётся как есть, рестарт dsh не нужен — страница подхватывает при перезагрузке).

### Состав (текущий `index.patched.html`)

1. Edge-swipe на тач-устройстве открывает/закрывает боковую панель (только coarse pointer).
2. Тап по пустому месту свёрнутой рейки разворачивает панель.

Оба обработчика одноразовые (за один жест срабатывают один раз) и на десктопных указателях неактивны.

**Scroll-fix (2026-11-10, вечер):** свайп-флик прокрутки чата, начавшийся у левого края с диагональным
уводом (≥88px, 1.6:1), открывал панель посреди скролла — вёрстка прыгала («моргает при прокрутке»).
Пороги ужесточены: открытие — только истинный левый край (≤24px), ≥110px и 3:1 по горизонтали;
закрытие — только свайп, начавшийся внутри развёрнутой панели (проверка `startTarget`).

### История: self-heal (удалён 2026-11-10)

Первая версия содержала «самолечение» триггеров аккаунта и настроек: через 380 мс после тапа —
повторный `click()`, ещё через 140 мс — третий, плюс «щит», гасивший внешние `pointerdown`.
Если `aria-expanded` у триггера не менялся (панельные триггеры, вроде шестерёнки настроек, — не меню),
патч считал, что меню «не открылось», и переключал панель 2–3 раза подряд — это выглядело как
моргание интерфейса на телефоне при нажатии настроек/аккаунта. Секция удалена полностью.

**Возвращать только** в виде одиночного повторного клика с проверкой фактического появления меню
в DOM (`[role=menu]`, `[data-radix-popper-content-wrapper]`, `[role=dialog]`), без «щита» и без
второго ретрая.

### Установка

```bash
D=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist
cp patches/dsh-web-mobile-shell/index.patched.html /tmp/index.dsh.html
echo '<root-password>' | sudo -S sh -c "cp $D/index.html /tmp/index.dsh.bak.html && \
  cp /tmp/index.dsh.html $D/index.html && chown root:root $D/index.html && chmod 644 $D/index.html"
```

Затем обновить страницу в браузере. Бэкап предыдущей версии остаётся в `/tmp/index.dsh.bak.html`
(живёт до перезагрузки машины).

## English

A client-side shell patch for DSH mobile browsers, injected into the served
`dsh-web-frontend/dist/index.html` (no dsh restart needed; the page picks it up on reload).

Current `index.patched.html` ships two one-shot gestures for coarse pointers only: edge-swipe
toggles the sidebar rail, tapping an empty spot of the collapsed rail expands it.

**History — self-heal (removed 2026-11-10).** The first version re-clicked the account/settings
triggers 380 ms after every tap (plus a third click and an outside-pointerdown shield). Whenever
`aria-expanded` stayed false — panel-style triggers like the settings gear — the patch toggled the
panel 2–3 times in a row, which looked like UI flickering on the phone. The section was removed;
restore it only as a single DOM-gated retry that checks for the actual menu element.
