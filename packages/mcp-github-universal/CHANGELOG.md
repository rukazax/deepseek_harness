# Changelog — mcp-github-universal

## 0.2.0 — 2026-11-10

### Added / Добавлено

- **RU:** локальный официальный GitHub MCP Server — бинарник v2.1.0 в `$DSH_HOME/bin/github-mcp-server`
  (toolset `github`, до 91 инструмента при `GITHUB_TOOLSETS=all`). Локальный сервер принимает
  fine-grained PAT и работает там, где облачный эндпоинт недоступен.
- **EN:** local official GitHub MCP Server — the v2.1.0 binary at `$DSH_HOME/bin/github-mcp-server`
  (the `github` toolset, up to 91 tools with `GITHUB_TOOLSETS=all`). The local server accepts
  fine-grained PATs and works where the cloud endpoint is unavailable.

### Changed / Изменено

- **RU:** облачный сервер `api.githubcopilot.com/mcp/x/all` перенесён на toolset `mcp__github-cloud__*`:
  проверено, что эндпоинт отвечает 403 «forbidden: access denied» на любой класс токенов
  (gho_-OAuth и fine-grained PAT, оба валидны для api.github.com) — теперь он остаётся
  офлайн-заготовкой и не конфликтует с локальным.
- **EN:** the cloud server `api.githubcopilot.com/mcp/x/all` moved to the `mcp__github-cloud__*`
  toolset: the endpoint answers 403 «forbidden: access denied» to every token class (gho_-OAuth and
  fine-grained PAT, both valid against api.github.com) — it now stays an offline stub and does not
  conflict with the local one.

### Verified / Проверено

- **RU:** sha256 бинарника сверен с `github-mcp-server_2.1.0_checksums.txt`; stdio-диалог
  initialize → tools/list (91 инструмент) → `tools/call get_me` вернул аккаунт владельца токена.
- **EN:** the binary sha256 was verified against `github-mcp-server_2.1.0_checksums.txt`; the stdio
  handshake initialize → tools/list (91 tools) → `tools/call get_me` returned the token owner's account.
