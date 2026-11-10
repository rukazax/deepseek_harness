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
## Second wave: собственные серверы (RU)

Wave 2: добавлены самописные серверы для приложений, под которые на GitHub ready-made нет:

- **WinRAR** — mcp-custom/winrar/server.py: list/extract/create/test/delete через Rar.exe/UnRAR.exe, cp866-декодирование. Инструменты: mcp__winrar__winrar_list, winrar_extract, winrar_create, winrar_test, winrar_delete. Проверено: list и test на тестовом архиве возвращают содержимое.
- **Яндекс.Диск** — mcp-custom/yadisk/server.py: list/read/search/status поверх локальной зеркальной папки (YANDEX_DISK_ROOT → D:\Яндекс.Диск). Инструменты: mcp__yadisk__yadisk_list, yadisk_read, yadisk_search, yadisk_status.
- **Microsoft SQL Server** (RichardHan) — отложен: для pymssql нужен SQL-логин с паролем; LocalDB по умолчанию работает только через integrated auth (named pipe). Как сделан SQL-логин — row mcp-mssql станет видимым (currently disabled via !!js) .
- Backlog wave 3: Obsidian markdown-vault (готовый — pvliesdonk), Windows Edge (chrome-devtools-mcp, node-based), SketchUp 2026 (Ruby COM/API), Foxit PDF Editor (COM), Navisworks 2026 (COM).

Пути: venv — ~/.dsh/venvs/app-{office,excel,gimp,winrar,yadiskfs}, клон репо — ~/.dsh/apps-mcp/{OfficeMCP,excel-mcp-server,GimpMCP,mssql_mcp_server}; свои серверы в ~/.dsh/mcp-custom/{winrar,yadisk}. Всё вне ядра dsh — переживает его обновления.
---

## Wave 3: собственные серверы (RU)

Wave 3: добавлены ещё четыре **собственные** MCP-сервера:
- **PDF** — mcp-custom/pdf/server.py: pypdf (merge/split/page_count/text_extract) + Foxit PDF Editor COM FoxitPDFEditor.Application и shell-handler (pdf_open_in_foxit). Foxit и Adobe не имеют готовых MCP, поэтому собственный; а pypdf нельзя запустить как CLI.
- **SketchUp** — mcp-custom/sketchup/server.py: COM Sketchup.Application — status/open/eval(Ruby)/export(obj/dae/stl/…). Готовых под SketchUp нет, автор sketchup_mcp отсутствует как рабочий на момент публикации.
- **Navisworks** — mcp-custom/navisworks/server.py: COM Navisworks.Application — status/open/save_as/export(plugin). Готовых под Navisworks нет.
- **Obsidian vault** — mcp-custom/vault/server.py: легковесный лист/read/write/delete/search (по имени и телу заметки) поверх ~/.dsh/obsidian/vault. Используется когда memory-hub не даёт granular editing.

Ин системные: venv ~/.dsh/venvs/app-{pdf,sketchup,navisworks,vault}/, серверы — ~/.dsh/mcp-custom/{pdf,sketchup,navisworks,vault}/.
Связка бандла packages/mcp-apps-universal/cordis.patch.yml расширилась: теперь 9 row dsh-mcp-client (office, excel, gimp, mssql-[disabled], winrar, yadisk, pdf, sketchup, navisworks, vault) — используется константный serverName (mcp-office, mcp-excel, …) и private venv + pywin32 для COM-скриптов.
