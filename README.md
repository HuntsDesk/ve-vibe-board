# Vibe Board MCP (ve-vibe-board)

Your agent, but it remembers. Firestore-backed MCP server that gives Claude Code (and any MCP-speaking agent) **persistent memory across sessions** — tasks, progress, decisions, and handoff notes that survive context compaction and session death.

**Companion repo**: [`HuntsDesk/ve-kit`](https://github.com/HuntsDesk/ve-kit) — Vibe Coding Framework & Persistent Memory for Claude Code. ve-kit bundles this MCP server, a RIPER-CAT workflow, review-gate hooks, and an optional Docker worker.

> **Part of [Vibe Entrepreneurs](https://vibeentrepreneurs.com)** — a community for any vibe coders shipping real work with AI. Come say hi: **[vibeentrepreneurs.com](https://vibeentrepreneurs.com)**.

---

## Why this exists

Sound familiar?

- You're six tool calls into a refactor. Context compacts. The agent comes back with vibes but no plan.
- You start a new session tomorrow. It re-reads the same files, re-asks the same questions, re-decides things you already decided.
- You watched it write a perfect TodoWrite checklist — then the conversation ended, and the checklist evaporated with it.
- You opened three agents in parallel. None of them know what the others did.

This is what statelessness feels like in practice. The agent is brilliant for an hour and amnesiac forever after.

Vibe Board is where the state goes instead. It's a shared task + session board that lives outside any single conversation — in Firestore, not in context.

- Agents create tasks during planning — they survive the session
- Progress gets tracked during execution — visible to the next run
- Handoff notes get written when sessions end — with references to the exact tasks still open
- The next session calls `board_create_session`, reads the handoff, and resumes where the last one stopped

What you get: an agent that shows up on Tuesday knowing what it was doing on Monday. No re-explaining. No lost plans. No TodoWrite graveyard.

Free to run on Firebase's free tier.

---

## 14 MCP tools

| Category | Tools |
|---|---|
| **Projects** | `board_get_projects`, `board_create_project`, `board_update_project` |
| **Tasks** | `board_get_tasks`, `board_get_task`, `board_create_task`, `board_update_task` (supports moving between projects), `board_bulk_update_tasks` (1-100 at once), `board_delete_task` (safety-guarded) |
| **Sessions** | `board_create_session` (returns last session's handoff), `board_end_session`, `board_get_handoff` |
| **Activity** | `board_log_activity`, `board_get_activity` (cursor-paginated, filterable) |

Fourteen tools, one job: give the agent a place to put state that isn't the conversation.

---

## Install

### 1. Clone + build

```bash
git clone https://github.com/HuntsDesk/ve-vibe-board.git
cd ve-vibe-board
npm install
npm run build
```

### 2. Set up Firebase

Create a Firebase project (free tier works). Enable Firestore in Native mode. Create a service account with `roles/datastore.user` and download the key JSON.

Also create 2 composite indexes:
```bash
gcloud firestore indexes composite create \
  --project=YOUR_PROJECT_ID \
  --collection-group=sessions \
  --field-config field-path=project_id,order=ascending \
  --field-config field-path=status,order=ascending \
  --field-config field-path=ended_at,order=descending

gcloud firestore indexes composite create \
  --project=YOUR_PROJECT_ID \
  --collection-group=tasks \
  --field-config field-path=project_id,order=ascending \
  --field-config field-path=status,order=ascending
```

Wait 1-5 min for indexes to build.

### 3. Configure Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "vibe-board": {
      "command": "node",
      "args": ["/absolute/path/to/ve-vibe-board/dist/index.js"],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/absolute/path/to/your-key.json"
      }
    }
  }
}
```

Allow the tools in `.claude/settings.local.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__vibe-board__board_get_projects",
      "mcp__vibe-board__board_create_project",
      "mcp__vibe-board__board_update_project",
      "mcp__vibe-board__board_get_tasks",
      "mcp__vibe-board__board_get_task",
      "mcp__vibe-board__board_create_task",
      "mcp__vibe-board__board_update_task",
      "mcp__vibe-board__board_bulk_update_tasks",
      "mcp__vibe-board__board_delete_task",
      "mcp__vibe-board__board_create_session",
      "mcp__vibe-board__board_end_session",
      "mcp__vibe-board__board_get_handoff",
      "mcp__vibe-board__board_log_activity",
      "mcp__vibe-board__board_get_activity"
    ]
  },
  "enabledMcpjsonServers": ["vibe-board"]
}
```

### 4. Verify

Start a new Claude Code session and call `board_get_projects`. Empty array = success.

---

## Agent rules (paste into CLAUDE.md)

```markdown
## Vibe Board

Persistent task tracking across sessions via MCP tools (`board_*`).
**Mandatory for every substantive session.**

### Use board tasks, NOT TodoWrite
TodoWrite is ephemeral — dies when the session ends. Board tasks persist.
When you would reach for TodoWrite to track multi-step work, use
`board_create_task` instead.

### Session lifecycle
1. Call `board_create_session` at session start — returns last session's handoff
2. Create/update board tasks as you work
3. Call `board_end_session` with progress summary + handoff notes before stopping
```

Full rule set (proactive triggers, process gates, review protocol) is in [`HuntsDesk/ve-kit`](https://github.com/HuntsDesk/ve-kit) → `docs/ve-kit/02-VIBE-BOARD.md`.

---

## License

MIT. See [LICENSE](./LICENSE).

---

## Related

- [`HuntsDesk/ve-kit`](https://github.com/HuntsDesk/ve-kit) — full Vibe Coding Framework that bundles this MCP server
- [`HuntsDesk/ve-gws`](https://github.com/HuntsDesk/ve-gws) — VE Google Workspace MCP (sibling in the ve-* family)
