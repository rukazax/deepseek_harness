# Профиль DSH отдельно от ядра

## Что случилось

16.11.2026 обновление до `0.2.2-rc.3` завершилось отказом старта:

```text
dsh: startup failed: 1 required plugin did not activate
Plugins waiting for services (22):
  agent-loop (required)   sessions
```

## Почему

Модули профиля резолвятся раньше модулей установки. В профиле оставались копии официальных пакетов, закреплённые на `0.2.2-rc.1`. После обновления `@deepseek-ai/dsh-session@0.2.2-rc.1` перестал удовлетворять требованиям ядра, загрузчик отключил ряд как несовместимый, сервис `sessions` не появился — обязательный `agent-loop` не смог активироваться.

## Инвариант

| Правило | Причина |
|---|---|
| нет `@deepseek-ai/*` в `dependencies` профиля | установка уже поставляет эти пакеты |
| пусто в `profile/node_modules/@deepseek-ai/` | тень перехватывает резолв до ядра |
| нет `compatibility.json` | исключения вновь разрешают несовместимые версии |
| нет выведенных бандлов в `dsh.profile.bundles` | остаток мешает загрузке |
| `engines.dsh` у сторонних плагинов | несовместимое ядро отключает плагин, а не DSH |

## Проверка

```powershell
D:\DeepSeek\PC_Admin\dsh-profile-doctor\run-doctor.cmd
D:\DeepSeek\PC_Admin\dsh-profile-doctor\run-doctor.cmd --fix
```

Инструмент — пакет [dsh-profile-doctor](../../packages/dsh-profile-doctor/README.md).
