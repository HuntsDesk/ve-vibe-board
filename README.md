# Vibe Board MCP (ve-vibe-board)

[![MCP server on Glama](https://glama.ai/mcp/servers/HuntsDesk/ve-vibe-board/badges/card.svg)](https://glama.ai/mcp/servers/HuntsDesk/ve-vibe-board) [![Glama Score](https://glama.ai/mcp/servers/HuntsDesk/ve-vibe-board/badges/score.svg)](https://glama.ai/mcp/servers/HuntsDesk/ve-vibe-board) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![Node](https://img.shields.io/badge/Node-22%2B-brightgreen.svg)](https://nodejs.org/)

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

`GOOGLE_APPLICATION_CREDENTIALS` accepts either a **file path** to the key JSON (canonical) or the **raw JSON contents inline** (handy for sandboxed environments like Glama's browser MCP Inspector, CI secrets, or Cloud Run's inlined-secret pattern).

Also deploy the Firestore composite indexes. The repo ships with `firestore.indexes.json` declaring all 5 required indexes (sessions, tasks, projects, activity_log). Deploy them with one command:

```bash
# From the ve-vibe-board repo root (contains firebase.json + firestore.indexes.json)
firebase use YOUR_PROJECT_ID
firebase deploy --only firestore:indexes
```

Requires the [Firebase CLI](https://firebase.google.com/docs/cli#install_the_firebase_cli) (`npm install -g firebase-tools`) authenticated with an account that has `roles/datastore.indexAdmin` on the project. Wait 1-5 min for indexes to build.

<details>
<summary>Or create them manually via gcloud</summary>

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

gcloud firestore indexes composite create \
  --project=YOUR_PROJECT_ID \
  --collection-group=tasks \
  --field-config field-path=project_id,order=ascending \
  --field-config field-path=assigned_agent,order=ascending \
  --field-config field-path=status,order=ascending

gcloud firestore indexes composite create \
  --project=YOUR_PROJECT_ID \
  --collection-group=projects \
  --field-config field-path=status,order=ascending \
  --field-config field-path=updated_at,order=descending

gcloud firestore indexes composite create \
  --project=YOUR_PROJECT_ID \
  --collection-group=activity_log \
  --field-config field-path=task_id,order=ascending \
  --field-config field-path=created_at,order=descending
```
</details>

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

Drop this into your project's CLAUDE.md (or equivalent agent-instructions file). It's the same protocol the ve-kit framework ships, condensed for standalone MCP installs. The MCP server gives the agent a place to put state — these rules teach it to actually use it.

```markdown
## Vibe Board

Persistent task tracking across sessions via Firebase Firestore MCP tools (`board_*`).
**Mandatory for every substantive session** (any session where you read, write, plan, debug, or deploy code).

### Use Board Tasks, NOT TodoWrite

TodoWrite is ephemeral — it dies when the session ends. Board tasks persist forever and enable cross-session handoff. When you would reach for TodoWrite to track multi-step work, use `board_create_task` instead.

**Nothing exists unless it's on the board.** If an action item, future phase, recommendation, or follow-up is mentioned in conversation or discovered in a document but has no board task, it WILL be forgotten. The board is the single source of truth for "what needs to be done." Conversation text, plan docs, and strategy docs are reference material — the board is the task list. When in doubt, create the task. A redundant board task costs nothing; a forgotten action item costs real work.

### Proactive Triggers

These are condition → action pairs. When the condition is true, take the action immediately.

| Condition | Action |
|-----------|--------|
| Session starts (substantive work) | `board_create_session` before any other work |
| Context compacted / continuation session | `board_create_session` IMMEDIATELY — compaction loses the active session ID |
| Multi-step task (3+ steps) | `board_create_task` for each step |
| Batch of items (fix 5 bugs, review 3 files) | Parent task + subtask per item via `board_create_task` |
| New work discovered during execution | `board_create_task` immediately |
| Significant decision or blocker | `board_log_activity` |
| Start working on a task | `board_update_task` → `in_progress` + set `assigned_agent` to your name |
| Finish a task | `board_update_task` → `done` |
| Review/audit produces findings | Parent task per severity tier + subtask per finding |
| Deploying a new service for the first time | `board_create_task` for: verify deployment, create CI/CD trigger, push to prod |
| Committing + pushing code | `board_log_activity` with commit hash; update related tasks |
| Read a doc/plan with unbuilt phases or pending items | `board_create_task` for each actionable item not already on the board |
| Mention a future action item in conversation | `board_create_task` immediately — conversation text is ephemeral, board tasks are permanent |
| A sub-agent reports a finding or recommendation | `board_create_task` if it requires future work (don't let it exist only in conversation) |
| User says "handoff" or signals session end | Create board tasks for ALL pending next steps, THEN `board_end_session` |
| Session ending OR context getting long | `board_end_session` with handoff notes |

**The test**: If this session died right now, could the next session reconstruct what you were doing from the board alone? If not, you haven't been proactive enough.

**The second test**: If a documented plan has unchecked items, unbuilt phases, or "pending" status markers — and there's no corresponding board task — that's a gap. Every actionable item in every plan doc should have a board task. Plans without board tasks get forgotten.

### Session Lifecycle

**Starting a session** (before any other work — **including after context compaction**):

**Context compaction destroys the active session ID.** If you're continuing from a compacted conversation, you MUST call `board_create_session` before doing anything else. This is the #1 failure mode — compaction preserves your behavioral patterns but loses board state.

1. Call `board_get_projects` to see all active projects
2. **Match work to the correct project** — read project names/descriptions and pick the best fit. Do NOT default to one project for everything. Use a general catch-all project only when no specific project fits.
3. Call `board_create_session` with the matched `project_id`
   - This auto-abandons any stale sessions and returns handoff context
   - Read the handoff carefully — it contains what the last session accomplished and what's next
4. Review active tasks via the handoff response or `board_get_tasks`

**During a session:**
- **Planning**: Create all tasks on the board immediately with status `todo`. This ensures the plan survives even if the session crashes before execution.
- **Reviewing**: Review the *task list on the board*, not just prose. Call `board_get_tasks`, then use `board_log_activity` with `task_id` and `action: "commented"` to attach review comments to specific tasks. ALL review output MUST go through the board — conversation text disappears when sessions end.
- **Review findings → board tasks**: When a review produces findings, every finding must become a board task — not just an activity log comment. Create one parent task per severity tier (e.g., "Tier 1: BLOCKING items"), then subtasks for each finding using `parent_task_id`. Map priorities: BLOCKING/FAIL → `critical`, HIGH/WARN → `high`, LOW/INFO → `low`. Include enough context in each subtask's description to fix the issue without re-reading the review.
- **Executing**: Move tasks to `in_progress` as work begins, then `done` when complete. `started_at` is set automatically on first move to `in_progress` — work duration = `completed_at - started_at`.
- **Committing**: Log the commit hash via `board_log_activity` on related tasks. When deploying a new service for the first time, create follow-up tasks: (1) verify deployment, (2) create CI/CD trigger, (3) push to production. These are predictable follow-ups — don't wait for the user to ask.
- **Tracking your own work**: The board isn't just for project plans — it tracks what YOU are doing right now. When you receive a batch of items, create a **parent task** for the batch and **subtasks** for each item using `parent_task_id`. Move each subtask to `in_progress` → `done` as you work. This creates a recoverable checkpoint: if the session dies mid-batch, the next agent sees exactly which items are done and which remain.
- **Sub-agent delegation**: When spawning specialist sub-agents that produce detailed findings, instruct them to write results directly to the board. Include the `project_id` and parent task ID in the prompt. The sub-agent returns only a brief summary. This keeps the main agent's context lean while preserving full detail on the board. Pattern: `"Write all findings to the Vibe Board (project: PROJECT_ID, parent task: TASK_ID). Return only a 1-sentence summary to me."`
- **All modes**: Log notable events via `board_log_activity`. Create additional tasks as new work is discovered — the board should always reflect the current state of work.

**Ending a session** (before the session ends or when the user signals they're done):
1. **Scan your tasks**: Check for any tasks still `in_progress` that you own — mark them `done` if complete, or add a `board_log_activity` comment explaining what remains.
2. **Create tasks for all next steps**: Every pending follow-up must exist as a board task BEFORE ending. Do not list future work only in handoff prose — if it's worth mentioning as a next step, it's worth tracking as a task.
3. Call `board_end_session` with progress_summary, handoff_notes (referencing task IDs, not just prose), and context_artifacts.

**This is the most critical step.** A session without handoff notes is a session whose context is lost forever.

**Proactive ending**: If you sense the conversation is getting long or you are approaching context limits, call `board_end_session` immediately — even a partial handoff is infinitely better than an abandoned session with no notes.

### Task Status Flow

backlog → todo → in_progress → review → done
                       ↓
                    blocked

### Priority Levels

- **critical**: Blocking other work, needs immediate attention
- **high**: Important, should be next
- **medium**: Standard priority (default)
- **low**: Nice to have, do when time allows
```

### Want more?

The above is the standalone protocol. If you also want the broader framework — RIPER-CAT operational modes, a `processor` agent for delegated multi-specialist work, review-gate hooks, an autonomous Docker worker — see [`HuntsDesk/ve-kit`](https://github.com/HuntsDesk/ve-kit) → `docs/ve-kit/02-VIBE-BOARD.md` for the canonical reference and the rest of the kit.

---

## License

MIT. See [LICENSE](./LICENSE).

---

## Related

- [`HuntsDesk/ve-kit`](https://github.com/HuntsDesk/ve-kit) — full Vibe Coding Framework that bundles this MCP server
- [`HuntsDesk/ve-gws`](https://github.com/HuntsDesk/ve-gws) — VE Google Workspace MCP (sibling in the ve-* family)
