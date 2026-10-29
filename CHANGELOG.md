# Changelog

## 2026-10-30 — dsh-sync: синхронизация истории сессий

RU: новый пакет `dsh-sync` — двусторонняя синхронизация истории сессий DSH между Windows-установкой и Linux-инстансом. Переносятся логи сессий и вложения; вызовов моделей нет, токены не тратятся. Ключевая часть — `convert.js`: DSH требует абсолютный `cwd` для своей платформы, поэтому конвертер правит только строку заголовка через карту путей и перепаковывает zstd (первый кадр — заголовок, дальше события без изменений). Оркестратор `sync-dsh-sessions.ps1` считает sha256 обеих сторон, выбирает push/pull, разрешает конфликты по времени с бэкапом, ведёт `state.json` и `sync.log`. Скрипты параметризованы: домашний каталог берётся из `USERPROFILE`, SSH-алиас — из `DSH_SYNC_SSH` (по умолчанию `debian17-root`). Двуязычный README, страницы `docs/ru/dsh-sync.md` и `docs/en/dsh-sync.md`, схемы `assets/dsh-sync-architecture-{ru,en}.svg`, запись в таблице README. Проверено: `node --check`, паритет конвертера с рабочей копией, `-DryRun` проходит.

EN: new `dsh-sync` package — two-way sync of DSH session history between a Windows install and a Linux instance. Session logs and attachments are transferred; no model calls, so no tokens are spent. The core is `convert.js`: DSH requires an absolute `cwd` for its own platform, so the converter rewrites only the header line through a path map and re-frames zstd (first frame is the header, then untouched events). The `sync-dsh-sessions.ps1` orchestrator hashes both sides with sha256, chooses push/pull, resolves conflicts by modification time with backups, and maintains `state.json` and `sync.log`. Scripts are parameterised: the home directory comes from `USERPROFILE`, the SSH alias from `DSH_SYNC_SSH` (default `debian17-root`). Bilingual README, pages `docs/ru/dsh-sync.md` and `docs/en/dsh-sync.md`, diagrams `assets/dsh-sync-architecture-{ru,en}.svg`, a row in the README table. Verified: `node --check`, converter parity with the working copy, `-DryRun` passes.

## 2026-10-30 — dsh-mobile: статус и сверка с рабочей связкой

