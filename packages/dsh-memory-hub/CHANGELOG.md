# Changelog — dsh-memory-hub

## 0.3.0 — 2026-11-17

### Added / Добавлено

- **RU:** словарь v3 без токенов: подписанное хэширование 8192 (коллизии больше не складываются), стемминг RU/EN (каскад/каскада/каскаду → один стем), триграммы по краям слова для опечаток и редких форм; df пересчитывается с нуля (старый счётчик был раздут двойным учётом и не убывал).
- **EN:** zero-token vocabulary v3: signed 8192-bin hashing (collisions no longer add up), RU/EN stemming (каскад/каскада/каскаду → one stem), edge trigrams for typos and rare forms; df is rebuilt from scratch (the old counter was inflated by double counting and never decayed).

- **RU:** ассоциативный тезаурус `mh_terms` — PPMI по скользящему окну 8 токенов на собственном корпусе; соседи по контексту дают синонимы и жаргон (`сжат` → `dcp`, `qwen` → `oauth-поток`), а пары «кириллица ↔ латиница» (`каскад` ↔ `cascade`, `навык` ↔ `skill`) работают как переводной мост. Список соседей симметричен и защищён от вытеснения мостовых пар.
- **EN:** `mh_terms` association thesaurus — PPMI over a sliding 8-token window on the corpus itself; contextual neighbours give synonyms and jargon (`сжат` → `dcp`, `qwen` → `oauth-поток`), and cross-script pairs (`каскад` ↔ `cascade`, `навык` ↔ `skill`) act as a translation bridge. Neighbour lists are symmetric and cross-script bridges cannot be evicted.

- **RU:** кандидаты теперь берутся из FTS5 по префиксам стемов, а не из «последних 1600 строк»: старые чаты снова достижимы, стоимость запроса не растёт вместе с базой. Стемы кандидатов кэшируются (recall перестал перетокенизировать каждый чанк).
- **EN:** candidates come from FTS5 stem-prefix matching instead of "the newest 1600 rows": old chats are reachable again and per-query cost stops growing with the store. Candidate stems are cached (recall no longer re-tokenizes every chunk).

- **RU:** цитаты: в блоке памяти у каждой записи стоит `#ref · kind · ws · дата`, новый tool `memory_source` и `/api/memory-hub/source?ref=` разворачивают ссылку в сессию, ход и полный текст.
- **EN:** citations: every injected item carries `#ref · kind · ws · date`; the new `memory_source` tool and `/api/memory-hub/source?ref=` expand a reference into its session, turn and full text.

- **RU:** внешний доступ: MCP-сервер `tools/memory-hub-mcp.mjs` (stdio, без зависимостей) с `memory_search/source/save/goal/stats` и read-only `/api/memory-hub/search` — память видят opencode, Claude Code и любые MCP-клиенты.
- **EN:** external access: `tools/memory-hub-mcp.mjs` MCP server (stdio, no dependencies) with `memory_search/source/save/goal/stats`, plus read-only `/api/memory-hub/search` — opencode, Claude Code and any MCP client can read the same memory.

- **RU:** eval-харнесс `tools/memory-eval.mjs`: time-split проверка (запрос ищется только по тому, что было ДО него), recall@1/3/5, MRR, ложные срабатывания, сетка порогов, gold-пробы (`tools/gold.example.jsonl`).
- **EN:** `tools/memory-eval.mjs` harness: time-split evaluation (a query only sees what existed BEFORE it), recall@1/3/5, MRR, false-fire rate, threshold grid, gold probes (`tools/gold.example.jsonl`).

- **RU:** приватность и изоляция: `redact: true` вычищает ключи/JWT/пароли до записи, `excludeProjects` не индексирует целые workspace, `privateProjects` не отдаёт их чанки в чужой recall; обслуживание SQLite (FTS optimize, wal_checkpoint, PRAGMA optimize) и срок хранения шагов `stepRetentionDays`.
- **EN:** privacy and isolation: `redact: true` strips keys/JWT/passwords before indexing, `excludeProjects` skips whole workspaces, `privateProjects` never leaks their chunks into another workspace's recall; SQLite maintenance (FTS optimize, wal_checkpoint, PRAGMA optimize) and `stepRetentionDays`.

