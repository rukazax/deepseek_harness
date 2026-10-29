# Правила разработки и публикации · Contributing rules

**RU** · [English](#english)

## RU

### 1. Общий контур

1. Каждый плагин DSH оформляется как самостоятельный npm-пакет в `packages/<name>`.
2. Обязательные файлы пакета: `package.json` (с `dsh.bundle.patch`), `cordis.patch.yml`, `README.md`, `LICENSE`.
3. Для MCP-серверов (Python) обязательны: `server.py`, CLI-обёртка (если полезна), `README.md`, `requirements.txt`.

### 2. Глобальное правило публикации

> **Все разрабатываемые по ходу работы плагины выкладываются в GitHub-репозиторий `deepseek_harness`
> и устанавливаются в DeepSeek Harness автоматически — без отдельного запроса и подтверждения пользователя.**

Правило действует по умолчанию для любых новых плагинов, MCP-серверов и их обновлений в рамках проекта.
Исключения: пакет содержит секреты/персональные данные, либо пользователь явно отменил публикацию.

### 3. Оформление публикации

1. Описание — двуязычное: русский и английский, в стиле GitHub (заголовки, таблицы, схемы, примеры).
2. Обязательные разделы: назначение, состав, архитектура/схема, установка, использование, безопасность, лицензия.
3. Изображения и схемы — в `assets/`; Mermaid-диаграммы — в README и `docs/`.
4. Текст — деловой, точный, без лишних конструкций; терминология единая (RU/EN).
5. Стилистика — по авторским материалам проекта: структурность, факты, таблицы, лаконичность.

### 4. Проверка перед публикацией

- [ ] `package.json` валиден, `dsh.bundle.patch` указывает на существующий YAML.
- [ ] `cordis.patch.yml` содержит корректный `insert` с `id`/`name`/`config`.
- [ ] README двуязычный, команды проверены.
- [ ] В репозитории нет токенов, паролей, cookie, персональных данных.
- [ ] Python-файлы проходят `python -m py_compile`, JS — `node --check`.

### 5. Коммиты и версии

- Сообщения коммитов: `<type>: <краткое описание>` (RU/EN допустимы).
- Версии — по SemVer; изменения фиксируются в `CHANGELOG.md`.

---

## English

### 1. Scope

1. Every DSH plugin is a standalone npm package under `packages/<name>`.
2. Required files: `package.json` (with `dsh.bundle.patch`), `cordis.patch.yml`, `README.md`, `LICENSE`.
3. Python MCP servers require: `server.py`, optional CLI wrapper, `README.md`, `requirements.txt`.

### 2. Global publishing rule

> **Every plugin developed during the work is published to the `deepseek_harness` GitHub repository and
> installed into DeepSeek Harness automatically — without a separate user request or confirmation.**

The rule applies by default to new plugins, MCP servers and their updates within the project.
Exceptions: the package contains secrets/personal data, or the user explicitly cancels publication.

### 3. Publication format

1. Bilingual description: Russian and English, GitHub style (headings, tables, diagrams, examples).
2. Required sections: purpose, contents, architecture/diagram, installation, usage, security, license.
3. Images and diagrams in `assets/`; Mermaid diagrams in README and `docs/`.
4. Text is concise, precise and consistent in terminology (RU/EN).
5. Style follows the project author's materials: structure, facts, tables, brevity.

### 4. Pre-publish checklist

- [ ] `package.json` is valid; `dsh.bundle.patch` points to an existing YAML.
- [ ] `cordis.patch.yml` has a valid `insert` with `id`/`name`/`config`.
- [ ] README is bilingual; commands verified.
- [ ] No tokens, passwords, cookies or personal data in the repository.
- [ ] Python files pass `python -m py_compile`; JS passes `node --check`.

### 5. Commits and versions

- Commit messages: `<type>: <short description>` (RU/EN allowed).
- Versions follow SemVer; changes are recorded in `CHANGELOG.md`.

---

© 2026 rukazax · MIT
