# opencode-memory-hub

**RU** · [English](#english)

Плагин для [OpenCode](https://opencode.ai), который подключает его к **общей памяти DeepSeek Harness**.
Одна и та же SQLite-база (`~/.dsh/memory/ctxdb.sqlite`) используется плагинами
[`dsh-memory-hub`](../dsh-memory-hub) и этим — поэтому проект, его цели, шаги, рутины и навыки
видны обоим агентам, а поиск идёт по единому индексу.

## RU

### Что делает

| Блок | Что делает |
|---|---|
| 📥 Ингест | запрос пользователя, ответ ассистента и закрытие хода пишутся в `tasks`/`templates`/`routines`; заметки зеркалятся в Obsidian-vault и индексируются DSH обратно |
| 🗂 Память проекта | `mh_sessions` (конспект «запрос → результат»), `mh_steps` (каждая команда и вызов инструмента с меткой workspace), `mh_goals` (цели), `mh_skills` (навыки) — те же таблицы, что у DSH |
| 🔎 Recall | гибрид: 0.68·косинус по 4096-мерным хэш-векторам + 0.32·лексическое покрытие + бонус своего workspace + затухание по свежести |
| ⛏ Рутины | нормализованные шаблоны запросов; повтор 2+ раза → рутина с последним решением, fuzzy-matcher находит типовое задание |
| 🎯 Контроль цели | при старте хода создаётся цель (если её нет), на каждом запросе считается `cos(запрос, цель)`; при дрейфе ниже `goalDriftMin` подставляется блок «Память проекта (сверка с целью)» с целью и последними действиями — не чаще раза в два хода, ≤ 420 символов |
| 🏆 Навыки | успешный ход с командами и решением → навык; второй успех делает его `active`; при похожем запросе подставляется порядок действий и результат (принцип Hermes) |

### Инструменты

| Tool | Назначение |
|---|---|
| `memory_search` | гибридный поиск по общей памяти (все чаты, все workspace) |
| `memory_save` | сохранить факт/заметку (через vault, DSH проиндексирует) |
| `memory_routines` | список выученных рутин |
| `memory_style` | профиль стиля автора по накопленным ответам |
| `memory_goal` | цель проекта: `set` / `list` / `done` / `drop` |

### Установка

```bash
# 1) плагин кладётся в конфиг OpenCode
mkdir -p ~/.config/opencode/plugins/memory-hub
cp index.ts ~/.config/opencode/plugins/memory-hub/index.ts
# 2) база создаётся плагином dsh-memory-hub при первом запуске DSH
#    путь: ~/.dsh/memory/ctxdb.sqlite (переопределяется DB_PATH в начале файла)
```

Таблицы `mh_*` создаёт DSH-плагин; пока их нет, OpenCode работает в режиме только чтения и мягко
пропускает проектную память — падений не будет. Все записи идут с `WAL` и `busy_timeout`, любые
ошибки глушатся, чтобы не рвать чат.

## English

An [OpenCode](https://opencode.ai) plugin that connects the editor agent to the **shared DeepSeek
Harness memory**. The very same SQLite file (`~/.dsh/memory/ctxdb.sqlite`) is used by
[`dsh-memory-hub`](../dsh-memory-hub) and by this plugin, so a project's goals, steps, routines and
learned skills are visible to both agents and search runs over one index.

| Block | What it does |
|---|---|
| 📥 Ingest | the user request, the assistant answer and the turn close are written into `tasks`/`templates`/`routines`; notes are mirrored into the Obsidian vault and indexed back by DSH |
| 🗂 Project memory | `mh_sessions` (a “request → result” summary), `mh_steps` (every command and tool call with its workspace tag), `mh_goals`, `mh_skills` — the same tables DSH uses |
| 🔎 Recall | hybrid 0.68·cosine over 4096-d hashed TF-IDF vectors + 0.32·lexical coverage + own-workspace bonus + freshness decay |
| ⛏ Routines | normalized request templates; 2+ occurrences become a routine with its last solution, matched by a fuzzy matcher |
| 🎯 Goal guard | a goal is created on the first substantive request; every prompt measures `cos(request, goal)` and, when it drops below `goalDriftMin`, injects a bounded “goal check” block with the goal and the last actions — at most once per two turns, ≤ 420 characters |
| 🏆 Skills | a successful turn with commands and a solution becomes a skill; a second success promotes it to `active`, and a similar request gets the procedure and its artifact back (the Hermes principle) |

Tools: `memory_search`, `memory_save`, `memory_routines`, `memory_style`, `memory_goal`.

The `mh_*` tables are created by the DSH plugin; until they exist, OpenCode runs read-only and skips
project memory gracefully. All writes use `WAL` with `busy_timeout`, and every failure is swallowed so
a chat is never broken.
