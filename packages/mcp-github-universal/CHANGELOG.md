# Changelog — mcp-github-universal

## 0.3.0 — 2026-11-17

### Fixed / Исправлено

- **RU:** вызовы GitHub-инструментов больше не падают с `Tool <name> has an output schema but did
  not return structured content`. Причина: SDK `@modelcontextprotocol/client` 2.2.0 требует
  `structuredContent` у любого инструмента с `outputSchema`, а GitHub MCP Server v2.2.0 объявляет
  схемы и отвечает только текстом. Лечение — патч ядра
  `settings/patches/apply-mcp-lenient-structured.py` (оба билда SDK: `index.mjs` и `index.cjs`),
  который применяется из `apply.sh` и переживает обновления DSH.
- **EN:** GitHub tool calls no longer fail with `Tool <name> has an output schema but did not
  return structured content`. The 2.2.0 MCP client requires `structuredContent` for any tool that
  declares an `outputSchema`, while GitHub MCP Server v2.2.0 declares schemas and answers with text
  only. Fixed by the core patch `settings/patches/apply-mcp-lenient-structured.py` (both SDK
  builds), re-applied by `apply.sh` and surviving DSH upgrades.

### Removed / Удалено

- **RU:** `mcp__github-cloud__*` — облачный `api.githubcopilot.com/mcp/x/all` отвечает 403 на любой
  класс токенов на этом хосте и дублировал ~90 имён инструментов локального сервера.
- **EN:** `mcp__github-cloud__*` — the cloud endpoint answers 403 for every token class on this host
  and duplicated ~90 tool names of the local server.
- **RU:** дубль git-сервера. Единственное определение `mcp-git-local` осталось в патче профиля
  (Linux-путь `venvs/mcp-git/bin/python`); пакетная копия ссылалась на Windows `Scripts/python.exe`
  и дралась за тот же id.
- **EN:** the duplicate git server. The single `mcp-git-local` definition now lives in the profile
  patch (Linux `venvs/mcp-git/bin/python`); the packaged copy pointed at Windows
  `Scripts/python.exe` and fought over the same id.

### Changed / Изменено

- **RU:** toolsets теперь настраиваются одной строкой в `/etc/dsh/dsh-github.env`; текущий набор
  `default,actions,gists,notifications,code_security` — 62 инструмента вместо 91 при `all`.
- **EN:** toolsets are configured with one line in `/etc/dsh/dsh-github.env`; the current set
  `default,actions,gists,notifications,code_security` — 62 tools instead of 91 with `all`.
- **RU:** `failOnStartupError: true` у github-части — сервер обязателен, сломанный GitHub-доступ
  должен быть виден в журнале, а не молчать.
- **EN:** `failOnStartupError: true` on the GitHub part — the server is mandatory and a broken
  GitHub access must be visible in the journal instead of staying silent.

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
