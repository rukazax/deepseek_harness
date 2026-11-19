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

### Граф знаний (0.4.0)

Вторая половина памяти — **LightRAG** (сервис `lightrag` на `127.0.0.1:9621`).
Векторный поиск не умеет «через проект»: он находит похожий текст, но не связь
«эту же поломку чинили в другом workspace». Граф умеет — из корпуса памяти
извлекаются сущности и отношения, и по ним идёт многошаговый поиск.

| Что | Как |
|---|---|
| Источник | уже вычищенный корпус `ctxdb.sqlite` (все чаты, все workspace, Obsidian) — не сырые логи |
| Когда спрашивается | только при **слабом** локальном совпадении (`lightragWeakBelow`), prefetch фоном на `user/message`, кеш 10 минут |
| Токены | `only_need_context` без генерации ответа; thinking выключен — извлечение сущностей структурное, рассуждение там не нужно |
| Модель | DeepSeek-V4.1-Flash `effort=low` через локальный шлюз `ds-llm-bridge` (8317) |
| Эмбеддинги | локальная `bge-m3` (8318), 1024 dim, CPU — ноль API-токенов |
| Синхронизация | `lightrag-index.timer` каждые 20 минут: `ingest.py --incremental`, неизменные документы не пересчитываются |

Инструменты: `memory_graph` (модель), `GET /api/memory-hub/graph?q=…` (клиенты),
`GET /api/memory-hub/lightrag` (диагностика). Файлы и запуск —
`/srv/apps/dsh/lightrag/README.md`.

### Память проекта и контроль цели

Версия 0.2.0 расширяет плагин от «перекрёстной памяти» до **контроля сохранности цели проекта**:

- **документируется всё** — запрос, каждый вызов инструмента и каждая команда попадают в `mh_steps` с меткой workspace; ход закрывается задачей, сессия — конспектом «запрос → результат» (`mh_sessions`);
- **цель как вектор** — на первом содержательном запросе сессии создаётся цель в `mh_goals` вместе с вектором; шаги увеличивают её прогресс, закрытие — `memory_goal` с `done` или `drop`;
- **сверка шага с целью** — если близость текущего запроса к цели падает ниже `goalDriftMin` (0.34), в промпт добавляется блок «Память проекта (сверка с целью)»: формулировка цели и последние действия, ≤ `goalGuardChars` (420 символов), не чаще раза в два хода;
- **навыки** — из успешного хода с командами и решением собирается навык; второй успех поднимает его до `active`, и при похожем запросе подставляется готовый порядок действий;
- **единый индекс** — проектные записи остаются в тех же `chunks` и FTS5, поэтому `memory_search` видит и старые чаты, и новые шаги, и рутины, и навыки;
- **устойчивость** — миграция по `PRAGMA user_version` (0 → 2), самовосстановление файла базы, все операции в `try/catch`: обновление ядра или сбой записи не ломают чат.

### Словарь и тезаурус (0.3.0)

Версия 0.3.0 закрывает слабую семантику прежнего вектора — без единого токена:

| Что | Как устроено |
|---|---|
| Подписанное хэширование | 8192 бакета и отдельный знак на фичу: коллизия больше не складывается с весом слова, а гасит его |
| Стемминг RU/EN | «каскад / каскада / каскаду» → один стем; список окончаний короткий и предсказуемый |
| Триграммы краёв | `^кас`, `$ада` для опечаток и редких форм |
| Тезаурус `mh_terms` | PPMI по окну 8 токенов на собственном корпусе; соседи дают жаргон (`сжат` → `dcp`) и переводы (`каскад` ↔ `cascade`, `навык` ↔ `skill`) |
| Расширение запроса | к запросу добавляются соседи: 2 того же алфавита + 3 кросс-алфавитных, вес 0.45 |
| Кандидаты | FTS5 по префиксам стемов вместо «последних 1600 строк»: старые чаты снова достижимы |
| Цитаты | `#ab12cd34 · task · pc_admin · 17.11`, разворот — `memory_source` или `/api/memory-hub/source?ref=` |

Тезаурус строится локально (~1 с на 4 тыс. чанков) при старте и обновляется раз в неделю; при отсутствии таблицы recall работает как раньше, без расширения.

### Внешние клиенты и проверка качества

- **MCP:** `node tools/memory-hub-mcp.mjs` — stdio-сервер без зависимостей (`memory_search`, `memory_source`, `memory_save`, `memory_goal`, `memory_stats`); DSH_DB задаётся через `MEMORY_HUB_DB`. Одна и та же база доступна opencode, Claude Code и любым MCP-клиентам.
- **HTTP:** `GET /api/memory-hub/search?q=…&limit=5` (read-only) и `GET /api/memory-hub/source?ref=…`.
- **Eval:** `node tools/memory-eval.mjs --grid` — time-split проверка (запрос видит только прошлое), recall@1/3/5, MRR, ложные срабатывания, сетка порогов; `--gold tools/gold.example.jsonl` добавляет ручные пробы.
- **Приватность:** `redact: true` вырезает ключи, JWT и `password: …` до записи; `excludeProjects` не индексирует workspace, `privateProjects` не отдаёт его чанки в чужой recall.

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

