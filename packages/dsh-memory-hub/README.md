# dsh-memory-hub

**RU** · [English](#english)

## RU

Общая память DeepSeek Harness по **всем чатам и всем workspace**: агент перед каждым шагом
получает только актуальный кусок общей базы, а не пересказ всей истории. Всё локально:
SQLite-векторное хранилище + FTS5 рядом с профилем, без внешних сервисов и без расхода токенов на поиск.

### Что внутри

| Блок | Что делает |
|---|---|
| 📥 Ингест | поток `session/event` каждого чата: запросы, ответы, ходы; шум и служебные источники отфильтрованы; собственная инъекция не индексируется |
| 🔎 Recall | гибрид 0.68·косинус + 0.32·лексическое покрытие + бонус своего workspace + затухание по свежести; пороги и лимиты — в конфиге |
| 💉 Подстановка | runtime-контекст `memory-hub:recall`: ≤ `recallChars` (по умолчанию 900 символов), только если у текущего запроса есть релевантное прошлым знание — иначе пусто и ноль токенов |
| 🧰 Кэш задач | ход фиксируется как задача: заголовок, workspace, решение; незавершённые ходы видны и подхватываются |
| 🗂 Память проекта | сессии, цели, шаги (команды и вызовы инструментов), конспекты и решения — таблицы `mh_sessions`, `mh_goals`, `mh_steps`, `mh_skills` в той же базе, с метками workspace |
| 🎯 Вектор цели | цель сессии хранится с вектором; на каждом шаге считается близость `cos(запрос, цель)` — при дрейфе ниже `goalDriftMin` в промпт уходит короткая сверка с целью и последними действиями (не чаще раза в два хода) |
| 🏆 Навыки самообучения | успешный ход с командами и решением превращается в навык: два успеха поднимают статус до `active`, при совпадении запроса подставляется порядок действий и прошлый результат — принцип Hermes «опыт → переиспользуемый навык» |
| 🛟 Самовосстановление | `PRAGMA quick_check` при старте; битый файл увозится в `ctxdb.sqlite.corrupt-*`, база создаётся заново, любая ошибка записи не рвёт сессию |
| ⛏ Майнер рутин | нормализованные шаблоны запросов; повтор 2+ раза → рутина с последним известным решением; fuzzy-matcher (слово / префикс≥5 / корень≥4) находит типовое задание и подставляет прошлое решение |
| 🧬 Профиль стиля | счётчики по ответам автора: длина предложений, лексика, эмодзи, маркдаун, RU/EN микс → tool `memory_style` |
| 📊 Еженедельный анализ | ко-встречаемость и мосты между workspace, решения против результатов, текущие и незавершённые цели, рекомендации → Obsidian + дашборд + `memory_analyze`; раз в 7 дней, перезапуск-безопасно |
| 📓 Obsidian | vault в `~/.dsh/obsidian/vault`: Facts/Tasks/Routines/Аналитика/Стиль пишутся автоматически; свои заметки с front-matter `memory-hub: fact` индексируются обратно |
| 🖥 Дашборд | вкладка `🧠 Память` в правой боковой панели + информер под композером: чанки, рутины, подстановки, экономия токенов, кнопки запуска анализа и майнинга |

### Память проекта и контроль цели

Версия 0.2.0 расширяет плагин от «перекрёстной памяти» до **контроля сохранности цели проекта**:

- **документируется всё** — запрос, каждый вызов инструмента и каждая команда попадают в `mh_steps` с меткой workspace; ход закрывается задачей, сессия — конспектом «запрос → результат» (`mh_sessions`);
- **цель как вектор** — на первом содержательном запросе сессии создаётся цель в `mh_goals` вместе с вектором; шаги увеличивают её прогресс, закрытие — `memory_goal` с `done` или `drop`;
- **сверка шага с целью** — если близость текущего запроса к цели падает ниже `goalDriftMin` (0.34), в промпт добавляется блок «Память проекта (сверка с целью)»: формулировка цели и последние действия, ≤ `goalGuardChars` (420 символов), не чаще раза в два хода;
- **навыки** — из успешного хода с командами и решением собирается навык; второй успех поднимает его до `active`, и при похожем запросе подставляется готовый порядок действий;
- **единый индекс** — проектные записи остаются в тех же `chunks` и FTS5, поэтому `memory_search` видит и старые чаты, и новые шаги, и рутины, и навыки;
- **устойчивость** — миграция по `PRAGMA user_version` (0 → 2), самовосстановление файла базы, все операции в `try/catch`: обновление ядра или сбой записи не ломают чат.

Стоимость: подстановки ограничены символами (`recallChars`, `goalGuardChars`), при отсутствии совпадений возвращается пустая строка — ноль токенов. Нагрузка: одна SQLite-база в режиме `WAL` с `synchronous=NORMAL`, пакетная запись шагов (до 24 строк на транзакцию), хэш-векторы вместо эмбеддингов.

### Инструменты модели

| Tool | Назначение |
|---|---|
| `memory_search` | поиск по общей памяти (вектор+лексика, метки workspace) |
| `memory_goal` | цель проекта: `set` / `list` / `done` / `drop`; зафиксированная цель сверяется со всеми следующими шагами |
| `memory_save` | сохранить факт/решение (зеркалится в Obsidian) |
| `memory_routines` | список рутин; approve/forget — только при прямом подтверждении пользователя |
| `memory_analyze` | причинно-следственный анализ: зависимости, решения и результаты, цели, рекомендации |
| `memory_style` | выученный профиль стиля автора |

### Быстрый старт 🚀

```bash
# 1) установка пакета в профиль DSH (plugin_manager → install_bundle)
# 2) перезапуск DSH
```

Хранилище: `~/.dsh/memory/ctxdb.sqlite` (WAL), vault: `~/.dsh/obsidian/vault` — оба вне ядра dsh и переживают обновления.
Конфигурация — в row `memory-hub` профильного `cordis.patch.yml`: `recallChars`, пороги, `autoMine`, `weeklyAnalysis`, `vaultSync`, пути, а также новые `goalDriftMin`, `goalGuardChars`, `skillMinScore`.

### Информер и дашборд

Под полем ввода — строка состояния: `🧠 N чанк. · M рут. · экономия ≈ K ток` (обновление 20 с).
Кнопка «дашборд ↗» и карточка «Memory Hub» в правой боковой панели открывают дашборд с деталями и кнопками запуска.

### Тонкости ⚠️

- Хранилище — лексико-векторное (hashed TF-IDF 4096-d + FTS5): быстро и локально; путь апгрейда к
  эмбеддингам e5-small — замена функции `embed(text, idf)`, схема таблиц не меняется.
- Токены: recall-блок ≈ 240 ток./запрос только при попадании; без релевантной истории — 0.
- В версии 0.1 индексируется активная история: старые сессии подхватываются по мере обращения
  (полный бэкфилльный импортизация — в 0.2.x).

---

## English

Shared DeepSeek Harness memory across **all chats and all workspaces**: before each step the agent
receives only the relevant slice of the shared base, not a recount of history. Everything is local:
an SQLite vector store + FTS5 next to the profile, no external services, no token cost for search.

| Block | What it does |
|---|---|
| 📥 Ingest | the `session/event` feed of every chat: requests, answers, turns; noise and service sources filtered; the plugin's own injection is skipped |
| 🔎 Recall | hybrid 0.68·cosine + 0.32·lexical coverage + own-workspace bonus + freshness decay; thresholds in config |
| 💉 Injection | the `memory-hub:recall` runtime context: ≤ `recallChars` (900 by default), only when relevant past knowledge exists — otherwise empty and zero tokens |
| 🧰 Task cache | every turn is filed as a task: title, workspace, solution; unfinished turns stay visible |
| 🗂 Project memory | sessions, goals, steps (commands and tool calls), summaries and solutions — `mh_sessions`, `mh_goals`, `mh_steps`, `mh_skills` in the same database, tagged by workspace |
| 🎯 Goal vector | a session goal is stored with its vector; every step measures `cos(request, goal)` and, when it drops below `goalDriftMin`, a short goal-vs-step reminder is injected (at most once per two turns) |
| 🏆 Learned skills | a successful turn with commands and a solution becomes a skill: two successes promote it to `active`, and a similar request gets the known procedure back (the Hermes principle: experience → reusable skill) |
| 🛟 Self-healing | `PRAGMA quick_check` at startup; a damaged file is moved to `ctxdb.sqlite.corrupt-*`, a fresh base is created, and no write error ever breaks a chat |
| ⛏ Routine miner | normalized request templates; 2+ occurrences → a routine with the last known solution; a fuzzy matcher (word / prefix≥5 / root≥4) serves the incoming request |
| 🧬 Style profile | counters over the author's answers: sentence length, vocabulary, emoji, markdown, RU/EN mix → tool `memory_style` |
| 📊 Weekly analysis | co-occurrence and bridges between workspaces, decisions vs results, current and unfinished goals, recommendations → Obsidian + dashboard + `memory_analyze`; every 7 days, restart-safe |
| 📓 Obsidian | vault at `~/.dsh/obsidian/vault`: Facts/Tasks/Routines/Analysis/Style are written automatically; your own notes with front-matter `memory-hub: fact` are indexed back |
| 🖥 Dashboard | the right-sidebar tab `🧠 Memory` + the informer under the composer: chunks, routines, injections, token savings, run buttons |

| Tool | Purpose |
|---|---|
| `memory_search` | search the shared memory (vector+lexical, workspace labels) |
| `memory_goal` | project goal: `set` / `list` / `done` / `drop`; a stored goal is checked against every later step |
| `memory_save` | save a fact/solution (mirrored to Obsidian) |
| `memory_routines` | list routines; approve/forget — on the user-confirmed instruction only |
| `memory_analyze` | causal analysis: dependencies, decisions vs results, goals, recommendations |
| `memory_style` | the learned writing-style profile |

```bash
# install into the DSH profile (plugin_manager → install_bundle), then restart DSH
```

#### Project memory and goal control

Version 0.2.0 grows the plugin from cross-chat recall into **guarding the original goal of a project**:

- every request, tool call and shell command lands in `mh_steps` with its workspace tag; a turn closes as a task, a session closes as a compressed “request → result” summary (`mh_sessions`);
- the first substantial request of a session creates a goal in `mh_goals` with its vector; steps bump its progress, and `memory_goal done|drop` closes it;
- when `cos(current request, goal)` falls below `goalDriftMin` (0.34), the model receives a bounded “goal check” block with the goal wording and the last actions — at most once per two turns, ≤ `goalGuardChars` (420 characters);
- a successful turn with commands and a solution becomes a skill; the second success promotes it to `active`, and a similar request gets the known procedure and its artifact back;
- all project records stay inside the same `chunks`/FTS5 index, so `memory_search` sees old chats, new steps, routines and skills alike;
- the schema migrates by `PRAGMA user_version` (0 → 2), the database heals itself when damaged, and every write is wrapped so a failure never breaks a chat.

Cost: injections are character-bounded and return an empty string when nothing matches (zero tokens). Load: one SQLite file in WAL mode with `synchronous=NORMAL`, batched step writes (up to 24 rows per transaction), hashed vectors instead of embeddings.

Storage: `~/.dsh/memory/ctxdb.sqlite` (WAL); vault: `~/.dsh/obsidian/vault` — both live outside the dsh core and survive updates. Configuration lives in the profile patch row `memory-hub`.

⚠️ The store is lexical-vector (hashed TF-IDF 4096-d + FTS5): fast and local; the upgrade path to e5-small embeddings is a swap of `embed(text, idf)` — the table schema does not change.
