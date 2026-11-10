# mcp-apps-universal

**RU** · [English](#english)

## RU

Универсальный бандл подключения **готовых** MCP-серверов к установленным на ПК приложениям.
Каждый сервер живёт в собственном venv (`~/.dsh/venvs/app-...`) и в клоне репозитория
(`~/.dsh/apps-mcp/...`) — оба пути вне ядра dsh и переживают его обновления. Не создаёт
новых серверов сам, только подключает готовые через `dsh-mcp-client`.

### Состав (первая волна)

| Приложение | MCP-сервер | Что умеет | Запуск |
|---|---|---|---|
| Microsoft Office (COM) | [OfficeMCP](https://github.com/OfficeMCP/OfficeMCP) (Python, 131★) | Word, Excel, PowerPoint, Outlook, Visio, Project — управление **открытыми** документами, Click-to-Run COM | `venvs/app-office/Scripts/officemcp.exe` |
| Excel | [haris-musa/excel-mcp-server](https://github.com/haris-musa/excel-mcp-server) (Python, 4.3k★) | Создание/чтение/редактирование `.xlsx/.xlsm` без Microsoft Excel: таблицы, диаграммы, pivot, формулы, VBA | `venvs/app-excel/Scripts/excel-mcp-server.exe stdio` |
| GIMP 3 | [SavithOnline/GimpMCP](https://github.com/SavithOnline/GimpMCP) (Python) | Живое управление GIMP 3 через Script-Fu; при отсутствии GUI-GIMP запускает headless автостарт | `venvs/app-gimp/Scripts/gimp-mcp.exe`, `GIMP_MCP_AUTOSTART=1` `GIMP_MCP_ALLOW_HEADLESS=1` |
| Microsoft SQL Server | [RichardHan/mssql_mcp_server](https://github.com/RichardHan/mssql_mcp_server) (Python, 404★) | Список таблиц, чтение данных, SQL-запросы (pymssql, TCP) | `venvs/app-mssql/Scripts/mssql_mcp_server.exe` — требует `MSSQL_USER/PASSWORD/DATABASE` (отложено: LocalDB до SQL-логина) |

### Настройка по шагам

1. **venv + клон.** Каждый сервер создан в `~/.dsh/venvs/app-<app>/` (pip install зависимостей
   szerint `pyproject.toml`), исходник клонирован в `~/.dsh/apps-mcp/<repo>`.
2. **Бандл.** `packages/mcp-apps-universal/cordis.patch.yml` — конфликт «один профиль — один
   `serverName` для уникального набора подключений»; OfficeMCP и Excel réзnomensкие.
3. **Установить** bundle в профиль (`install_bundle`), **перезапустить DSH**. Инструменты
   появляются как `mcp__office__*`, `mcp__excel__*`, `mcp__gimp__*`, `mcp__mssql__*`.

### Настройка обратной стороны

- Серверы запускаются с `failOnStartupError: false`, так что без Office/GIMP процесс dsh не падает —
  повторный запуск инструмента даст понятную ошибку.
- Окно для изменений: `cordis.patch.yml`, `GIMP_MCP_*`, `EXCEL_FILES_PATH`, `MSSQL_*`.

### Вторая волна (backlog) 🚧

- [ ] Yandex Disk — готовый `Antiloop-git/yandex-disk-mcp` (нужен OAuth-токен)
- [ ] Obsidian — готовый `pvliesdonk/markdown-vault-mcp` (vault уже в `~/.dsh/obsidian/vault`)
- [ ] Microsoft Edge / Chromium — через `chrome-devtools-mcp` (Node, --browser edge)
- [ ] SketchUp 2026 (Ruby API) — свой сервер, 2-я волна
- [ ] Autodesk Navisworks 2026 (COM API) — свой сервер, 2-я волна
- [ ] Foxit PDF / Adobe Acrobat (COM) — свой сервер, 2-я волна
- [ ] WinRAR (CLI) — свой сервер, 2-я волна

---

## English

Universal bundle that connects **ready-made** MCP servers for applications installed on this PC.
Each server lives in a private venv (`~/.dsh/venvs/app-...`) and a GitHub repo clone
(`~/.dsh/apps-mcp/...`) — both outside the dsh core, surviving its updates. It does not build new
servers itself; it connects the ready ones through `dsh-mcp-client`.

| Application | MCP server | What it does | Launch |
|---|---|---|---|
| Microsoft Office (COM) | [OfficeMCP](https://github.com/OfficeMCP/OfficeMCP) (Python, 131★) | Word, Excel, PowerPoint, Outlook, Visio, Project — controls **open** documents, Click-to-Run COM | `venvs/app-office/Scripts/officemcp.exe` |
| Excel | [haris-musa/excel-mcp-server](https://github.com/haris-musa/excel-mcp-server) (Python, 4.3k★) | Create/read/edit `.xlsx/.xlsm` without Microsoft Excel: tables, charts, pivots, formulas, VBA | `venvs/app-excel/Scripts/excel-mcp-server.exe stdio` |
| GIMP 3 | [SavithOnline/GimpMCP](https://github.com/SavithOnline/GimpMCP) (Python) | Live GIMP 3 control through Script-Fu; headless autostart when GUI GIMP is not running | `venvs/app-gimp/Scripts/gimp-mcp.exe`, `GIMP_MCP_AUTOSTART=1` `GIMP_MCP_ALLOW_HEADLESS=1` |
| Microsoft SQL Server | [RichardHan/mssql_mcp_server](https://github.com/RichardHan/mssql_mcp_server) (Python, 404★) | List tables, read data, run SQL (pymssql, TCP) | `venvs/app-mssql/Scripts/mssql_mcp_server.exe` — requires `MSSQL_USER/PASSWORD/DATABASE` (deferred: LocalDB until a SQL login exists) |

⚠️ Second wave backlog: Yandex Disk (ready-made), Obsidian (ready-made), Edge/Chromium (chrome-devtools-mcp), SketchUp (custom), Navisworks (custom), Foxit PDF (custom), WinRAR (custom).
