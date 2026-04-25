import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Firestore, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

type Priority = "critical" | "high" | "medium" | "low";

interface ProjectData {
  name: string;
  description: string | null;
  status: "active" | "paused" | "completed" | "archived";
  priority?: Priority;
  metadata: Record<string, unknown>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

// Portfolio-level priority rank for sorting. Higher = more important.
// Projects without a priority field are treated as "medium" for backward compat.
const PRIORITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

// Valid state transitions. A status not in this map has no allowed outgoing
// transitions (defensive default — shouldn't happen for the 4 enum values).
// paused = intentionally on hold pending capacity or dependency; distinct from
// archived (done, preserved for history). Paused projects can resume to active,
// or transition directly to completed/archived.
const validTransitions: Record<string, readonly string[]> = {
  active: ["paused", "completed", "archived"],
  paused: ["active", "completed", "archived"],
  completed: ["archived", "active"], // allow re-opening
  archived: ["active"], // allow un-archiving; caller can re-transition afterward
};

// Order-independent deep equality. Used for metadata diff so re-sending
// existing metadata (possibly with different key order, or numeric keys that
// V8 auto-sorts) doesn't record a spurious "changed" event.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k]
    )) return false;
  }
  return true;
}

export function registerProjectTools(server: McpServer, db: Firestore) {
  server.tool(
    "board_get_projects",
    "List all projects with per-status task counts. Call this at session start to discover available projects before creating tasks or sessions — the returned IDs are required inputs to board_create_session, board_create_task, and most other tools. Results are sorted by priority descending (critical → low), then updated_at descending as tiebreaker. Projects without an explicit priority are treated as 'medium' for sort purposes (backward compat). Each entry includes: id, name, description, status, priority, metadata, ISO-formatted created_at/updated_at, task_counts (e.g., {todo: 3, in_progress: 1, done: 12}), and total_tasks. Use this over board_get_tasks when you don't yet know which project to target.",
    {
      status: z
        .enum(["active", "paused", "completed", "archived"])
        .optional()
        .describe("Filter to a single status. Omit to return all projects regardless of status. Typical usage: 'active' for current work; 'paused' for projects intentionally on hold pending capacity or dependency; archived projects are usually hidden from day-to-day views."),
    },
    async ({ status }) => {
      let query: FirebaseFirestore.Query = db.collection("projects");
      if (status) {
        query = query.where("status", "==", status);
      }

      // Pull by updated_at desc first; we re-sort in-memory to apply the
      // primary priority rank. Firestore can't do a composite sort where
      // one of the fields may be missing (pre-priority projects) — doing it
      // in-memory is cheap at project-list cardinality (~tens of docs).
      const snapshot = await query.orderBy("updated_at", "desc").get();
      const projects = await Promise.all(
        snapshot.docs.map(async (doc) => {
          const data = doc.data();
          const tasksSnap = await db
            .collection("tasks")
            .where("project_id", "==", doc.id)
            .get();

          const taskCounts: Record<string, number> = {};
          tasksSnap.docs.forEach((t) => {
            const s = t.data().status as string;
            taskCounts[s] = (taskCounts[s] || 0) + 1;
          });

          return {
            id: doc.id,
            ...data,
            // Backfill priority for backward compat — existing docs without
            // the field are treated as "medium" in the response too.
            priority: (data.priority as Priority | undefined) ?? "medium",
            created_at: data.created_at?.toDate?.()?.toISOString() ?? null,
            updated_at: data.updated_at?.toDate?.()?.toISOString() ?? null,
            task_counts: taskCounts,
            total_tasks: tasksSnap.size,
          };
        })
      );

      // Primary sort: priority desc (critical → low). Tiebreaker: updated_at desc.
      // updated_at is already an ISO string here; lexical compare works because
      // ISO 8601 is sortable as a string.
      projects.sort((a, b) => {
        const pa = PRIORITY_RANK[a.priority] ?? PRIORITY_RANK.medium;
        const pb = PRIORITY_RANK[b.priority] ?? PRIORITY_RANK.medium;
        if (pa !== pb) return pb - pa;
        const ua = a.updated_at ?? "";
        const ub = b.updated_at ?? "";
        if (ua < ub) return 1;
        if (ua > ub) return -1;
        return 0;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "board_create_project",
    "Create a new project to group tasks and sessions under a shared goal. Projects are the top-level container — every task and session must belong to one. Use sparingly: create a new project for major initiatives (3+ related tasks), not for every piece of work. New projects are created with status='active' and priority='medium' (unless overridden). Returns { id, name, status, priority, message }.",
    {
      name: z.string().describe("Project name — short, human-readable title shown everywhere the project is referenced"),
      description: z
        .string()
        .optional()
        .describe("Optional longer description of the project's scope, goals, or context. Omit if the name is self-explanatory."),
      priority: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .describe("Portfolio-level importance — drives weekly focus and default sort order in board_get_projects. This is DISTINCT from task.priority, which orders execution within a single project. Use critical/high for projects that should dominate the coming week; medium for steady-state work (default); low for back-burner initiatives you want visible but not pressing. Defaults to 'medium' when omitted."),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional key/value metadata (e.g., linked doc paths, deadlines, stakeholder names). Merged shallowly on board_update_project."),
    },
    async ({ name, description, priority, metadata }) => {
      const now = Timestamp.now();
      const resolvedPriority: Priority = priority ?? "medium";
      const docRef = await db.collection("projects").add({
        name,
        description: description ?? null,
        status: "active",
        priority: resolvedPriority,
        metadata: metadata ?? {},
        created_at: now,
        updated_at: now,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                id: docRef.id,
                name,
                status: "active",
                priority: resolvedPriority,
                message: `Project "${name}" created successfully`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "board_update_project",
    "Update a project's status (active/paused/completed/archived), priority, name, description, or metadata. Use this to pause projects that are on hold, archive completed projects so they don't clutter the active list, or re-rank portfolio priority during weekly reviews. Pass null to description/metadata to clear them.",
    {
      project_id: z.string().describe("Project ID to update"),
      status: z
        .enum(["active", "paused", "completed", "archived"])
        .optional()
        .describe("New status. 'paused' means intentionally on hold pending capacity or dependency — not stalled, not archived. Revisit at priority review. Valid transitions: active→paused/completed/archived, paused→active/completed/archived, completed→archived/active, archived→active."),
      priority: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .describe("Portfolio-level importance — drives weekly focus and default sort order in board_get_projects. DISTINCT from task.priority (which orders execution within a single project). Adjust during weekly portfolio reviews to promote/demote initiatives without touching the underlying tasks."),
      name: z.string().optional().describe("Updated name"),
      description: z
        .string()
        .nullable()
        .optional()
        .describe("Updated description. Pass null to clear; omit to leave unchanged."),
      metadata: z
        .record(z.string(), z.unknown())
        .nullable()
        .optional()
        .describe("Metadata to shallow-merge with existing. Pass null to clear all metadata; omit to leave unchanged."),
    },
    async ({ project_id, status, priority, name, description, metadata }) => {
      const docRef = db.collection("projects").doc(project_id);
      const snap = await docRef.get();
      if (!snap.exists) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { error: `Project ${project_id} not found` },
                null,
                2
              ),
            },
          ],
        };
      }

      const existing = (snap.data() ?? {}) as Partial<ProjectData>;
      const updates: Record<string, unknown> = {};
      const changes: string[] = [];

      if (status !== undefined && status !== existing.status) {
        const currentStatus = existing.status ?? "active";
        const allowed = validTransitions[currentStatus] ?? [];
        if (!allowed.includes(status)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: `Invalid status transition: ${currentStatus} → ${status}. Allowed from ${currentStatus}: ${allowed.join(", ") || "(none)"}`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        updates.status = status;
        changes.push(`status: ${currentStatus} → ${status}`);
      }

      if (priority !== undefined && priority !== existing.priority) {
        const prev = existing.priority ?? "medium";
        updates.priority = priority;
        changes.push(`priority: ${prev} → ${priority}`);
      }

      if (name !== undefined && name !== existing.name) {
        updates.name = name;
        changes.push(`name updated`);
      }

      // description: null clears, string replaces, undefined leaves unchanged
      if (description !== undefined && description !== existing.description) {
        updates.description = description; // can be null or string
        changes.push(description === null ? `description cleared` : `description updated`);
      }

      // metadata: null clears, object shallow-merges, undefined leaves unchanged
      if (metadata !== undefined) {
        if (metadata === null) {
          // Only count as a change if there was actually metadata before
          if (existing.metadata && Object.keys(existing.metadata).length > 0) {
            updates.metadata = {};
            changes.push(`metadata cleared`);
          }
        } else {
          const merged = { ...(existing.metadata ?? {}), ...metadata };
          // Skip the change when nothing actually differs after merge.
          // Uses order-independent deepEqual to avoid false-positives from
          // key reordering (V8 auto-sorts numeric keys, spread order can shift).
          if (!deepEqual(merged, existing.metadata ?? {})) {
            updates.metadata = merged;
            changes.push(`metadata merged`);
          }
        }
      }

      if (changes.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  id: project_id,
                  name: existing.name ?? null,
                  status: existing.status ?? null,
                  message: "No changes to apply",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Bump updated_at only when there are real changes
      const now = Timestamp.now();
      updates.updated_at = now;

      await docRef.update(updates);

      // Mirror tasks.ts: write an activity_log entry for audit trail
      await db.collection("activity_log").add({
        task_id: null,
        session_id: null,
        agent_name: "system",
        action: "updated",
        details: `Project ${project_id}: ${changes.join(", ")}`,
        metadata: { project_id },
        created_at: now,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                id: project_id,
                name: (updates.name as string | undefined) ?? existing.name ?? null,
                status: (updates.status as string | undefined) ?? existing.status ?? null,
                changes,
                message: `Project updated: ${changes.join(", ")}`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