### Точность и автотюнинг (раз в две недели) 🎛

Пороги recall — не константы, они измеряются на самой базе и обновляются по расписанию.

Команда: `/srv/apps/dsh/bin/dsh-memory-tune` (обёртка) → `/srv/apps/dsh/bin/dsh-memory-tune.mjs` (тюнер).

Что делает тюнер:

| Шаг | Как |
|---|---|
| Разметка | из базы, без ручного gold-набора: «почти-повторы» задач в разных сессиях (общие редкие слова + покрытие ≥45%) — что память и обязана находить; негативы — продолжения и короткие подтверждения, на которых память должна молчать; пары соседних ходов дают полосу для `goalDriftMin` |
| Оценка | скоринг воспроизводится теми же функциями плагина (`embed`, `cosine`, `coverage`, `clip`), поэтому оффлайн-метрики совпадают с живым recall |
| Перебор | сетка `minRecallScore` × `recallLimit`, жёсткий потолок ложных срабатываний 15%, полезность = 0.55·precision + 0.45·recall − стоимость − штраф за шум; берётся середина плато, а не край |
| Бюджет | `recallChars` = измеренный p95 блока + запас; `goalGuardChars` фиксируется отдельно |
| Применение | правка блока `- id: memory-hub` в `cordis.patch.yml`, проверка YAML, перезапуск `dsh-web`, проверка `/api/memory-hub/stats`, откат при неудаче |

Ключевое свойство: тюнер **сначала считает текущую конфигурацию** на тех же метках и пишет патч только если прирост полезности ≥0.02 — «уже оптимально» является нормальным исходом, поэтому настройки не дёргаются каждую ночь.

```bash
/srv/apps/dsh/bin/dsh-memory-tune --dry-run --force   # измерить, ничего не менять
/srv/apps/dsh/bin/dsh-memory-tune --force             # применить + перезапустить
journalctl -u dsh-memory-tune -n 30                   # что было ночью
tail -f /srv/apps/dsh/memory/tune.log
```

Расписание: `dsh-memory-tune.timer` срабатывает **каждую ночь в 03:30**, а скрипт применяет изменения только если с прошлого применённого прогона прошло **≥14 дней** — итоговая каденция ровно раз в две недели в ночном окне, пропущенная ночь лечится следующей. История прогонов — `/srv/apps/dsh/memory/tune-history.jsonl`, снимки базы (3 последних) — `/srv/apps/dsh/memory/snapshots/`, эффективные значения видны в `/api/memory-hub/stats` в поле `config`.

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

#### Vocabulary and thesaurus (0.3.0)

Version 0.3.0 closes the weak-semantics gap of the old vector — without a single token:

| What | How |
|---|---|
| Signed hashing | 8192 bins plus a per-feature sign: a collision no longer adds weight, it cancels |
| RU/EN stemming | `каскад / каскада / каскаду` → one stem; the ending list is short and predictable |
| Edge trigrams | `^кас`, `$ада` for typos and rare forms |
| `mh_terms` thesaurus | PPMI over an 8-token window on the corpus itself; neighbours give jargon (`сжат` → `dcp`) and translations (`каскад` ↔ `cascade`, `навык` ↔ `skill`) |
| Query expansion | 2 same-script + 3 cross-script neighbours at weight 0.45 |
| Candidates | FTS5 stem-prefix matching instead of "the newest 1600 rows": old chats are reachable |
| Citations | `#ab12cd34 · task · pc_admin · 17.11`, expanded by `memory_source` or `/api/memory-hub/source?ref=` |

The thesaurus is built locally (~1 s for 4k chunks) at startup and refreshed weekly; without the table recall falls back to the old behaviour.

#### External clients and quality checks

- **MCP:** `node tools/memory-hub-mcp.mjs` — a dependency-free stdio server (`memory_search`, `memory_source`, `memory_save`, `memory_goal`, `memory_stats`); set `MEMORY_HUB_DB`. The same store serves opencode, Claude Code and any MCP client.
- **HTTP:** `GET /api/memory-hub/search?q=…&limit=5` (read-only) and `GET /api/memory-hub/source?ref=…`.
- **Eval:** `node tools/memory-eval.mjs --grid` — time-split evaluation, recall@1/3/5, MRR, false fires, threshold grid; `--gold tools/gold.example.jsonl` adds hand probes.
- **Privacy:** `redact: true` strips keys, JWTs and `password: …` before indexing; `excludeProjects` skips a workspace, `privateProjects` never leaks it into another workspace's recall.

Cost: injections are character-bounded and return an empty string when nothing matches (zero tokens). Load: one SQLite file in WAL mode with `synchronous=NORMAL`, batched step writes (up to 24 rows per transaction), hashed vectors instead of embeddings.

Storage: `~/.dsh/memory/ctxdb.sqlite` (WAL); vault: `~/.dsh/obsidian/vault` — both live outside the dsh core and survive updates. Configuration lives in the profile patch row `memory-hub`.

⚠️ The store is lexical-vector (hashed TF-IDF 4096-d + FTS5): fast and local; the upgrade path to e5-small embeddings is a swap of `embed(text, idf)` — the table schema does not change.
