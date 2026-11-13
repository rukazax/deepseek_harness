# Changelog — dsh-memory-hub

## 0.1.3 — 2026-11-13

### Changed / Изменено

- **RU:** информер под композером больше не префиксуется словом «память:» — строка состояния теперь `🧠 N чанк. · M рут. · экономия ≈ K ток`. Иконка, точка активности и кнопка «дашборд ↗» не изменились.
- **EN:** the composer informer no longer prefixes its status line with "memory:"; it now reads `🧠 N chunks · M routines · ≈ K tokens saved`. The icon, activity dot and the "dashboard ↗" button are unchanged.
- **RU:** пример строки состояния в README приведён к новому виду.
- **EN:** the README status-line example is updated to match.

### Verified / Проверено

- **RU:** `node --check client.js` проходит; правка синхронно применена к профильной копии `~/.dsh/profiles/web/node_modules/dsh-memory-hub`.
- **EN:** `node --check client.js` passes; the change was applied to the profile copy at `~/.dsh/profiles/web/node_modules/dsh-memory-hub` as well.

## 0.1.2 — 2026-11-10

### Fixed / Исправлено

- **RU:** вывод инструментов `memory_search`, `memory_save`, `memory_routines`, `memory_analyze`, `memory_style` теперь возвращается блоками `[{ type: "text", text }]`, как требует контракт `tools.register` текущей сборки DSH. Раньше `render` отдавал голые строки — DSH показывал «(no output)», хотя инструменты выполнялись. Для вступления в силу нужен перезапуск `dsh`.
- **EN:** tool outputs of `memory_search`, `memory_save`, `memory_routines`, `memory_analyze` and `memory_style` are now rendered as `[{ type: "text", text }]` content blocks, matching the `tools.register` contract of the current DSH build. Previously `render` returned bare strings, so DSH displayed "(no output)" even though the tools executed. Requires a `dsh` restart to take effect.

### Verified / Проверено

- **RU:** `node --check` проходит; все 5 обработчиков заменены; hardlink-копия в `~/.dsh/profiles/web/node_modules/dsh-memory-hub` обновляется тем же файлом.
- **EN:** `node --check` passes; all 5 handlers replaced; the hardlinked copy in `~/.dsh/profiles/web/node_modules/dsh-memory-hub` shares the same file.
