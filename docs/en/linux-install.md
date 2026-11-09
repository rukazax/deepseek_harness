## English

Ubuntu profile: bundles install via `pnpm add file:...`, MCP servers live under `$DSH_HOME`,
the vector store sits on fast NVMe. Windows paths bundled with packages are overridden in the user
layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`) — a patch replaces a row's whole `config`,
so every override restates the full configuration.

### Steps

```bash
# 0) pnpm (if missing)
npm install -g pnpm --prefix ~/.local

# 1) profile bundles
cd ~/.dsh/profiles/<profile>
pnpm add \
  "file:<repo>/packages/dsh-mcp-client" \
  "file:<repo>/packages/dsh-locale-ru" \
  "file:<repo>/packages/dsh-memory-hub" \
  "file:<repo>/packages/mcp-github-universal"
# add the package names to dsh.profile.bundles in package.json

# 2) stdio MCP servers (Python 3.12+, standard library only)
cp -r packages/mcp-sarex        ~/.dsh/mcp/sarex
cp -r packages/mcp-yandex-mail  ~/.dsh/mcp/yandex-mail
python3 -m py_compile ~/.dsh/mcp/sarex/server.py ~/.dsh/mcp/yandex-mail/server.py

# 3) local Git MCP (venv; without ensurepip use --without-pip + get-pip.py)
python3 -m venv ~/.dsh/venvs/mcp-git
~/.dsh/venvs/mcp-git/bin/python -m pip install mcp-server-git

# 4) mcp-cua: copy + driver
mkdir -p ~/.dsh/bin && cp -r packages/mcp-cua ~/.dsh/bin/cua-mcp
# add the dependency @trycua/cua-driver ^0.28.0, then:
cd ~/.dsh/bin/cua-mcp && pnpm install

# 5) dsh-sync (utility): Windows-side scripts + the bash helpers
cp -r packages/dsh-sync ~/.dsh/bin/dsh-sync
# pwsh is needed only on the Windows side; on Ubuntu use remote-inventory.sh / remote-push.sh
```

### Profile layer (cordis.patch.yml) — Linux adaptations

| Row | What it overrides |
|---|---|
| `dsh-mcp-client` | `servers`: `/usr/bin/python3` + `~/.dsh/mcp/{sarex,yandex-mail}/server.py` |
| `mcp-git-local` | `command: !!js dshHomePath('venvs/mcp-git/bin/python')` (Linux venv layout) |
| `mcp-cua-control` (insert) | `args: [ ~/.dsh/bin/cua-mcp/server.mjs ]` |
| `memory-hub` | `dbPath` — vector store on NVMe (see below) |
| `workspace-controller` | `documentsDirectory` — default workspaces on NVMe (see below) |

Cua-driver 0.28.x also supports Linux (X11), so `mcp-cua` is not Windows-only.

### Data on NVMe (btrfs, mounted at /srv/apps)

```yaml
# default workspace root
- id: workspace-controller
  name: "@deepseek-ai/dsh-api-workspace-controller"
  config:
    documentsDirectory: /srv/apps/dsh
# vector store and vault
- id: memory-hub
  name: dsh-memory-hub
  config:
    dbPath: /srv/apps/dsh/memory/ctxdb.sqlite
    vaultPath: /srv/apps/dsh/obsidian/vault
```

Restart DSH after changing `dsh.profile.bundles` (the patch layer is picked up by HMR).

### License

MIT
