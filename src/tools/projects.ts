import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Firestore, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

interface ProjectData {
  name: string;
  description: string | null;
  status: "active" | "completed" | "archived";
  metadata: Record<string, unknown>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

// Valid state transitions. A status not in this map has no allowed outgoing
// transitions (defensive default — shouldn't happen for the 3 enum values).
const validTransitions: Record<string, readonly string[]> = {
  active: ["completed", "archived"],
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
    "List all projects with task count summaries per status",
    {
      status: z
        .enum(["active", "completed", "archived"])
        .optional()
        .describe("Filter by project status"),
    },
    async ({ status }) => {
      let query: FirebaseFirestore.Query = db.collection("projects");
      if (status) {
        query = query.where("status", "==", status);
      }

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
            created_at: data.created_at?.toDate?.()?.toISOString() ?? null,
            updated_at: data.updated_at?.toDate?.()?.toISOString() ?? null,
            task_counts: taskCounts,
            total_tasks: tasksSnap.size,
          };
        })
      );

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
    "Create a new project to group tasks and sessions under a shared goal. Projects are the top-level container — every task and session must belong to one. Use sparingly: create a new project for major initiatives (3+ related tasks), not for every piece of work. New projects are created with status='active'. Returns { id, name, status, message }.",
    {
      name: z.string().describe("Project name — short, human-readable title shown everywhere the project is referenced"),
      description: z
        .string()
        .optional()
        .describe("Optional longer description of the project's scope, goals, or context. Omit if the name is self-explanatory."),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional key/value metadata (e.g., linked doc paths, deadlines, stakeholder names). Merged shallowly on board_update_project."),
    },
    async ({ name, description, metadata }) => {
      const now = Timestamp.now();
      const docRef = await db.collection("projects").add({
        name,
        description: description ?? null,
        status: "active",
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
    "Update a project's status (active/completed/archived), name, description, or metadata. Use this to archive completed projects so they don't clutter the active list. Pass null to description/metadata to clear them.",
    {
      project_id: z.string().describe("Project ID to update"),
      status: z
        .enum(["active", "completed", "archived"])
        .optional()
        .describe("New status. Valid transitions: active→completed/archived, completed→archived/active, archived→active."),
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
    async ({ project_id, status, name, description, metadata }) => {
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
