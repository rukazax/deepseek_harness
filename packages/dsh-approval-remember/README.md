# dsh-approval-remember

<p align="center">
  <img src="../../assets/dsh-approval-remember.png" alt="Галочка «Запомнить выбор» в строке кнопок подтверждения" width="760">
</p>

**RU** · [English](#english)

## RU

Клиентский плагин DeepSeek Harness, который добавляет в окно «Ожидание подтверждения» галочку
**«Запомнить выбор»** — правее кнопок «Отклонить» и «Разрешить один раз», в той же строке.

Если галочка отмечена, выбор запоминается для этого типа запроса (по заголовку подтверждения):
следующие такие же запросы разрешаются автоматически, без повторного вопроса. Остальные запросы
по-прежнему требуют подтверждения.

### Поведение

- Галочка вставляется в `actionRow` панели подтверждения (после кнопки «Разрешить один раз»).
- Отметка сохраняется в `localStorage` (`dsh.approvalRemember.v1`).
- При повторном запросе с тем же заголовком панель появляется уже с отмеченной галочкой
  и автоматически нажимает «Разрешить один раз».
- Снятие галочки удаляет запомненное правило.
- Язык подписи выбирается автоматически: «Запомнить выбор» (RU) / «Remember choice» (EN).

### Установка

```powershell
# DSH должен быть закрыт
& "<DSH>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add `
    "link:<путь>\АМН\_plugins\dsh-approval-remember"
```

Перезапустите DSH: клиентские бандлы собираются при старте.
После перезапуска откройте любой запрос с подтверждением — галочка появится в строке кнопок.

### Управление запомненными выборами

В консоли DevTools (F12) web-интерфейса DSH:

```js
window.__dshApprovalRemember.list()    // текущие запомненные заголовки
window.__dshApprovalRemember.clear()   // очистить все запомненные выборы
```

### Безопасность

- Плагин работает только в браузерном рендерере, не в Host-процессе.
- Запомненные правила локальны (localStorage) и не передаются на сервер.
- Автоподтверждение срабатывает только при точном совпадении заголовка подтверждения;
  для остальных действий вопрос сохраняется.

### Лицензия

MIT.

---

## English

A DeepSeek Harness client plugin that adds a **"Remember choice"** checkbox to the
"Waiting for approval" panel — to the right of the "Reject" and "Allow once" buttons, in the same row.

When the checkbox is checked, the decision is remembered for that request headline: subsequent identical
requests are approved automatically without asking again. Other requests still require confirmation.

### Behavior

- The checkbox is inserted into the approval `actionRow` (after "Allow once").
- The choice is stored in `localStorage` (`dsh.approvalRemember.v1`).
- On a later request with the same headline the panel opens with the checkbox checked and clicks "Allow once".
- Unchecking the box deletes the remembered rule.
- The label is localized automatically: "Запомнить выбор" (RU) / "Remember choice" (EN).

### Install

```powershell
# DSH must be closed
& "<DSH>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add `
    "link:<path>\АМН\_plugins\dsh-approval-remember"
```

Restart DSH: client bundles are built at startup. After that, open any approval prompt — the checkbox appears
in the button row.

### Managing remembered choices

In the DSH web DevTools console (F12):

```js
window.__dshApprovalRemember.list()    // remembered headlines
window.__dshApprovalRemember.clear()   // forget everything
```

### Security

- Runs in the browser renderer only; nothing executes in the Host process.
- Remembered rules are local (localStorage) and never sent to a server.
- Auto-approval fires only on an exact headline match; other actions still ask.

### License

MIT.
