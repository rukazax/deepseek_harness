# dsh-composer-alt-enter

**RU** · [English](#english)

## RU

Микро-плагин DeepSeek Harness: в композере чата **Alt+Enter вставляет перенос строки**, обычный
`Enter` продолжает отправлять сообщение, `Shift+Enter` тоже даёт перенос (встроенное поведение),
`Ctrl/Cmd+Enter` — дополнительный режим доставки.

Зачем: DSH сознательно не занимает `Alt+Enter` и отдаёт её application shortcuts — у привычного
переноса через Alt не было владельца. Плагин занимает её в capture-фазе keydown, когда фокус
в активном Lexical-редакторе композера, и вставляет `\n` через официальный мост композера
(`inputActions.insertText` — undoable редактирование); при недоступности моста — `execCommand`
fallback. Событие гасится до Lexical: двойных переносов и ложных отправок нет.

### Как поставить 🚀

```bash
# 1) установка пакета в профиль DSH (plugin_manager → install_bundle), 2) перезапуск DSH
```

Требуется `@deepseek-ai/dsh-client-ui-conversation` (уже в составе Web-профиля). Хостовая половина
пустая (`apply() {}`) — вся работа в клиентском модуле `dsh.client`.

### Поведение

| Нажатие | Результат |
|---|---|
| `Enter` | отправка сообщения (как раньше) |
| `Alt+Enter` | перенос строки ✍️ |
| `Shift+Enter` | перенос строки (встроенно) |
| `Ctrl/Cmd+Enter` | дополнительный режим доставки (встроенно) |
| IME-составление | не перехватывается |

### Тонкости ⚠️

- Вставка работает в plain-режиме композера; во время меню команд (`/`) набор клавиш остаётся у меню —
  это встроенная арбитражная логика, плагин её не ломает.
- Работает во всех чатах и подкампозерах continuable-детей.

---

## English

A micro-plugin for DeepSeek Harness: in the chat composer **Alt+Enter inserts a line break**, plain
`Enter` keeps submitting, `Shift+Enter` also breaks the line (built-in), `Ctrl/Cmd+Enter` uses the
complementary delivery mode.

DSH deliberately leaves Alt+Enter to application shortcuts, so the habitual Alt-break had no owner.
The plugin claims it in the keydown capture phase when the focus is inside the composer's Lexical
editor and inserts `\n` through the composer's official bridge (`inputActions.insertText` — undoable);
with the bridge unavailable an `execCommand` fallback runs. The event is swallowed before Lexical
reacts, so there are no double breaks or accidental sends.

```bash
# install into the DSH profile (plugin_manager → install_bundle), then restart DSH
```

Requires `@deepseek-ai/dsh-client-ui-conversation` (shipped with the Web profile). The host half is
empty (`apply() {}`) — everything happens in the `dsh.client` module.

⚠️ The insertion works in the composer's plain mode; while a command menu (`/`) is open its key
arbitration stays in charge — by design.
