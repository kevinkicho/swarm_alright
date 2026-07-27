# Historical note

An earlier design explored a separate “conductor” OpenCode session and multi-role
planner/worker/auditor facilitation.

**Current product direction:** the **system agent is the only lead**. Host stays
dumb (git + dialogue/memory files + SDK turns). See [architecture.md](./architecture.md).

Do not reintroduce team chat, contracts blackboards, or a fourth agent without a
strong reason.
