# dsh-mcp-client

**RU** · [English](#english)

## RU

Плагин **DeepSeek Harness (DSH)**: клиент MCP. Запускает MCP-серверы по stdio, получает список
инструментов (`tools/list`) и регистрирует каждый как родной инструмент DSH с префиксом `<server>__`.

### Возможности

- Поддержка нескольких MCP-серверов одновременно.
- Автоматическая регистрация инструментов с их JSON Schema.
- Таймауты запросов, корректное завершение процессов при выгрузке плагина.
- Не требует прав администратора и открытых портов.

### Установка

```bash
cp -r packages/dsh-mcp-client ~/.dsh/profiles/desktop/node_modules/dsh-mcp-client
```

В `~/.dsh/profiles/desktop/package.json`:

```json
{
  "dependencies": { "dsh-mcp-client": "1.0.0" },
  "dsh": { "profile": { "bundles": ["...", "dsh-mcp-client"] } }
}
```

Перезапустите DSH (или дождитесь горячей перезагрузки профиля).

### Конфигурация (`cordis.patch.yml`)

```yaml
- insert:
    - id: dsh-mcp-client
      name: dsh-mcp-client
      config:
        servers:
          - id: sarex
            command: 'C:\...\python.exe'
            args: ['C:\\...\\_mcp\\sarex\\server.py']
            timeoutMs: 120000
          - id: mail
            command: 'C:\...\python.exe'
            args: ['C:\\...\\_mcp\\yandex-mail\\server.py']
            timeoutMs: 180000
```

Инструменты появятся как `sarex__sarex_status`, `mail__mail_status` и т.д.

### Проверка

```bash
node test-harness.mjs   # stub-контекст DSH: список и вызовы инструментов
```

### Лицензия

MIT

---

## English

A **DeepSeek Harness (DSH)** plugin: MCP client. Spawns MCP servers over stdio, lists their tools
(`tools/list`) and registers each one as a native DSH tool prefixed with `<server>__`.

### Features

- Multiple MCP servers at once.
- Automatic tool registration with JSON Schema parameters.
- Request timeouts and graceful process cleanup on plugin unload.
- No admin rights, no open ports.

### Install

```bash
cp -r packages/dsh-mcp-client ~/.dsh/profiles/desktop/node_modules/dsh-mcp-client
```

Add to `~/.dsh/profiles/desktop/package.json`:

```json
{
  "dependencies": { "dsh-mcp-client": "1.0.0" },
  "dsh": { "profile": { "bundles": ["...", "dsh-mcp-client"] } }
}
```

Restart DSH (or wait for the profile hot reload).

### Configuration (`cordis.patch.yml`)

See the YAML example above; tools appear as `sarex__sarex_status`, `mail__mail_status`, etc.

### Verify

```bash
node test-harness.mjs
```

### License

MIT

## DSH utility tools / Инструменты DSH

Помимо MCP-инструментов, плагин регистрирует служебные инструменты DSH:

| Инструмент | Назначение |
|---|---|
| dsh_restore_kimi_chats | Создаёт нативные DSH-сессии из восстановленных чатов Kimi (_kimi/chats/restore-data.json) через ctx.sessions.create |
| dsh_attach_sessions | Привязывает готовые сессии к workspace через живой workspaceRegistry (валидирует хранилище) и отцепляет устаревшие |

Восстановление сессий: сначала создаются валидные логи (клонирование эталонной сессии с checksum-кадрами),
затем dsh_attach_sessions добавляет их в реестр рабочей папки. Такой порядок проходит штатную проверку DSH.

### EN

Besides MCP tools, the plugin registers DSH utility tools:

| Tool | Purpose |
|---|---|
| dsh_restore_kimi_chats | Creates native DSH sessions from restored Kimi chats (_kimi/chats/restore-data.json) via ctx.sessions.create |
| dsh_attach_sessions | Attaches prepared sessions to a workspace through the live workspaceRegistry (validates persistence) and detaches stale ids |

Restore flow: create valid session logs first (clone a reference session with checksummed frames), then attach them
with dsh_attach_sessions, which passes native DSH validation.
