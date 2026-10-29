# Безопасность · Security

**RU** · [English](#english)

## RU

### 1. Секреты

- Учётные данные хранятся в `_secrets/credentials.json` (вне репозитория), доступ: владелец + SYSTEM + Администраторы.
- В репозиторий не попадают: токены, пароли, cookie, сессионные файлы, персональные данные.
- Плагины читают секреты по пути из конфигурации; значение в коде отсутствует.

### 2. Права на операции

| Инструмент | Доступ |
|---|---|
| `sarex__sarex_status`, `sarex__sarex_notifications`, `sarex__sarex_session` | чтение |
| `sarex__sarex_request` | GET — чтение; POST/PUT/PATCH/DELETE — только с `confirm=true` |
| `mail__mail_search`, `mail__mail_get`, `mail__mail_unread`, `mail__mail_folders`, `mail__mail_status` | чтение |
| `mail__mail_mark_read`, `mail__mail_send` | только с `confirm=true` |

### 3. 2FA Sarex

- API-доступ: Keycloak password grant (публичный клиент) — без push-подтверждения.
- Интерактивный вход: Playwright + Edge, пароль вводится из защищённого хранилища, подтверждение — на телефоне пользователя.
- Сессия сохраняется локально (`session.json`), в репозиторий не коммитится.

### 4. Рекомендации

1. Не синхронизировать `_secrets` в облака и не передавать в мессенджерах.
2. При компрометации — отозвать пароли приложений и API-ключи.
3. Проверять `MANIFEST.sha256` для контроля целостности секретов.
4. При публикации пакета — проверять отсутствие секретов в diff.

---

## English

### 1. Secrets

- Credentials live in `_secrets/credentials.json` (outside the repository); access: owner + SYSTEM + Administrators.
- Never committed: tokens, passwords, cookies, session files, personal data.
- Plugins read secrets from a configured path; no values in code.

### 2. Operation permissions

| Tool | Access |
|---|---|
| `sarex__sarex_status`, `sarex__sarex_notifications`, `sarex__sarex_session` | read |
| `sarex__sarex_request` | GET — read; POST/PUT/PATCH/DELETE — only with `confirm=true` |
| `mail__*` read tools | read |
| `mail__mail_mark_read`, `mail__mail_send` | only with `confirm=true` |

### 3. Sarex 2FA

- API access: Keycloak password grant (public client) — no push prompt.
- Interactive login: Playwright + Edge, password from the protected store, approval on the user's phone.
- Session is stored locally (`session.json`) and is never committed.

### 4. Recommendations

1. Do not sync `_secrets` to clouds or send it through messengers.
2. On compromise, revoke app passwords and API keys.
3. Verify `MANIFEST.sha256` for secret integrity.
4. Check the diff for secrets before publishing.
