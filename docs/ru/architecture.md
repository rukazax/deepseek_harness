# Архитектура · Architecture

**RU** · [English](#english)

## RU

### 1. Слои системы

```mermaid
flowchart TB
    subgraph DSH["DeepSeek Harness (DSH)"]
        A[Агент/чат] --> B[Родные инструменты DSH]
        B --> C[dsh-mcp-client<br/>плагин-клиент MCP]
    end
    C -->|stdio JSON-RPC 2.0| D[mcp-sarex]
    C -->|stdio JSON-RPC 2.0| E[mcp-yandex-mail]
    D --> F[Keycloak SSO<br/>realm: sarex]
    D --> G[Sarex API<br/>/api/*]
    E --> H[IMAP imap.yandex.ru:993]
    E --> I[SMTP smtp.yandex.ru:465]
```

### 2. Поток вызова инструмента

```mermaid
sequenceDiagram
    participant U as Пользователь
    participant D as DSH
    participant P as dsh-mcp-client
    participant S as MCP-сервер
    participant X as Внешняя система
    U->>D: запрос
    D->>P: tool.execute(args)
    P->>S: tools/call
    S->>X: HTTP/IMAP
    X-->>S: данные
    S-->>P: content[]
    P-->>D: text/JSON
    D-->>U: результат
```

### 3. Границы ответственности

| Компонент | Ответственность |
|---|---|
| `dsh-mcp-client` | жизненный цикл MCP-процессов, JSON-RPC, регистрация инструментов, таймауты, освобождение ресурсов |
| `mcp-sarex` | авторизация Keycloak, вызовы Sarex API, интерактивный SSO с 2FA, хранение сессии |
| `mcp-yandex-mail` | IMAP-сессии, поиск по заголовкам, извлечение тела/вложений, отправка через SMTP |

### 4. Принципы

1. Транспорт — stdio JSON-RPC 2.0 (MCP 2024-11-05): без сетевых портов и фоновых демонов.
2. Плагин не содержит бизнес-логики внешних систем — только транспорт и регистрацию инструментов.
3. Секреты не покидают локальное защищённое хранилище.
4. Ошибка одного MCP-сервера не блокирует остальные инструменты.

---

## English

### 1. Layers

```mermaid
flowchart TB
    subgraph DSH["DeepSeek Harness (DSH)"]
        A[Agent/chat] --> B[Native DSH tools]
        B --> C[dsh-mcp-client<br/>MCP client plugin]
    end
    C -->|stdio JSON-RPC 2.0| D[mcp-sarex]
    C -->|stdio JSON-RPC 2.0| E[mcp-yandex-mail]
    D --> F[Keycloak SSO]
    D --> G[Sarex API /api/*]
    E --> H[IMAP]
    E --> I[SMTP]
```

### 2. Tool call flow

```mermaid
sequenceDiagram
    participant U as User
    participant D as DSH
    participant P as dsh-mcp-client
    participant S as MCP server
    participant X as External system
    U->>D: request
    D->>P: tool.execute(args)
    P->>S: tools/call
    S->>X: HTTP/IMAP
    X-->>S: data
    S-->>P: content[]
    P-->>D: text/JSON
    D-->>U: result
```

### 3. Responsibility boundaries

| Component | Responsibility |
|---|---|
| `dsh-mcp-client` | MCP process lifecycle, JSON-RPC, tool registration, timeouts, cleanup |
| `mcp-sarex` | Keycloak auth, Sarex API calls, interactive 2FA SSO, session storage |
| `mcp-yandex-mail` | IMAP sessions, header search, body/attachment extraction, SMTP send |

### 4. Principles

1. Transport is stdio JSON-RPC 2.0 (MCP 2024-11-05): no open ports, no background daemons.
2. The plugin holds no external-domain business logic — transport and registration only.
3. Secrets never leave the local protected store.
4. A failing MCP server does not block other tools.
