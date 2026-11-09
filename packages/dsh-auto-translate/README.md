# dsh-auto-translate

**RU** · [English](#english)

## RU

Клиентский плагин **DeepSeek Harness (DSH)**: опциональный автоперевод любых окон и страниц интерфейса
сторонними сервисами. По умолчанию **выключен**; включается и выключается плавающей кнопкой, которую
плагин добавляет поверх интерфейса.

### Возможности

- **Ноль токенов модели**: перевод выполняется в браузере (`fetch` к стороннему API); транскрипты
  сессий не меняются, память и векторная база плагин не индексируют, агент не участвует.
- Кнопка `🌐 автоперевод` (правый нижний угол): видна на каждой странице, клик — включить/выключить;
  выключение возвращает исходные тексты всех переведённых узлов.
- Слежение за всем DOM (`MutationObserver`, debounce 250 мс): всплывающие окна, диалоги, боковые панели,
  новые страницы — переводятся без перезагрузки.
- Сервисы: **MyMemory** (без ключа, по умолчанию; проверки сети автора), **Google** (ключевой `gtx`
  endpoint — может быть заблокирован с некоторых сетей), **Lingva** (proxy к Google без ключа),
  **DeepL Free** (ключ, вводится пользователем и хранится только в `localStorage`).
- Переключение сервиса: `Ctrl`+клик по кнопке циклически; правый клик — ввод сервиса и ключа DeepL.
- Автоопределение цели: текст, уже написанный кириллицей, не переводится.
- Кэш переводов (2000 записей) делает повторные рендеры бесплатными; при сетевых сбоях плагин
  переключается на следующий сервис (лимит сбоев 5, затем минутное окно восстановления).
- Не переводятся: `code`, `pre`, поля ввода, `aria-hidden`, редактируемые узлы и всё, помеченное
  `data-dsh-at-skip`. Кнопка плагина сама помечена так, чтобы не переводить саму себя.

### Установка

```bash
cd ~/.dsh/profiles/<profile>
pnpm add "file:<repo>/packages/dsh-auto-translate"
# добавить имя пакета в dsh.profile.bundles (package.json) и перезапустить DSH
```

Питона/сборки нет: клиентская половина — самодостаточный файл `lib/client.js`.

### Ограничения

- Ключless-сервисы общедоступны и не дают гарантий доступности: MyMemory лимитирует объём
  (~50 000 символов/сутки на IP), Google может отвечать блокировкой. Falls back covers this.
- Атрибуты (`title`, `aria-label`) и placeholder'ы не переводятся — только текстовые узлы.
- Задача плагина — читаемость интерфейса, не идиоматический перевод; качество как у Google Translate.

### Лицензия

MIT

---

## English

A **DeepSeek Harness (DSH)** client plugin: optional auto-translation of any window or page of the
interface through third-party services. **Off by default**; a floating button turns it on and off.

### Features

- **Zero model tokens**: translation runs entirely in the browser (`fetch` to a third-party API);
  session transcripts stay untouched, memory and the vector store never index it, the agent is
  not involved.
- A `🌐 автоперевод` button (bottom right) lives on every page; a click toggles translation, and
  switching it off restores every translated node to the original text.
- Full-DOM watching (`MutationObserver`, 250 ms debounce): pop-ups, dialogs, side panels and newly
  opened pages translate without a reload.
- Services: **MyMemory** (keyless, default), **Google** (keyless gtx endpoint — some networks block it),
  **Lingva** (keyless Google proxy), **DeepL Free** (a key the user enters, stored only in
  `localStorage`).
- Switching: `Ctrl`+click cycles the service; right-click asks for the service and the DeepL key.
- Already-Cyrillic text is detected and left untouched.
- A 2000-entry translation cache makes re-renders free; network failures move to the next service
  (5 failures throttle a service for a minute-long recovery window).
- Never translated: `code`, `pre`, input fields, `aria-hidden`, editable nodes and anything marked
  `data-dsh-at-skip`. The plugin's own button is marked the same way.

### Install

```bash
cd ~/.dsh/profiles/<profile>
pnpm add "file:<repo>/packages/dsh-auto-translate"
# add the package name to dsh.profile.bundles in package.json and restart DSH
```

No Python, no build step: the browser half is one self-contained file, `lib/client.js`.

### Limitations

- Keyless services are communal and availability is not guaranteed: MyMemory throttles volume
  (~50 000 characters/day per IP), Google may answer with a block page. The fallback chain covers this.
- Attributes (`title`, `aria-label`) and placeholders are not translated — text nodes only.
- The goal is readable UI, not idiomatic translation; quality matches Google Translate.

### License

MIT
