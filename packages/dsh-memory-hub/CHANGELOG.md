# Changelog — dsh-memory-hub

## 0.2.0 — 2026-11-17

### Added / Добавлено

- **RU:** память проекта: таблицы `mh_sessions`, `mh_goals`, `mh_steps`, `mh_skills` в той же базе — документируются сессии, цели, каждый вызов инструмента и каждая команда с меткой workspace.
- **EN:** project memory: `mh_sessions`, `mh_goals`, `mh_steps`, `mh_skills` in the same database — sessions, goals, every tool call and every shell command are documented with their workspace tag.
- **RU:** вектор цели и сверка шага: при дрейфе `cos` ниже `goalDriftMin` в промпт идёт ограниченный блок с целью и последними действиями (не чаще раза в два хода), плюс инструмент `memory_goal` (`set`/`list`/`done`/`drop`).
- **EN:** goal vector and step check: when `cos` falls below `goalDriftMin`, a bounded goal-vs-step block is injected (at most once per two turns), plus the `memory_goal` tool (`set`/`list`/`done`/`drop`).
- **RU:** навыки по принципу Hermes: успешный ход с командами и решением становится навыком, второй успех — `active`, при совпадении подставляется порядок действий и результат.
- **EN:** Hermes-style skills: a successful turn with commands and a solution becomes a skill, a second success promotes it to `active`, and a matching request gets the procedure and its artifact.
- **RU:** самовосстановление: `PRAGMA quick_check` при открытии, битый файл увозится в `*.corrupt-*`, миграция схемы через `PRAGMA user_version`; ошибочная запись не рвёт сессию.
- **EN:** self-healing: `PRAGMA quick_check` on open, a damaged file is moved to `*.corrupt-*`, schema migrates via `PRAGMA user_version`; a failed write never breaks a session.
- **RU:** новые ключи конфига `goalDriftMin`, `goalGuardChars`, `skillMinScore`; статистика дашборда показывает сессии, цели, шаги, навыки и срабатывания goal-guard.
- **EN:** new config keys `goalDriftMin`, `goalGuardChars`, `skillMinScore`; dashboard stats now show project sessions, goals, steps, skills and goal-guard hits.
- **RU:** та же база используется плагином opencode (`packages/opencode-memory-hub`) — проект и общий индекс едины для обоих агентов.
- **EN:** the same database is shared with the opencode plugin (`packages/opencode-memory-hub`) — one project memory and one index for both agents.

### Verified / Проверено

- **RU:** юнит-прогон хранилища: 12 проверок, включая миграцию живой базы (3750 чанков сохранились) и восстановление после подмены файла мусором.
- **EN:** storage unit run: 12 checks, including migration of the live database (3750 chunks preserved) and recovery after the file was replaced with garbage.

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
