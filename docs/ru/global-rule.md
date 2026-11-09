# Глобальное правило публикации · Global publishing rule

**RU** · [English](#english)

## RU

### Формулировка

> **Все разрабатываемые по ходу работы плагины, настройки и правила — включая созданные ранее —
> выкладываются в GitHub-репозиторий [`rukazax/deepseek_harness`](https://github.com/rukazax/deepseek_harness)
> и устанавливаются/актуализируются в DeepSeek Harness автоматически — без отдельного запроса и
> подтверждения пользователя.**

### Область действия

1. Новые плагины DSH (`packages/<name>`).
2. Новые MCP-серверы и их CLI-обёртки.
3. Обновления существующих плагинов (версии, документация, схемы).
4. Сопутствующие документы: README, архитектура, схемы, изображения и скриншоты, CHANGELOG.
5. Настройки и глобальные правила: изменения профиля DSH и `~/.dsh/AGENTS.md` — с синхронной
   страницей `docs/{ru,en}/global-rule.md`; ранее созданные артефакты (бандл `@local/dsh-github-universal-mcp`,
   правило хомуса) пополняются в репозитории без отставания (backfill).

### Порядок исполнения по умолчанию

1. Разработать пакет по контракту DSH.
2. Проверить: `python -m py_compile`, `node --check`, отсутствие секретов.
3. Сформировать двуязычное описание (RU/EN) в стиле GitHub — человеческим языком, с умеренными эмодзи.
4. Разместить в репозитории `deepseek_harness` (ветка `main`).
5. Установить/обновить пакет в профиле DSH (`~/.dsh/profiles/desktop`).
6. Зафиксировать изменения в `CHANGELOG.md`.

### Исключения

- Пакет содержит секреты, токены, cookie или персональные данные — такие части документируются,
  но не публикуются (например, токен GitHub живёт в локальном хранилище, не в git).
- Пользователь явно отменил публикацию.
- Публикация технически невозможна (нет сети/токена) — тогда фиксируется блокировка и причина.

---

## English

### Statement

> **Every plugin, setting and rule developed during the work — including previously created ones —
> is published to the [`rukazax/deepseek_harness`](https://github.com/rukazax/deepseek_harness) GitHub
> repository and installed/kept current in DeepSeek Harness automatically — without a separate user
> request or confirmation.**

### Scope

1. New DSH plugins (`packages/<name>`).
2. New MCP servers and their CLI wrappers.
3. Updates of existing plugins (versions, docs, diagrams).
4. Accompanying documents: README, architecture, diagrams, images and screenshots, CHANGELOG.
5. Settings and global rules: DSH profile changes and `~/.dsh/AGENTS.md` — mirrored by
   `docs/{ru,en}/global-rule.md`; previously created artefacts (the `@local/dsh-github-universal-mcp`
   bundle, the home rule) are backfilled into the repository without falling behind.

### Default procedure

1. Build the package per the DSH contract.
2. Check: `python -m py_compile`, `node --check`, no secrets.
3. Write a bilingual (RU/EN) GitHub-style description — in human language, with moderate emojis.
4. Publish to `deepseek_harness` (`main` branch).
5. Install/update the package in the DSH profile (`~/.dsh/profiles/desktop`).
6. Record the change in `CHANGELOG.md`.

### Exceptions

- The package contains secrets, tokens, cookies or personal data — such parts are documented but
  not published (for example, the GitHub token lives in a local store, never in git).
- The user explicitly cancelled publication.
- Publication is technically impossible (no network/token) — the block and reason are recorded.
