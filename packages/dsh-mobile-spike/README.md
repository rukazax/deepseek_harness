# dsh-mobile-spike

**RU** · [English](#english)

## RU

Минимальный **спайк DSH-плагина**: монтируется in-process, регистрирует аутентифицированный loopback-маршрут,
поднимает собственный HTTP-листенер и корректно освобождает ресурсы при dispose. Использовался для проверки
контракта плагинов DSH и как основа для `dsh-mobile`.

> Экспериментальный прототип: не для продакшена, публикуется как пример структуры плагина.

### Что показывает

- Cordis-вход `lib/index.js` с `name`, `inject`, `apply(ctx)`.
- `cordis.patch.yml` — корректный `insert` с `id`/`name`/`config`.
- Регистрация loopback-маршрута и собственного HTTP-слушателя.
- TTL/очистка: `ctx.effect(() => dispose)`.

### Запуск

```powershell
& "<DSH>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add `
    "link:<путь>\harness\research\plugin-spike"
```

### Лицензия

MIT.

---

## English

A minimal **DSH plugin spike**: mounts in-process, registers an authenticated loopback route,
starts its own HTTP listener and cleanly releases resources on dispose. It was used to validate the DSH
plugin contract and as the basis for `dsh-mobile`.

> Experimental prototype: not for production; published as a plugin-structure example.

### What it demonstrates

- Cordis entry `lib/index.js` with `name`, `inject`, `apply(ctx)`.
- `cordis.patch.yml` with a valid `insert` (`id`/`name`/`config`).
- Loopback route registration and an own HTTP listener.
- TTL/cleanup via `ctx.effect(() => dispose)`.

### Run

```powershell
& "<DSH>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add `
    "link:<path>\harness\research\plugin-spike"
```

### License

MIT.
