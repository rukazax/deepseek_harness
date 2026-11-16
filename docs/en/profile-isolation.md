# Profile isolated from the dsh core

## What happened

On 2026-11-16 the update to `0.2.2-rc.3` ended in a refused start:

```text
dsh: startup failed: 1 required plugin did not activate
Plugins waiting for services (22):
  agent-loop (required)   sessions
```

## Why

Profile modules resolve before installation modules. The profile still held copies of official packages pinned to `0.2.2-rc.1`. After the update `@deepseek-ai/dsh-session@0.2.2-rc.1` no longer met the core requirements, the loader disabled that row as incompatible, the `sessions` service never appeared, and the required `agent-loop` could not activate.

## Invariant

| Rule | Reason |
|---|---|
| no `@deepseek-ai/*` in profile `dependencies` | the installation already ships them |
| nothing under `profile/node_modules/@deepseek-ai/` | a shadow wins the resolution race |
| no `compatibility.json` | exemptions re-authorise incompatible versions |
| no retired bundles in `dsh.profile.bundles` | leftovers confuse loading |
| `engines.dsh` on third-party plugins | an incompatible core disables the plugin, not DSH |

## Check

```powershell
D:\DeepSeek\PC_Admin\dsh-profile-doctor\run-doctor.cmd
D:\DeepSeek\PC_Admin\dsh-profile-doctor\run-doctor.cmd --fix
```

The tool is the [dsh-profile-doctor](../../packages/dsh-profile-doctor/README.md) package.
