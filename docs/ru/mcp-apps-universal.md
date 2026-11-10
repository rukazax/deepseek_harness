# mcp-apps-universal — универсальный MCP-соединитель приложений Windows

**RU** · [English](../en/mcp-apps-universal.md)

## RU

### Зачем

Поиск по GitHub показал: под Office, Excel, GIMP, Microsoft SQL Server уже есть проверенные MCP-серверы.
Под SketchUp/Navisworks/Foxit/WinRAR — нет (их придется разрабатывать, см. backlog). Пакет подключает
**готовые** серверы через `dsh-mcp-client` — по одному venv на приложение, ничего не ломает ядро dsh.

### Как работает

<p align="center">
  <img width="0" role="img" aria-hidden="" src="data:," >
</p>

| Связка | Транспорт | Источник | Версия приложения |
|---|---|---|---|
| Office (Word / Excel / PPT / Outlook / Visio / Project) | stdio (`officemcp.exe`) | [OfficeMCP](https://github.com/OfficeMCP/OfficeMCP) | MS Office LTSC 2024 установлено |
| Excel (.xlsx) | stdio (`excel-mcp-server.exe stdio`) | [haris-musa/excel-mcp-server](https://github.com/haris-musa/excel-mcp-server) | Excel не нужен |
| GIMP 3 | stdio (`gimp-mcp.exe`) | [SavithOnline/GimpMCP](https://github.com/SavithOnline/GimpMCP) | GIMP 3.2.4 установлено |
| Microsoft SQL Server | stdio (`mssql_mcp_server.exe`) | [RichardHan/mssql_mcp_server](https://github.com/RichardHan/mssql_mcp_server) | LocalDB отложено |

### Настройка по шагам

1. **venv по серверу** (изолированные зависимости):

   ```bash
   python -m venv ~/.dsh/venvs/app-office
   ~/.dsh/venvs/app-office/Scripts/python.exe -m pip install fastmcp pywin32 -e ~/.dsh/apps-mcp/OfficeMCP
   # …
   ```

2. **git clone** в `~/.dsh/apps-mcp/`: OfficeMCP, excel-mcp-server, GimpMCP, mssql_mcp_server.
3. **Бандл.** `packages/mcp-apps-universal/cordis.patch.yml` → `install_bundle` → перезапуск DSH.
4. **Тools появляются как** `mcp__office__*`, `mcp__excel__*`, `mcp__gimp__*`, `mcp__mssql__*`.

### Схема вызовов

| Инструменты | Пример |
|---|---|
| Office COM | `mcp__office__WriteToWordDocument`, `mcp__office__GetExcelSelection`, … |
| Excel 25 tools | `mcp__excel__create_workbook`, `mcp__excel__write_data_to_excel`, `mcp__excel__format_range`, `mcp__excel__create_chart`, `mcp__excel__create_table`, `mcp__excel__apply_formula` |
| GIMP 3 | `mcp__gimp__run_script_fu`, `mcp__gimp__new_image`, `mcp__gimp__export_image`, `mcp__gimp__add_layer`, `mcp__gimp__add_text_layer`, … |
| SQL Server | `mcp__mssql__read_query`, `mcp__mssql__list_tables`, `mcp__mssql__write_query` |

### Тонкости ⚠️

- Инструменты зависят от того, что **приложение установлено** на этой машине; иначе сервер поднимется,
  но на вызове будет понятная ошибка, и `failOnStartupError: false` не уронит DSH.
- GIMP с автостартом headless — если в окне открыт используется unheadless? GUI GIMP: Script-Fu server
  должен быть запущен вручную (Filters → Script-Fu → Start Server). Autostart задействуется когда
  GUI процесс не детектится.
- LocalDB: `pymssql` требует TCP с логином, а LocalDB по умолчанию только встроенная auth через pipe.
  Нужен SQL-логин. Отложено во волна 2.
- Все пути в `~/.dsh` — вне ядра dsh, переживают обновления.

Состояние второй волны (шаблоны backfill) — см. `README.md packages/mcp-apps-universal/README.md`.
