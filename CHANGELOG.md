# Changelog

All notable changes to this repository are documented here.
Формат — по [Keep a Changelog](https://keepachangelog.com/), версии — по SemVer.

## [1.1.0] — 2026-10-29

### RU

- **Добавлены инструменты DSH** в `dsh-mcp-client`:
  - `dsh_restore_kimi_chats` — создание нативных DSH-сессий из восстановленных чатов Kimi;
  - `dsh_attach_sessions` — привязка существующих сессий к workspace через живой реестр (с валидацией хранилища)
    и очистка устаревших записей.
- **Восстановлены 5 чатов** в workspace «АМН»: «Учёт MAF», «Символ 4А — ежемесячный отчёт АМН»,
  «Остров 12.2 — ночной монитор почты и папки», «Символ 4А — отчёт», «Остров 12.2 — статус».
- Сессии записаны штатным провайдером DSH (zstd-кадры с контрольными суммами), реестр workspace обновлён live-API.

### EN

- **Added DSH tools** to `dsh-mcp-client`:
  - `dsh_restore_kimi_chats` — create native DSH sessions from restored Kimi chats;
  - `dsh_attach_sessions` — attach existing sessions to a workspace through the live registry (with persistence validation)
    and clean stale entries.
- **Restored 5 chats** into the «АМН» workspace: "Учёт MAF", "Символ 4А — ежемесячный отчёт АМН",
  "Остров 12.2 — ночной монитор почты и папки", "Символ 4А — отчёт", "Остров 12.2 — статус".
- Sessions are written by the native DSH provider (checksummed zstd frames) and the workspace registry is updated via live API.

## [1.0.0] — 2026-10-29

### RU

- **Добавлен** `dsh-mcp-client` — плагин DSH, клиент MCP: запускает MCP-серверы и регистрирует их инструменты
  как родные инструменты DSH (`<server>__<tool>`).
- **Добавлен** `mcp-sarex` — MCP-сервер Sarex: Keycloak-авторизация, уведомления, произвольные запросы к API,
  интерактивный вход с 2FA (Playwright + Edge).
- **Добавлен** `mcp-yandex-mail` — MCP-сервер Яндекс.Почты: статус, папки, быстрый поиск по заголовкам,
  чтение письма и вложений, отправка.
- **Добавлена** двуязычная документация (RU/EN), схемы Mermaid, изображения, правила публикации и безопасности.
- **Зафиксировано** глобальное правило: новые плагины публикуются автоматически, без отдельного запроса.

### EN

- **Added** `dsh-mcp-client` — DSH plugin, MCP client: spawns MCP servers and registers their tools as
  native DSH tools (`<server>__<tool>`).
- **Added** `mcp-sarex` — Sarex MCP server: Keycloak auth, notifications, generic API requests,
  interactive 2FA login (Playwright + Edge).
- **Added** `mcp-yandex-mail` — Yandex Mail MCP server: status, folders, fast header search,
  message/attachment read, send.
- **Added** bilingual documentation (RU/EN), Mermaid diagrams, images, publishing and security rules.
- **Established** the global rule: new plugins are published automatically without a separate request.
