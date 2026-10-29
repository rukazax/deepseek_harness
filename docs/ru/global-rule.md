# Глобальное правило публикации · Global publishing rule

**RU** · [English](#english)

## RU

### Формулировка

> **Все разрабатываемые по ходу работы плагины выкладываются в GitHub-репозиторий [`rukazax/deepseek_harness`](https://github.com/rukazax/deepseek_harness)
> и устанавливаются в DeepSeek Harness автоматически — без отдельного запроса и подтверждения пользователя.**

### Область действия

1. Новые плагины DSH (`packages/<name>`).
2. Новые MCP-серверы и их CLI-обёртки.
3. Обновления существующих плагинов (версии, документация, схемы).
4. Сопутствующие документы: README, архитектура, схемы, изображения, CHANGELOG.

### Порядок исполнения по умолчанию

1. Разработать пакет по контракту DSH.
2. Проверить: `python -m py_compile`, `node --check`, отсутствие секретов.
3. Сформировать двуязычное описание (RU/EN) в стиле GitHub.
4. Разместить в репозитории `deepseek_harness` (ветка `main`).
5. Установить/обновить пакет в профиле DSH (`~/.dsh/profiles/desktop`).
6. Зафиксировать изменения в `CHANGELOG.md`.

### Исключения

- Пакет содержит секреты, токены, cookie или персональные данные.
- Пользователь явно отменил публикацию.
- Публикация технически невозможна (нет сети/токена) — тогда фиксируется блокировка и причина.

---

## English

### Statement

> **Every plugin developed during the work is published to the [`rukazax/deepseek_harness`](https://github.com/rukazax/deepseek_harness)
> GitHub repository and installed into DeepSeek Harness automatically — without a separate user request or confirmation.**

### Scope

1. New DSH plugins (`packages/<name>`).
2. New MCP servers and their CLI wrappers.
3. Updates of existing plugins (versions, docs, diagrams).
4. Accompanying documents: README, architecture, diagrams, images, CHANGELOG.

### Default procedure

1. Build the package per the DSH contract.
2. Check: `python -m py_compile`, `node --check`, no secrets.
3. Write a bilingual (RU/EN) GitHub-style description.
4. Publish to `deepseek_harness` (`main` branch).
5. Install/update the package in the DSH profile (`~/.dsh/profiles/desktop`).
6. Record the change in `CHANGELOG.md`.

### Exceptions

- The package contains secrets, tokens, cookies or personal data.
- The user explicitly cancelled publication.
- Publication is technically impossible (no network/token) — the block and reason are recorded.
