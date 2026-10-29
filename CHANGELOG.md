# Changelog

All notable changes to this repository are documented here.
Формат — по [Keep a Changelog](https://keepachangelog.com/), версии — по SemVer.

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
