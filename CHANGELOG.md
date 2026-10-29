# Changelog

All notable changes to this repository are documented here.
Формат — по [Keep a Changelog](https://keepachangelog.com/), версии — по SemVer.

## [1.3.0] — 2026-10-29

### RU

- **Добавлен** dsh-approval-remember — клиентский плагин DSH: галочка «Запомнить выбор» в строке кнопок
  окна подтверждения (правее «Отклонить» и «Разрешить один раз»). Запомненный выбор авто-подтверждает
  одинаковые запросы; хранение — localStorage, управление — window.__dshApprovalRemember.
- Скриншот панели, двуязычный README (RU/EN), установка/управление/безопасность.

### EN

- **Added** dsh-approval-remember — DSH client plugin: "Remember choice" checkbox in the approval prompt
  button row (right of "Reject" and "Allow once"). Remembered choices auto-approve identical requests;
  stored in localStorage and managed via window.__dshApprovalRemember.
- Panel screenshot, bilingual README (RU/EN), install/management/security notes.
## [1.2.0] — 2026-10-29

### RU

- **Добавлен** dsh-mobile — удалённое управление DSH с телефона: LAN-шлюз :3081, pairing-коды и device-токены,
  SSE-поток событий, промпты/остановка/approvals, PWA без сборки (раскладные экраны), in-process мост к сессиям.
  Просмотр сессий с телефона не расходует токены.
- **Добавлен** dsh-mobile-spike — минимальный спайк DSH-плагина: loopback-маршрут, собственный HTTP-листенер,
  корректный dispose; пример структуры плагина.
- Двуязычные README (RU/EN), схемы архитектуры, скриншоты PWA, изображения в ssets/.

### EN

- **Added** dsh-mobile — remote control of DSH from a phone: LAN gateway :3081, pairing codes and device tokens,
  SSE event stream, prompts/stop/approvals, build-free PWA (foldables), in-process session bridge.
  Viewing sessions from the phone costs no tokens.
- **Added** dsh-mobile-spike — a minimal DSH plugin spike: loopback route, own HTTP listener, clean dispose;
  a plugin-structure example.
- Bilingual README (RU/EN), architecture diagrams, PWA screenshots, images in ssets/.
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
