# Architecture (EN)

See [RU version](../ru/architecture.md) for the full bilingual document. Summary:

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

| Component | Responsibility |
|---|---|
| `dsh-mcp-client` | MCP process lifecycle, JSON-RPC, tool registration, timeouts, cleanup |
| `mcp-sarex` | Keycloak auth, Sarex API calls, interactive 2FA SSO, session storage |
| `mcp-yandex-mail` | IMAP sessions, header search, body/attachment extraction, SMTP send |

Principles: stdio-only transport; no external business logic in the plugin; secrets stay local;
one failing server does not block other tools.
