# AGENTS.md — глобальные правила работы · Global working rules

**RU** · [English](#english)

## RU

### 1. Обязательная публикация плагинов

> **Все разрабатываемые по ходу работы плагины выкладываются в GitHub-репозиторий
> [`rukazax/deepseek_harness`](https://github.com/rukazax/deepseek_harness) и устанавливаются в DeepSeek Harness
> автоматически — без отдельного запроса и подтверждения пользователя.**

Правило действует по умолчанию для новых плагинов DSH, MCP-серверов, CLI-обёрток и их обновлений.
Исключения: секреты/персональные данные в пакете; явная отмена пользователем; техническая невозможность
(фиксируется причина).

### 2. Оформление

1. Каждый пакет — в `packages/<name>` по контракту DSH: `package.json` (`dsh.bundle.patch`),
   `cordis.patch.yml`, `README.md`, `LICENSE`.
2. Документация — двуязычная (RU/EN), в стиле GitHub: заголовки, таблицы, схемы, примеры команд.
3. Схемы — Mermaid в README/`docs`; изображения — в `assets/`.
4. Текст — деловой, точный, структурный; терминология единая.
5. Секреты, токены, cookie и персональные данные в репозиторий не попадают.

### 3. Порядок

1. Разработать и проверить пакет (`py_compile`, `node --check`).
2. Обновить `CHANGELOG.md`.
3. Опубликовать в `deepseek_harness` (ветка `main`) и установить в профиль DSH.
4. При невозможности — зафиксировать блокировку и причину.

---

## English

### 1. Mandatory plugin publishing

> **Every plugin developed during the work is published to the
> [`rukazax/deepseek_harness`](https://github.com/rukazax/deepseek_harness) GitHub repository and installed
> into DeepSeek Harness automatically — without a separate user request or confirmation.**

The rule applies by default to new DSH plugins, MCP servers, CLI wrappers and their updates.
Exceptions: secrets/personal data in the package; explicit user cancellation; technical impossibility
(reason recorded).

### 2. Format

1. Each package lives in `packages/<name>` following the DSH contract: `package.json` (`dsh.bundle.patch`),
   `cordis.patch.yml`, `README.md`, `LICENSE`.
2. Documentation is bilingual (RU/EN) in GitHub style: headings, tables, diagrams, command examples.
3. Diagrams as Mermaid in README/`docs`; images in `assets/`.
4. Text is concise, precise and structured; terminology is consistent.
5. Secrets, tokens, cookies and personal data are never committed.

### 3. Procedure

1. Build and verify the package (`py_compile`, `node --check`).
2. Update `CHANGELOG.md`.
3. Publish to `deepseek_harness` (`main`) and install into the DSH profile.
4. If impossible, record the block and the reason.