RU: проверено, что все ранее созданные плагины опубликованы (9 пакетов); `dsh-locale-ru` 1.0.0 совпадает с установленным. Найдено расхождение по `dsh-mobile`: в репозитории ранний in-house прототип **0.1.0** (LAN-шлюз `:3081`, pairing, SSE, PWA), а в эксплуатации — **одноимённый upstream** [`saya-ch/dsh-mobile`](https://github.com/saya-ch/dsh-mobile) **0.6.16** (Apache-2.0): другой шлюз, FRP-фуннель, Caddy, Android-приложение `io.github.sayach.dshmobile` 0.6.7. Имя пакета совпадает, поэтому `npm i dsh-mobile` притягивает upstream. Добавлены предупреждение в README пакета (RU/EN), страницы `docs/ru/dsh-mobile.md` и `docs/en/dsh-mobile.md`, схемы `assets/dsh-mobile-relationship-{ru,en}.svg`, уточнена строка в корневом README.

EN: verified that every previously created plugin is published (9 packages) and that `dsh-locale-ru` 1.0.0 matches the installed copy. Found a `dsh-mobile` divergence: the repository holds an early in-house prototype **0.1.0** (LAN gateway `:3081`, pairing, SSE, PWA), while production runs the **same-name upstream** [`saya-ch/dsh-mobile`](https://github.com/saya-ch/dsh-mobile) **0.6.16** (Apache-2.0): a different gateway, an FRP funnel, Caddy and the Android app `io.github.sayach.dshmobile` 0.6.7. The name collides, so `npm i dsh-mobile` pulls upstream. Added a warning to the package README (RU/EN), pages `docs/ru/dsh-mobile.md` and `docs/en/dsh-mobile.md`, diagrams `assets/dsh-mobile-relationship-{ru,en}.svg`, and clarified the root README row.

## 2026-10-30 — документация dsh-approval-remember и dsh-mobile-spike

RU: закрыты пробелы в оформлении. Оба пакета теперь есть в таблицах README (RU и EN), получили двуязычные страницы `docs/ru` и `docs/en` со схемами; для `dsh-mobile-spike` добавлены SVG-схемы жизненного цикла на двух языках. Раньше пакеты существовали в репозитории, но отсутствовали в оглавлении и документации.

EN: documentation gaps closed. Both packages are now listed in the README tables (RU and EN) and have bilingual pages under `docs/ru` and `docs/en` with diagrams; `dsh-mobile-spike` gained lifecycle SVG diagrams in both languages. Previously these packages existed in the repository but were missing from the index and the documentation.


## 2026-10-30 — dsh-locale-ru

RU: новый пакет `dsh-locale-ru` — русский язык веб-интерфейса DSH. Пункт «Русский» в «Настройки → Общие → Язык», 1620+ строк перевода в 30 пространствах имён, откат `ru -> en` для отсутствующих ключей. Хостовая половина пустая (только строка Loader), сборка не нужна, установка офлайн через `tools/install.mjs`. Двуязычный README, страница в `docs/ru` и `docs/en`, схемы `assets/dsh-locale-ru-architecture-{ru,en}.svg` и Mermaid.

EN: new package `dsh-locale-ru` — Russian language for the DSH web UI. A «Русский» entry under Settings -> General -> Language, 1620+ translated lines across 30 namespaces, `ru -> en` fallback for missing keys. The host half is empty (Loader row only), no build step, offline install via `tools/install.mjs`. Bilingual README, pages under `docs/ru` and `docs/en`, diagrams in `assets/dsh-locale-ru-architecture-{ru,en}.svg` plus Mermaid.


## 2026-10-29 — mcp-cua и mcp-kot

RU: два новых пакета. `mcp-cua` даёт агенту DSH computer use на Windows (26 инструментов по умолчанию, 56 с `--all`), `mcp-kot` соединяет чат DSH с агентом Kot в OpenClaw. Двуязычные README, страницы в `docs/ru` и `docs/en`, схемы в `assets`.

EN: two new packages. `mcp-cua` brings computer use to DSH on Windows (26 tools by default, 56 with `--all`), `mcp-kot` links a DSH chat to the Kot agent in OpenClaw. Bilingual READMEs, pages under `docs/ru` and `docs/en`, diagrams in `assets`.


All notable changes to this repository are documented here.
Формат — по [Keep a Changelog](https://keepachangelog.com/), версии — по SemVer.

## [1.4.1] — 2026-10-29

### RU

- dsh-mobile: исправлен дубликат нижней панели вопроса/подтверждения — повторный клик
  по кнопке статуса больше не открывает вторую панель.
- README: добавлен раздел о полном проекте (отдельный репозиторий `rukazax/dsh-mobile`:
  PWA, Android-обёртка, PDF-инструкция, отчёты о проверках).
- Состав репозитория: в таблицу пакетов добавлен dsh-mobile.

### EN

- dsh-mobile: fixed a duplicated approval/question bottom sheet — a second click on the
  status button no longer stacks another sheet.
- README: added a section about the complete project (separate `rukazax/dsh-mobile`
  repository: PWA, Android wrapper, PDF manual, verification reports).
- Repository index: added dsh-mobile to the package table.

## [1.4.0] — 2026-10-29

### RU

- dsh-approval-remember **1.1.0**: галочка «Запомнить выбор» заменена на кнопку **«Разрешать всегда»**.
  Нажатие разрешает текущий запрос и запоминает правило для этого и подобных сценариев (нормализованный
  заголовок: пути/URL/числа/кавычки не влияют на совпадение). Обновлены README, скриншот, миграция старых правил.

### EN

- dsh-approval-remember **1.1.0**: the "Remember choice" checkbox is replaced by an **"Always allow"** button.
  It approves the current request and stores the rule for this and similar scenarios (normalized headline:
  paths/URLs/numbers/quotes do not affect matching). README, screenshot and legacy-rule migration updated.
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
