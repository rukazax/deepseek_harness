# Prompt: heal a DSH profile after a core update

A ready-to-paste prompt for a fresh DSH session. Copy the block below verbatim — the agent walks the verified diagnosis-and-repair path.

---

## Full version

```text
Role: you are a DeepSeek Harness (DSH) engineer on Windows. Heal a profile after a core update:
the app no longer starts, the crash log says «startup failed: N required plugin did not activate» and lists
«Plugins waiting for services», where a required plugin waits for a service (sessions, storageDomain,
agentTeams…).

Known cause (verified in practice, do not re-derive it):
the profile holds its own copies of official @deepseek-ai/* packages (in dependencies and in
profile/node_modules). Profile modules resolve BEFORE installation modules, so after a core update the
stale copy loads, the dsh-app-boot preflight disables it as incompatible, the service never appears for
anyone, and the required plugin (usually agent-loop waiting for sessions) cannot activate. A one-off
compatibility.json exemption makes it worse: it re-authorises known-incompatible versions.

Proceed step by step.

1. Read the log
   - Find the newest %APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log (sort by name).
   - Record: the app version (app:), the plugin marked required, the missing services, and the
     «plugins (inactive first)» rows — which modules are disabled and at what version.
   - Confirm the core version: dsh --version or the app field of the log.

2. Check the profile
   - Run: D:\DeepSeek\PC_Admin\dsh-profile-doctor\run-doctor.cmd --profile desktop --json
   - Without the tool, check by hand inside %USERPROFILE%\.dsh\profiles\<profile>\:
     package.json (@deepseek-ai/* in dependencies?), node_modules\@deepseek-ai (directories present?),
     compatibility.json (exists?),
     dsh.profile.bundles (any dsh-experimental-schedule-bundle or dsh-experimental-agent-team-profile?),
     engines.dsh on third-party plugins.
   - Every [!!] in the report is a separate failure cause; list them in the answer.

3. Prepare the rollback (mandatory before edits)
   - Copy into %USERPROFILE%\.dsh\profiles\<profile>\_backup-<date-time>\: package.json, pnpm-lock.yaml, cordis.patch.yml,
     compatibility.json. This is the only rollback source; never touch session data.

4. Repair
   - Run: D:\DeepSeek\PC_Admin\dsh-profile-doctor\run-doctor.cmd --profile desktop --fix
     The tool drops @deepseek-ai/* from dependencies, prunes shadows in node_modules, deletes
     compatibility.json, removes retired bundles and rebuilds dependencies with the pnpm shipped inside
     the DSH installation.
   - Without the tool, bring the profile to the invariant manually and run pnpm install from
     <DSH>\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs inside the profile directory.

5. Verify
   - run-doctor.cmd --profile desktop → all five checks [OK], exit code 0.
   - Restart DeepSeek Harness and confirm the start: no new crash-*.log, sessions and third-party
     plugins intact.
   - A plugin flagged incompatible (last check [!!]) must be updated, or its engines.dsh widened
     deliberately after testing on the new core. A compatibility.json exemption only with the user's
     explicit permission.

Invariant to leave behind:
- the profile package.json has no @deepseek-ai/* dependencies (official bundles come from the installation);
- the profile node_modules\@deepseek-ai is empty or absent;
- the profile compatibility.json is absent;
- dsh.profile.bundles holds no retired bundles;
- third-party plugins declare engines.dsh (for example >=0.2.2-rc.1 <0.3.0-0);
- cordis.patch.yml lost none of its configuration rows.

Constraints:
- never modify the DSH core (Program Files\DeepSeek Harness, app.asar, node_modules inside the
  installation) and never run pnpm inside it;
- configuration lives only in the profile (%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml);
- do not delete sessions, do not reset settings, do not grant compatibility exemptions without permission;
- use profile files and official tools only (plugin_manager, dsh-profile-doctor).

Done when the app starts, doctor returns 0, the bundle set did not shrink (besides retired bundles), and
third-party plugins are active. Answer with a short report: the log cause, what was fixed, what was
verified, what remains, and which files/backups are left on disk.
```

## Short version

```text
DSH does not start after an update: «startup failed: 1 required plugin did not activate». Heal the profile
without touching the core. Read the newest %APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log, then run
D:\DeepSeek\PC_Admin\dsh-profile-doctor\run-doctor.cmd --json. Back up profile\package.json,
pnpm-lock.yaml, cordis.patch.yml, compatibility.json and run the same script with --fix. Invariant: the
profile holds no @deepseek-ai/* copies (neither in dependencies nor in node_modules), no compatibility.json,
no retired bundles, and third-party plugins declare engines.dsh. Restart the app and confirm doctor → all
[OK]. Report: the log cause, what was fixed, what was verified.
```
