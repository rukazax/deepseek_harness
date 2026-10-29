# mcp-sarex

**RU** · [English](#english)

## RU

MCP-сервер для **Sarex** (`https://sarex.dsinv.ru`), транспорт stdio (JSON-RPC 2.0, MCP 2024-11-05).

### Инструменты

| Инструмент | Назначение |
|---|---|
| `sarex_status` | статус авторизации (Keycloak-токен, пользователь, базовый URL) |
| `sarex_notifications` | уведомления пользователя (`GET /api/notifications`) |
| `sarex_request` | произвольный запрос к `/api/*`; запись — только с `confirm=true` |
| `sarex_sso_login` | интерактивный вход: Playwright + Edge, ожидание подтверждения 2FA на телефоне |
| `sarex_session` | состояние сохранённой SSO-сессии |

### Авторизация

1. **API (основной режим):** Keycloak password grant, публичный клиент `admin-cli`; токен передаётся в `Authorization: Bearer`.
2. **Интерактивный SSO (2FA):** `sso_login.py` открывает страницу входа, вводит логин/пароль из
   защищённого хранилища, ждёт одобрения на телефоне и сохраняет cookies в `session.json`.

Учётные данные — `_secrets/credentials.json`:
```json
{ "sarex": { "url": "https://sarex.dsinv.ru", "login": "...", "password": "..." } }
```

### Запуск

```bash
python server.py
python sarex_cli.py status
python sarex_cli.py notifications --page-size 10
python sso_login.py --timeout 300
```

Зависимости: Python 3.12; для `sso_login.py` — `playwright` и установленный Microsoft Edge.

### Лицензия

MIT

---

## English

MCP server for **Sarex** (`https://sarex.dsinv.ru`), stdio transport (JSON-RPC 2.0, MCP 2024-11-05).

### Tools

| Tool | Purpose |
|---|---|
| `sarex_status` | auth status (Keycloak token, user, base URL) |
| `sarex_notifications` | user notifications (`GET /api/notifications`) |
| `sarex_request` | arbitrary `/api/*` request; writes require `confirm=true` |
| `sarex_sso_login` | interactive login: Playwright + Edge, waits for phone 2FA approval |
| `sarex_session` | saved SSO session status |

### Auth

1. **API (default):** Keycloak password grant, public `admin-cli` client; token in `Authorization: Bearer`.
2. **Interactive SSO (2FA):** `sso_login.py` opens the login page, fills credentials from the protected
   store, waits for phone approval and saves cookies to `session.json`.

Credentials come from `_secrets/credentials.json` (never committed).

### Run

```bash
python server.py
python sarex_cli.py status
python sso_login.py --timeout 300
```

Requires Python 3.12; `sso_login.py` needs `playwright` and Microsoft Edge.

### License

MIT
