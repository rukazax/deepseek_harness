# Global rule (EN)

See [RU version](../ru/global-rule.md) for the full bilingual document. Statement:

> **Every plugin developed during the work is published to the [`rukazax/deepseek_harness`](https://github.com/rukazax/deepseek_harness)
> GitHub repository and installed into DeepSeek Harness automatically — without a separate user request or confirmation.**

Scope: new DSH plugins, new MCP servers and CLI wrappers, updates, accompanying docs.

Default procedure:

1. Build the package per the DSH contract.
2. Check `python -m py_compile`, `node --check`, no secrets.
3. Write a bilingual (RU/EN) GitHub-style description.
4. Publish to `deepseek_harness` (`main`).
5. Install/update the package in the DSH profile.
6. Record the change in `CHANGELOG.md`.

Exceptions: secrets/personal data in the package; explicit user cancellation; technical impossibility
(recorded with reason).