### Changed / Изменено

- **RU:** формула скоринга: `0.60·cos + 0.24·точное покрытие + 0.12·ассоциативное покрытие + 0.06·свой ws + 0.04·свежесть`. Порог пересчитан по сетке eval на живой базе: `minRecallScore` 0.86 → 0.64, `recallLimit` 1 → 2, `recallChars` 300 → 320. Измерено: recall@1 0.762 → 0.857, MRR 0.881 → 0.921, ложные срабатывания 0 → 0 при срабатывании 23.7% ходов.
- **EN:** scoring formula: `0.60·cos + 0.24·exact coverage + 0.12·associative coverage + 0.06·own ws + 0.04·recency`. Threshold re-measured by the eval grid on the live store: `minRecallScore` 0.86 → 0.64, `recallLimit` 1 → 2, `recallChars` 300 → 320. Measured: recall@1 0.762 → 0.857, MRR 0.881 → 0.921, false fires 0 → 0 at a 23.7% firing rate.
- **RU:** миграция `PRAGMA user_version` 2 → 3 (плюс колонка `chunks.vver`): пересборка словаря, векторов, векторов целей/конспектов/навыков и тезауруса при старте, ~2.5 с на 4.2 тыс. чанков, фоном; до готовности строки с чужим `vver` не участвуют в скоринге.
- **EN:** schema migration 2 → 3 (plus `chunks.vver`): rebuild of vocabulary, vectors, goal/summary/skill vectors and the thesaurus at startup, ~2.5 s for 4.2k chunks, in the background; rows with a foreign `vver` are excluded from scoring until done.
- **RU:** тюнер `tools/memory-tune.mjs` считает той же формулой и тем же расширением запроса, что и живой recall, — иначе он оптимизировал бы формулу, которой никто не пользуется.
- **EN:** `tools/memory-tune.mjs` now scores with the same formula and query expansion as live recall — otherwise it would optimise a formula nobody runs.

## 0.2.1 — 2026-11-17

### Added / Добавлено

- **RU:** `/api/memory-hub/stats` отдаёт поле `config` с эффективными значениями тюнинга — дашборд и оффлайн-тюнер видят, какие числа реально использует запущенный плагин.
- **EN:** `/api/memory-hub/stats` now reports a `config` field with the effective tuning values, so the dashboard and the offline tuner see the numbers the running plugin actually uses.

### Changed / Изменено

- **RU:** настройки профиля пересчитаны на живой базе (3.8 тыс. чанков, 209 задач): `minRecallScore` 0.32 → 0.86, `recallLimit` 3 → 1, `recallChars` 1000 → 300, `routineMinScore` 0.6 → 0.66, `goalDriftMin` 0.34 → 0.05, `goalGuardChars` 420 → 260, `skillMinScore` 0.66. До правки память подставлялась в 99% ходов по 767 символов, после — в ~22% по 252: точность 0.23 → 0.56, ложные срабатывания 0.97 → 0.07.
- **EN:** profile settings re-measured on the live store (3.8k chunks, 209 tasks): `minRecallScore` 0.32 → 0.86, `recallLimit` 3 → 1, `recallChars` 1000 → 300, `routineMinScore` 0.6 → 0.66, `goalDriftMin` 0.34 → 0.05, `goalGuardChars` 420 → 260, `skillMinScore` 0.66. Before: memory injected on 99% of turns at 767 chars; after: ~22% at 252 — precision 0.23 → 0.56, false positives 0.97 → 0.07.

- **RU:** `goalDriftMin` снижен осознанно: измеренная медиана `cos` между соседними ходами одной сессии — 0.02, поэтому прежние 0.34 давали бы срабатывание сверки почти на каждом ходу.
- **EN:** `goalDriftMin` lowered deliberately: the measured median `cos` between consecutive turns of one session is 0.02, so the old 0.34 would have fired the goal check on nearly every turn.

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
