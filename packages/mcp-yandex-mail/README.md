# mcp-yandex-mail

**RU** · [English](#english)

## RU

MCP-сервер **Яндекс.Почты** (`amn.control.info@yandex.ru`), транспорт stdio (JSON-RPC 2.0, MCP 2024-11-05).

### Инструменты

| Инструмент | Назначение |
|---|---|
| `mail_status` | статус IMAP, число писем и непрочитанных |
| `mail_folders` | список папок |
| `mail_search` | быстрый поиск по заголовкам (from/subject/text/since/before/unseen), кириллица поддерживается |
| `mail_get` | письмо по UID: заголовки, текст, список вложений |
| `mail_unread` | число непрочитанных в папке |
| `mail_mark_read` | отметить прочитанным (confirm=true) |
| `mail_send` | отправка через SMTP (confirm=true) |

### Скорость

IMAP-соединение переиспользуется внутри процесса, поиск идёт только по заголовкам —
на 28 тыс. писем поиск занимает ~1,5 с.

### Запуск

```bash
python server.py
python mail_cli.py status
python mail_cli.py search --subject "Символ" --limit 5
python mail_cli.py get --uid 28896
```

Учётные данные — `_secrets/credentials.json`:
```json
{ "mail": { "account": "...", "password": "...", "imap": "imap.yandex.ru:993 (SSL)" } }
```

### Лицензия

MIT

---

## English

**Yandex Mail** MCP server, stdio transport (JSON-RPC 2.0, MCP 2024-11-05).

### Tools

| Tool | Purpose |
|---|---|
| `mail_status` | IMAP status, messages and unread counters |
| `mail_folders` | folder list |
| `mail_search` | fast header search (from/subject/text/since/before/unseen), Cyrillic supported |
| `mail_get` | one message by UID: headers, text, attachment list |
| `mail_unread` | unread count for a folder |
| `mail_mark_read` | mark as read (confirm=true) |
| `mail_send` | send via SMTP (confirm=true) |

### Performance

The IMAP connection is reused inside the process; search fetches headers only — about 1.5 s on 28k messages.

### Run

```bash
python server.py
python mail_cli.py status
python mail_cli.py search --subject "Символ" --limit 5
python mail_cli.py get --uid 28896
```

Credentials come from `_secrets/credentials.json` (never committed).

### License

MIT
