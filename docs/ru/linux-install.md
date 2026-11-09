# Linux (Ubuntu) install of the plugin kit

**RU** · [English](#english)

## RU

Профиль DSH на Ubuntu: все бандлы ставятся через `pnpm add file:...`, MCP-серверы лежат в `$DSH_HOME`,
векторная база на быстром NVMe. Windows-пути из бандлов переопределяются в слое пользователя
(`~/.dsh/profiles/<profile>/cordis.patch.yml`) — патч заменяет конфиг строки целиком, поэтому каждый
override повторяет полную конфигурацию.

### Порядок

```bash
# 0) pnpm (если ещё нет)
npm install -g pnpm --prefix ~/.local

# 1) бандлы профиля
cd ~/.dsh/profiles/<profile>
pnpm add \
  "file:<repo>/packages/dsh-mcp-client" \
  "file:<repo>/packages/dsh-locale-ru" \
  "file:<repo>/packages/dsh-memory-hub" \
  "file:<repo>/packages/mcp-github-universal"
# затем добавить имена пакетов в dsh.profile.bundles (package.json)

# 2) stdio-серверы MCP (Python 3.12+, стандартная библиотека)
cp -r packages/mcp-sarex        ~/.dsh/mcp/sarex
cp -r packages/mcp-yandex-mail  ~/.dsh/mcp/yandex-mail
python3 -m py_compile ~/.dsh/mcp/sarex/server.py ~/.dsh/mcp/yandex-mail/server.py

# 3) локальный Git MCP (venv; если ensurepip нет — venv --without-pip + get-pip.py)
python3 -m venv ~/.dsh/venvs/mcp-git          # или: python3 -m venv --without-pip + bootstrap
~/.dsh/venvs/mcp-git/bin/python -m pip install mcp-server-git

# 4) mcp-cua: копия + драйвер
mkdir -p ~/.dsh/bin && cp -r packages/mcp-cua ~/.dsh/bin/cua-mcp
# в dependency добавить @trycua/cua-driver ^0.28.0, затем:
cd ~/.dsh/bin/cua-mcp && pnpm install

# 5) dsh-sync (утилита): скрипты Windows-стороны + bash-хелперы
cp -r packages/dsh-sync ~/.dsh/bin/dsh-sync
# pwsh нужен только на Windows-стороне; Ubuntu — хелперы remote-inventory.sh / remote-push.sh
```

### Слой профиля (cordis.patch.yml) — Linux-адаптации

| Запись | Что переопределяет |
|---|---|
| `dsh-mcp-client` | `servers`: `/usr/bin/python3` + `~/.dsh/mcp/{sarex,yandex-mail}/server.py` |
| `mcp-git-local` | `command: !!js dshHomePath('venvs/mcp-git/bin/python')` (Linux-раскладка venv) |
| `mcp-cua-control` (insert) | `args: [ ~/.dsh/bin/cua-mcp/server.mjs ]` |
| `memory-hub` | `dbPath` — векторная база на NVMe (см. ниже) |
| `workspace-controller` | `documentsDirectory` — рабочие пространства по умолчанию на NVMe (см. ниже) |

Cua-driver 0.28.x поддерживает и Linux (X11), поэтому `mcp-cua` работает не только на Windows.

### Данные на NVMe (btrfs, монтирование /srv/apps)

```yaml
# корень рабочих пространств по умолчанию
- id: workspace-controller
  name: "@deepseek-ai/dsh-api-workspace-controller"
  config:
    documentsDirectory: /srv/apps/dsh
# векторная база и vault
- id: memory-hub
  name: dsh-memory-hub
  config:
    dbPath: /srv/apps/dsh/memory/ctxdb.sqlite
    vaultPath: /srv/apps/dsh/obsidian/vault
```

Перезапустить DSH после правки `dsh.profile.bundles` (patch-слой подхватывается HMR).
