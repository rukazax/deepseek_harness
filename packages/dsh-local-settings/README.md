# dsh-local-settings

Host half of the DSH settings layer at `/srv/apps/dsh/settings`.

It adjusts the running `directoryPicker` service through its public capability
object: a browse-capability `list()` called without a path (which is exactly what
the "add workspace" dialog does when it opens) resolves to
`DSH_PICKER_START` instead of the operator's home directory. No core file is
modified, so `npm i -g @deepseek-ai/dsh` cannot undo it.

The native zenity/kdialog dialog takes no start-directory argument at all; the
`bin/zenity` and `bin/kdialog` shims in the parent layer inject it there. Both
faces read the same `settings.env`.

## Files

- `index.js` — the cordis plugin (`apply`, `inject: ['directoryPicker']`), plus
  the pure helpers `parseSettings`, `resolveStartDirectory`, `applyBrowseStart`.
- `cordis.patch.yml` — the bundle patch that inserts the `local-settings` row.

## Install / verify

```sh
sudo /srv/apps/dsh/settings/install.sh     # wire the profile + systemd (idempotent)
/srv/apps/dsh/settings/bin/dsh-settings verify
```

## Adding a future setting

1. Add `KEY=value` to `/srv/apps/dsh/settings/settings.env` (systemd exports it
   to the dsh process).
2. Read it here with `process.env.KEY`, falling back to `resolveStartDirectory`-
   style file parsing for sessions started outside systemd.
3. Run `dsh-settings verify`, restart `dsh-web`.
