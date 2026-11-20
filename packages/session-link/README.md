# Session link / Связь сессий

Version 1.0.0 — adds cross-workspace session discovery, asynchronous tasks and replies.

- `sessions_list({query?, offset?})`: up to 100 ordinary non-archived sessions in this profile. Does not activate them.
- `session_send({sessionId, message})`: wakes/resumes the recipient using the native Session Controller, then queues one ordinary follow-up. A receipt is not task completion. `afterSeq` excludes older assistant output.
- `session_result({sessionId, afterSeq?, timeoutMs?})`: native passive wait, up to eight assistant messages, 1500 characters each; excludes reasoning. Output may include unrelated concurrent work. Approval/question waits are reported, not approved automatically.

For a reply, ask the recipient to use `session_send` to the sender id carried in the incoming message. No automatic forwarding or polling loop. A normal final answer is readable with `session_result`.

## Boundaries

Only live ordinary full-access callers can use these tools, including reads. This deliberately does not let restricted sessions delegate out of their sandbox. Recipients retain their existing preset, permissions, approvals, model and working directory; the plugin never selects models or changes policy. Restricted recipients can work within their policy, but cannot send a cross-session reply; read their answer with `session_result`. Subagents keep native tree messaging. Archived recipients are refused before and after activation. Missing/writer-held/migration failures are not silently rerouted.

Native durable `agent-message` source carries plugin-owned `sessionLink` metadata with sender and depth. A host-only raw-log projection limits chains to six hops and eight send attempts per direct human input; reload/resume preserves the counters. Surface replacement by compaction does not reset them. Incoming agent content is not human authorization. Separate human inputs reset the budget. No metadata-only monitor, external services, credentials or dependencies.

## Installation and upgrades

Install this workspace directory with Plugin Manager. Its profile selection and linked source live outside the global DSH npm package, surviving normal core updates and restart. Keep this directory. Compatibility is declared for DSH >=0.2.2-rc.3 <0.3.0: future incompatible versions require review, not an unconditional promise. Disable/remove `@local/dsh-session-link` in Plugin Manager to roll back; no core changes to reverse.

## Live verification

2026-11-18: pc_admin → idle xio accepted a queued task through the native controller. xio sent `DSH_LINK_PONG_20261118` back through `session_send`; pc_admin received that durable cross-session message. Passive `session_result` also read xio's completion. No recipient project work was requested or performed. Rendered Plugin Manager metadata could not be verified because the controlled GUI tab was inaccessible.

2026-11-18, cross-workspace pc_admin → ZVNO (`session-e7b0c88e…`): relayed task landed as durable `user/message` source `agent-message` depth 1 (seq 5472) and started the recipient's own turn 56 on its own model `deepseek-account/deepseek-v4-pro` and its own policy — the plugin selected nothing. The recipient answered `PONG-ZVNO-2WAY` through `session_send` (`accepted:true`, messageId `ac4b586f…`, afterSeq 19611), and passive `session_result` read that reply. The reply landed back in the sender as durable `user/message` source `agent-message` depth 2 (seq 19726), so both legs are in the logs, not just receipts. Live budget projection (`local-session-link-budget`) tracked the same chain: sender `depth 0 / sent 1` before the reply, `depth 2 / sent 1` after, recipient `depth 1 / sent 1` — the hop counter advances from folded raw events and survives restart. No reply was sent to the acknowledgement.

## Check

`npm test` runs the node:test boundary/delivery regression check. `npm run check` checks JavaScript syntax. No build or third-party install scripts.
