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
| ⛏ Майнер рутин | нормализованные шаблоны запросов; повтор 2+ раза → рутина с последним известным решением; fuzzy-matcher (слово / префикс≥5 / корень≥4) находит типовое задание и подставляет прошлое решение |
| 🧬 Профиль стиля | счётчики по ответам автора: длина предложений, лексика, эмодзи, маркдаун, RU/EN микс → tool `memory_style` |
| 📊 Еженедельный анализ | ко-встречаемость и мосты между workspace, решения против результатов, текущие и незавершённые цели, рекомендации → Obsidian + дашборд + `memory_analyze`; раз в 7 дней, перезапуск-безопасно |
| 📓 Obsidian | vault в `~/.dsh/obsidian/vault`: Facts/Tasks/Routines/Аналитика/Стиль пишутся автоматически; свои заметки с front-matter `memory-hub: fact` индексируются обратно |
| 🖥 Дашборд | вкладка `🧠 Память` в правой боковой панели + информер под композером: чанки, рутины, подстановки, экономия токенов, кнопки запуска анализа и майнинга |

### Инструменты модели

| Tool | Назначение |
|---|---|
| `memory_search` | поиск по общей памяти (вектор+лексика, метки workspace) |
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
Конфигурация — в row `memory-hub` профильного `cordis.patch.yml`: `recallChars`, пороги, `autoMine`, `weeklyAnalysis`, `vaultSync`, пути.

### Информер и дашборд

Под полем ввода — строка состояния: `🧠 память: N чанк. · M рут. · экономия ≈ K ток` (обновление 20 с).
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
| ⛏ Routine miner | normalized request templates; 2+ occurrences → a routine with the last known solution; a fuzzy matcher (word / prefix≥5 / root≥4) serves the incoming request |
| 🧬 Style profile | counters over the author's answers: sentence length, vocabulary, emoji, markdown, RU/EN mix → tool `memory_style` |
| 📊 Weekly analysis | co-occurrence and bridges between workspaces, decisions vs results, current and unfinished goals, recommendations → Obsidian + dashboard + `memory_analyze`; every 7 days, restart-safe |
| 📓 Obsidian | vault at `~/.dsh/obsidian/vault`: Facts/Tasks/Routines/Analysis/Style are written automatically; your own notes with front-matter `memory-hub: fact` are indexed back |
| 🖥 Dashboard | the right-sidebar tab `🧠 Memory` + the informer under the composer: chunks, routines, injections, token savings, run buttons |

| Tool | Purpose |
|---|---|
| `memory_search` | search the shared memory (vector+lexical, workspace labels) |
| `memory_save` | save a fact/solution (mirrored to Obsidian) |
| `memory_routines` | list routines; approve/forget — on the user-confirmed instruction only |
| `memory_analyze` | causal analysis: dependencies, decisions vs results, goals, recommendations |
| `memory_style` | the learned writing-style profile |

```bash
# install into the DSH profile (plugin_manager → install_bundle), then restart DSH
```

Storage: `~/.dsh/memory/ctxdb.sqlite` (WAL); vault: `~/.dsh/obsidian/vault` — both live outside the dsh core and survive updates. Configuration lives in the profile patch row `memory-hub`.

⚠️ The store is lexical-vector (hashed TF-IDF 4096-d + FTS5): fast and local; the upgrade path to e5-small embeddings is a swap of `embed(text, idf)` — the table schema does not change.
