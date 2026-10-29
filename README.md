# DeepSeek Harness · Plugins

<p align="center">
  <img src="assets/banner.svg" alt="DeepSeek Harness plugins" width="100%">
</p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.19-339933.svg">
  <img alt="python" src="https://img.shields.io/badge/python-3.12-3776AB.svg">
  <img alt="dsh" src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.2-4B6BFB.svg">
  <img alt="languages" src="https://img.shields.io/badge/docs-RU%20%7C%20EN-8A2BE2.svg">
</p>

**RU** · [English](#english)

---

## О проекте

Репозиторий плагинов и MCP-серверов для **DeepSeek Harness (DSH)**. Каждый пакет оформлен по правилам DSH:
`package.json` с секцией `dsh.bundle`, `cordis.patch.yml`, документация, тестовый стенд, лицензия.

Комплект решает прикладную задачу: подключить к DSH внешние системы (Sarex, Яндекс.Почта) через
MCP-протокол и дать агентам единый, предсказуемый доступ к ним — без ручных скриптов на каждый случай.

## Состав

| Пакет | Назначение | Стек |
|---|---|---|
| [`dsh-mcp-client`](packages/dsh-mcp-client) | MCP-клиент для DSH: запускает MCP-серверы и регистрирует их инструменты как родные инструменты DSH | Node.js (ESM) |
| [`mcp-sarex`](packages/mcp-sarex) | MCP-сервер Sarex: Keycloak-авторизация, уведомления, произвольные запросы к API, интерактивный вход с 2FA | Python 3.12 |
| [`mcp-yandex-mail`](packages/mcp-yandex-mail) | MCP-сервер Яндекс.Почты: статус, папки, быстрый поиск по заголовкам, чтение, вложения, отправка | Python 3.12 |
| [dsh-approval-remember](packages/dsh-approval-remember) | Кнопка «Разрешать всегда» в окне подтверждения: правило запоминается и применяется к подобным сценариям | DSH client plugin |
| [dsh-mobile-spike](packages/dsh-mobile-spike) | Минимальный спайк плагина: in-process вход, loopback-маршрут, свой HTTP-листенер и корректный dispose | Node.js |
| [`dsh-mobile`](packages/dsh-mobile) | Удалённое управление DSH с телефона: LAN-шлюз, pairing, SSE, PWA и in-process мост к сессиям; просмотр не тратит токены. **Ранний прототип 0.1.0** — в работе используется одноимённый upstream `saya-ch/dsh-mobile` 0.6.16, см. [docs/ru/dsh-mobile.md](docs/ru/dsh-mobile.md) | Node.js + PWA |
| [`mcp-cua`](packages/mcp-cua) | Computer use для Windows: окна, UIA-дерево, скриншоты, клики и ввод через Cua Driver 0.28.0 | Node.js (ESM) |
| [`mcp-kot`](packages/mcp-kot) | Мост к агенту Kot в OpenClaw: один ход агента плюс состояние Gateway, каналов, агентов и сессий | Node.js (ESM) |
| [`dsh-locale-ru`](packages/dsh-locale-ru) | Русский язык веб-интерфейса: пункт «Русский» в настройках и словари для всех клиентских пакетов, откат `ru → en` | Node.js (ESM), без сборки |
| [`dsh-sync`](packages/dsh-sync) | Двусторонняя синхронизация истории сессий DSH между Windows-установкой и Linux-инстансом: sha256, конвертация `cwd` в заголовке, push/pull, бэкапы конфликтов. Утилита, а не плагин: `cordis.patch.yml` не требуется | PowerShell 5.1 + Node.js 22 |

## Архитектура

<p align="center">
  <img src="assets/architecture-ru.png" alt="Архитектура" width="92%">
</p>

```mermaid
flowchart LR
    U[Пользователь] --> DSH[DeepSeek Harness]
    DSH --> P[dsh-mcp-client]
    P -->|stdio JSON-RPC| S1[mcp-sarex]
    P -->|stdio JSON-RPC| S2[mcp-yandex-mail]
    S1 --> KC[Keycloak SSO<br/>realm sarex]
    S1 --> API[Sarex API]
    S2 --> IMAP[IMAP imap.yandex.ru]
    S2 --> SMTP[SMTP smtp.yandex.ru]
```

## Быстрый старт

### 1. Плагин MCP-клиента

```bash
# 1) скопировать пакет в профиль DSH
cp -r packages/dsh-mcp-client ~/.dsh/profiles/desktop/node_modules/dsh-mcp-client

# 2) добавить в профиль: package.json → dsh.profile.bundles, затем перезапустить DSH
```

В DSH появятся инструменты с префиксами `sarex__*` и `mail__*`.

### 2. MCP-серверы (отдельно от DSH)

```bash
python packages/mcp-sarex/server.py            # Sarex MCP (stdio)
python packages/mcp-yandex-mail/server.py      # Яндекс.Почта MCP (stdio)
```

Подключение в MCP-клиентах — см. [README пакета](packages/dsh-mcp-client/README.md).

## Схемы и документация

- [Архитектура и схемы](docs/ru/architecture.md) · [Architecture (EN)](docs/en/architecture.md)
- [Правила разработки и публикации](CONTRIBUTING.md) — двуязычные
- [Глобальное правило публикации](docs/ru/global-rule.md) · [Global rule (EN)](docs/en/global-rule.md)
- [mcp-cua: управление рабочим столом](docs/ru/mcp-cua.md) · [mcp-kot: мост к OpenClaw](docs/ru/mcp-kot.md)
- [dsh-approval-remember: «Разрешать всегда»](docs/ru/dsh-approval-remember.md) · [dsh-mobile-spike: контракт плагина](docs/ru/dsh-mobile-spike.md)
- [dsh-mobile: что в репозитории и что работает](docs/ru/dsh-mobile.md) · [dsh-mobile (EN)](docs/en/dsh-mobile.md)
- [dsh-sync: синхронизация истории сессий](docs/ru/dsh-sync.md) · [dsh-sync (EN)](docs/en/dsh-sync.md)
- [Безопасность и секреты](docs/ru/security.md) · [Security (EN)](docs/en/security.md)

## Правила

1. Плагины разрабатываются по контракту DSH: `package.json` → `dsh.bundle.patch`, `cordis.patch.yml`, README.
2. Каждый пакет автономен: не тянет зависимости хоста без необходимости, не хранит секреты в коде.
3. Все новые плагины публикуются в этот репозиторий **автоматически** — без отдельного запроса и подтверждения.
4. Документация — двуязычная (RU/EN), в стиле GitHub: заголовки, таблицы, схемы, примеры команд.
5. Секреты — только в защищённом хранилище (`_secrets`), не в репозитории.

## Безопасность

- Учётные данные читаются из локального защищённого файла, который **не коммитится**.
- Записывающие операции MCP-инструментов требуют явного `confirm=true`.
- 2FA Sarex: API-токен выдаётся Keycloak без push-подтверждения; интерактивный вход — с подтверждением на телефоне.

## Лицензия

[MIT](LICENSE) © 2026 rukazax

---

## English

Repository of **DeepSeek Harness (DSH)** plugins and MCP servers. Every package follows DSH conventions:
`package.json` with `dsh.bundle`, `cordis.patch.yml`, documentation, test harness, license.

The kit connects DSH to external systems (Sarex, Yandex Mail) through MCP and gives agents a single,
predictable access path — no ad-hoc scripts per task.

| Package | Purpose | Stack |
|---|---|---|
| [`dsh-mcp-client`](packages/dsh-mcp-client) | MCP client for DSH: spawns MCP servers and registers their tools as native DSH tools | Node.js (ESM) |
| [`mcp-sarex`](packages/mcp-sarex) | Sarex MCP server: Keycloak auth, notifications, generic API requests, interactive 2FA login | Python 3.12 |
| [`mcp-yandex-mail`](packages/mcp-yandex-mail) | Yandex Mail MCP server: status, folders, fast header search, read, attachments, send | Python 3.12 |
| [`dsh-approval-remember`](packages/dsh-approval-remember) | «Always allow» button in the approval panel: the rule is remembered and reused for similar scenarios | DSH client plugin |
| [`dsh-mobile-spike`](packages/dsh-mobile-spike) | Minimal plugin spike: in-process entry, loopback route, own HTTP listener and a clean dispose | Node.js |
| [`dsh-mobile`](packages/dsh-mobile) | Remote control of DSH from a phone: LAN gateway, pairing, SSE, PWA and an in-process session bridge; viewing costs no tokens. **Early prototype 0.1.0** — production uses the same-name upstream `saya-ch/dsh-mobile` 0.6.16, see [docs/en/dsh-mobile.md](docs/en/dsh-mobile.md) | Node.js + PWA |
| [`mcp-cua`](packages/mcp-cua) | Computer use for Windows: windows, UIA tree, screenshots, clicks and typing through Cua Driver 0.28.0 | Node.js (ESM) |
| [`mcp-kot`](packages/mcp-kot) | Bridge to the Kot agent in OpenClaw: one agent turn plus Gateway, channel, agent and session state | Node.js (ESM) |
| [`dsh-locale-ru`](packages/dsh-locale-ru) | Russian language for the web UI: a «Русский» entry in settings plus dictionaries for every client package, `ru → en` fallback | Node.js (ESM), no build step |
| [`dsh-sync`](packages/dsh-sync) | Two-way sync of DSH session history between a Windows install and a Linux instance: sha256, header `cwd` conversion, push/pull, conflict backups. A utility, not a plugin: no `cordis.patch.yml` needed | PowerShell 5.1 + Node.js 22 |

```mermaid
flowchart LR
    U[User] --> DSH[DeepSeek Harness]
    DSH --> P[dsh-mcp-client]
    P -->|stdio JSON-RPC| S1[mcp-sarex]
    P -->|stdio JSON-RPC| S2[mcp-yandex-mail]
    S1 --> KC[Keycloak SSO]
    S1 --> API[Sarex API]
    S2 --> IMAP[IMAP]
    S2 --> SMTP[SMTP]
```

### Diagrams and documentation

- [mcp-cua: desktop control](docs/en/mcp-cua.md) · [mcp-kot: OpenClaw bridge](docs/en/mcp-kot.md)
- [dsh-approval-remember: Always allow](docs/en/dsh-approval-remember.md) · [dsh-mobile-spike: plugin contract](docs/en/dsh-mobile-spike.md)
- [dsh-mobile: repo vs running setup](docs/en/dsh-mobile.md) · [dsh-mobile (RU)](docs/ru/dsh-mobile.md)
- [dsh-sync: session history sync](docs/en/dsh-sync.md) · [dsh-sync (RU)](docs/ru/dsh-sync.md)

### Quick start

```bash
cp -r packages/dsh-mcp-client ~/.dsh/profiles/desktop/node_modules/dsh-mcp-client
# add "dsh-mcp-client" to dsh.profile.bundles in package.json, restart DSH
python packages/mcp-sarex/server.py
python packages/mcp-yandex-mail/server.py
```

### Rules

1. Plugins follow the DSH contract (`dsh.bundle.patch`, `cordis.patch.yml`, README).
2. Every package is self-contained and keeps secrets out of code.
3. New plugins are published to this repository **automatically**, without a separate request or confirmation.
4. Documentation is bilingual (RU/EN) in GitHub style: headings, tables, diagrams, command examples.
5. Secrets live only in the local protected store (`_secrets`), never in the repository.

### Security

- Credentials are read from a local protected file that is **never committed**.
- MCP write operations require explicit `confirm=true`.
- Sarex 2FA: the API token is issued by Keycloak without a push prompt; interactive login requires phone approval.

### License

[MIT](LICENSE) © 2026 rukazax
