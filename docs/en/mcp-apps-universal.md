# mcp-apps-universal — universal MCP connector for Windows applications

**RU** · [English](#english) · [Русский](../ru/mcp-apps-universal.md)

## English

### Why

GitHub search shows ready-made MCP servers already exist for Office, Excel, GIMP and Microsoft SQL
Server, while SketchUp/Navisworks/Foxit/WinRAR have none (custom development, see backlog).
The package connects the **ready-made** servers through `dsh-mcp-client` — one venv per application,
without breaking the dsh core.

### How it works

| Link | Transport | Source | Application version |
|---|---|---|---|
| Office (Word / Excel / PPT / Outlook / Visio / Project) | stdio (`officemcp.exe`) | [OfficeMCP](https://github.com/OfficeMCP/OfficeMCP) | MS Office LTSC 2024 installed |
| Excel (.xlsx) | stdio (`excel-mcp-server.exe stdio`) | [haris-musa/excel-mcp-server](https://github.com/haris-musa/excel-mcp-server) | Excel not required |
| GIMP 3 | stdio (`gimp-mcp.exe`) | [SavithOnline/GimpMCP](https://github.com/SavithOnline/GimpMCP) | GIMP 3.2.4 installed |
| Microsoft SQL Server | stdio (`mssql_mcp_server.exe`) | [RichardHan/mssql_mcp_server](https://github.com/RichardHan/mssql_mcp_server) | LocalDB deferred |

### Setup, step by step

1. **Private venv per server** (isolated dependencies):

   ```bash
   python -m venv ~/.dsh/venvs/app-office
   ~/.dsh/venvs/app-office/Scripts/python.exe -m pip install fastmcp pywin32 -e ~/.dsh/apps-mcp/OfficeMCP
   # …
   ```

2. **git clone** into `~/.dsh/apps-mcp/`: OfficeMCP, excel-mcp-server, GimpMCP, mssql_mcp_server.
3. **Bundle.** `packages/mcp-apps-universal/cordis.patch.yml` → `install_bundle` → restart DSH.
4. **Tools appear as** `mcp__office__*`, `mcp__excel__*`, `mcp__gimp__*`, `mcp__mssql__*`.

### Tool catalogue

| Tool family | Example |
|---|---|
| Office COM | `mcp__office__WriteToWordDocument`, `mcp__office__GetExcelSelection`, … |
| Excel 25 tools | `mcp__excel__create_workbook`, `mcp__excel__write_data_to_excel`, `mcp__excel__format_range`, `mcp__excel__create_chart`, `mcp__excel__create_table`, `mcp__excel__apply_formula` |
| GIMP 3 | `mcp__gimp__run_script_fu`, `mcp__gimp__new_image`, `mcp__gimp__export_image`, `mcp__gimp__add_layer`, `mcp__gimp__add_text_layer`, … |
| SQL Server | `mcp__mssql__read_query`, `mcp__mssql__list_tables`, `mcp__mssql__write_query` |

### Caveats ⚠️

- Tools depend on the **application being installed** on this machine; otherwise the server will
  still start but a call will return a clear error; `failOnStartupError: false` does not break DSH.
- GIMP with headless autostart — if a GUI GIMP is open, its Script-Fu server must be started
  manually (Filters → Development → Script-Fu → Start Server). Autostart is used when no GUI
  process is detected.
- LocalDB: `pymssql` requires TCP with a login; LocalDB defaults to integrated auth over pipe.
  A SQL login is needed. Deferred to wave 2.
- All paths live under `~/.dsh` — outside the dsh core, surviving updates.

Second-wave backlog templates — see `packages/mcp-apps-universal/README.md`.
## Second wave: custom servers (EN)

Wave 2 adds custom-built servers for installed apps without ready-made github MCP:

- **WinRAR** — mcp-custom/winrar/server.py: list/extract/create/test/delete via Rar.exe/UnRAR.exe, cp866 decode. Tools: mcp__winrar__winrar_list, winrar_extract, winrar_create, winrar_test, winrar_delete. Live-tested: list and test on a probe archive.
- **Yandex Disk** — mcp-custom/yadisk/server.py: list/read/search/status over the local synced folder (YANDEX_DISK_ROOT → D:\Яндекс.Диск). Tools: mcp__yadisk__yadisk_list, yadisk_read, yadisk_search, yadisk_status.
- **Microsoft SQL Server** (RichardHan) — deferred: pymssql needs a SQL login+password while LocalDB defaults to integrated auth over named pipe. Once a login exists unlock mcp-mssql.
- Backlog wave 3: Obsidian markdown-vault (ready — pvliesdonk), Windows Edge (chrome-devtools-mcp, node-based), SketchUp 2026 (Ruby COM/API), Foxit PDF Editor (COM), Navisworks 2026 (COM).

Paths: venvs under ~/.dsh/venvs/app-{office,excel,gimp,winrar,yadiskfs}, repo clones under ~/.dsh/apps-mcp/{OfficeMCP,excel-mcp-server,GimpMCP,mssql_mcp_server}; custom servers in ~/.dsh/mcp-custom/{winrar,yadisk}. All outside the dsh core, surviving its updates.
