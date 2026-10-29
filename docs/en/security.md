# Security (EN)

See [RU version](../ru/security.md). Summary:

- Credentials live in `_secrets/credentials.json` (outside the repo); never commit tokens, passwords,
  cookies, session files or personal data.
- Read-only MCP tools are safe; write operations (`sarex__sarex_request` with POST/PUT/PATCH/DELETE,
  `mail__mail_mark_read`, `mail__mail_send`) require `confirm=true`.
- Sarex 2FA: API token via Keycloak password grant has no push prompt; interactive login uses
  Playwright + Edge and requires phone approval; the session file stays local.
- Recommendations: do not sync `_secrets`; revoke credentials on compromise; verify `MANIFEST.sha256`;
  review diffs for secrets before publishing.
