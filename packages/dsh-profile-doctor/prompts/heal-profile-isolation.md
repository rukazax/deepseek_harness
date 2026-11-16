# Промт: вылечить профиль DSH после обновления ядра

Готовый текст для новой сессии DSH. Скопируйте блок ниже целиком — агент пройдёт диагностику и починку по проверенному сценарию.

---

## Полная версия

```text
Роль: ты инженер DeepSeek Harness (DSH) на Windows. Задача — вылечить профиль после обновления ядра:
приложение не стартует, в логе краша «startup failed: N required plugin did not activate» и список
«Plugins waiting for services», где обязательный плагин ждёт сервис (sessions, storageDomain, agentTeams…).

Известная причина (проверена на практике, не гадай заново):
профиль держит собственные копии официальных пакетов @deepseek-ai/* (в dependencies и в
profile/node_modules). Модули профиля резолвятся РАНЬШЕ модулей установки, поэтому после обновления
ядра загружается старая копия, preflight в dsh-app-boot отключает её как несовместимую, сервис не
появляется ни у кого — и обязательный плагин (обычно agent-loop, ждёт sessions) не активируется.
Разовое исключение compatibility.json усугубляет: оно вновь разрешает заведомо несовместимые версии.

Сделай по шагам.

1. Диагностика по логу
   - Найди самый свежий файл в %APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log (сортировка по имени).
   - Выпиши: версию приложения (app:), плагин с пометкой required, список missing services,
     а также строки «plugins (inactive first)» — какие модули disabled и с какой версией.
   - Сверь версию ядра: dsh --version или поле app в логе.

2. Проверка профиля инструментом
   - Запусти: D:\DeepSeek\PC_Admin\dsh-profile-doctor\run-doctor.cmd --profile desktop --json
   - Если инструмента нет — проверь вручную: profile\package.json (есть ли @deepseek-ai/* в dependencies),
     profile\node_modules\@deepseek-ai (есть ли каталоги), profile\compatibility.json (существует ли),
     dsh.profile.bundles (нет ли dsh-experimental-schedule-bundle и dsh-experimental-agent-team-profile),
     engines.dsh у сторонних плагинов.
   - Каждый [!!] из отчёта — отдельная причина падения, перечисли их в ответе.

3. Подготовка откатa (обязательно до правок)
   - Скопируй в profile\_backup-<дата-время>\ файлы: package.json, pnpm-lock.yaml, cordis.patch.yml,
     compatibility.json. Это единственный источник откатa; данные сессий не трогай.

4. Починка
   - Запусти: D:\DeepSeek\PC_Admin\dsh-profile-doctor\run-doctor.cmd --profile desktop --fix
     Инструмент удаляет @deepseek-ai/* из dependencies, чистит тени в node_modules, удаляет
     compatibility.json, убирает выведенные бандлы и пересобирает зависимости через pnpm из установки DSH.
   - Если инструмента нет, приведи профиль к инварианту вручную и выполни pnpm install из
     <DSH>\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs в каталоге профиля.

5. Проверка результата
   - run-doctor.cmd --profile desktop → все пять пунктов [OK], код возврата 0.
   - Перезапусти DeepSeek Harness и убедись, что старт прошёл: нет нового crash-*.log, сессии и
     сторонние плагины на месте.
   - Если плагин помечен несовместимым ([!!] последней проверки): обнови плагин либо осознанно расширь
     его engines.dsh после проверки на новом ядре. Исключение compatibility.json — только по прямому
     разрешению пользователя.

Инвариант, который должен остаться после работы:
- в profile\package.json нет зависимостей @deepseek-ai/* (официальные бандлы берутся из установки);
- profile\node_modules\@deepseek-ai пуст или отсутствует;
- profile\compatibility.json отсутствует;
- в dsh.profile.bundles нет выведенных бандлов;
- у сторонних плагинов объявлен engines.dsh (например >=0.2.2-rc.1 <0.3.0-0);
- cordis.patch.yml не потерял ни одного ряда настроек.

Ограничения:
- ядро DSH (Program Files\DeepSeek Harness, app.asar, node_modules внутри установки) не изменять и
  pnpm внутри него не запускать;
- конфигурация — только в профиле (~/.dsh/profiles/<profile>/cordis.patch.yml);
- не удалять сессии, не сбрасывать настройки, не выдавать исключения совместимости без разрешения;
- всё делать через файлы профиля и официальные инструменты (plugin_manager, dsh-profile-doctor).

Готово, когда приложение стартует, doctor возвращает 0, набор бандлов не уменьшился (кроме выведенных),
а сторонние плагины активны. В ответе дай короткий отчёт: что было в логе, что исправлено, что проверено,
что осталось и какие файлы/бэкапы остались на диске.
```

## Короткая версия

```text
DSH не стартует после обновления: «startup failed: 1 required plugin did not activate». Вылечи профиль,
не трогая ядро. Проверь свежий %APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log, затем
D:\DeepSeek\PC_Admin\dsh-profile-doctor\run-doctor.cmd --json. Сделай бэкап profile\package.json,
pnpm-lock.yaml, cordis.patch.yml, compatibility.json и запусти тот же скрипт с --fix. Инвариант:
в профиле нет копий @deepseek-ai/* (ни в dependencies, ни в node_modules), нет compatibility.json,
нет выведенных бандлов, у сторонних плагинов есть engines.dsh. Затем перезапусти приложение и
подтверди doctor → все [OK]. Отчёт: причина из лога, что исправлено, что проверено.
```
