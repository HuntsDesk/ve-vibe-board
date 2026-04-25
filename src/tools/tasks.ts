import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Firestore, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

export function registerTaskTools(server: McpServer, db: Firestore) {
  server.tool(
    "board_get_tasks",
    "List tasks in a project with optional filters. Results are sorted client-side by priority (critical → low) — not by creation time. By default excludes done tasks (pass include_done=true or set status='done' to see them). Use this for mid-session checks: almost always pass a status filter (e.g., 'in_progress' or 'todo') to keep responses tight. For a single task by ID, use board_get_task instead. Returns an array of task objects with id, project_id, title, description, status, priority, assigned_agent, parent_task_id, depends_on, riper_mode, metadata, and ISO timestamps (created_at, updated_at, started_at, completed_at).",
    {
      project_id: z.string().describe("Project ID (from board_get_projects) whose tasks to list"),
      status: z
        .enum(["backlog", "todo", "in_progress", "blocked", "review", "done"])
        .optional()
        .describe("Filter to a single status. Omit to return all non-done tasks (unless include_done=true)."),
      priority: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .describe("Filter to a single priority. Omit to return all priorities."),
      assigned_agent: z
        .string()
        .optional()
        .describe("Filter to tasks assigned to this agent name (exact match). Omit to return all assignments."),
      include_done: z
        .boolean()
        .optional()
        .describe("Include tasks with status='done' (default false — done tasks are hidden to keep responses small). Ignored if an explicit status filter is set."),
    },
    async ({ project_id, status, priority, assigned_agent, include_done }) => {
      let query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = db
        .collection("tasks")
        .where("project_id", "==", project_id);

      if (status) {
        query = query.where("status", "==", status);
      } else if (!include_done) {
        query = query.where("status", "!=", "done");
      }

      if (priority) {
        query = query.where("priority", "==", priority);
      }

      if (assigned_agent) {
        query = query.where("assigned_agent", "==", assigned_agent);
      }

      const snapshot = await query.get();
      const priorityOrder: Record<string, number> = {
        critical: 0,
        high: 1,
        medium: 2,
        low: 3,
      };

      const tasks = snapshot.docs
        .map((doc) => {
          const data = doc.data();
          return {
            id: doc.id,
            project_id: data.project_id as string,
            title: data.title as string,
            description: data.description as string | null,
            status: data.status as string,
            priority: data.priority as string,
            assigned_agent: data.assigned_agent as string | null,
            parent_task_id: data.parent_task_id as string | null,
            depends_on: data.depends_on as string[],
            riper_mode: data.riper_mode as string | null,
            metadata: data.metadata as Record<string, unknown>,
            created_at: data.created_at?.toDate?.()?.toISOString() ?? null,
            updated_at: data.updated_at?.toDate?.()?.toISOString() ?? null,
            started_at: data.started_at?.toDate?.()?.toISOString() ?? null,
            completed_at: data.completed_at?.toDate?.()?.toISOString() ?? null,
          };
        })
        .sort(
          (a, b) =>
            (priorityOrder[a.priority] ?? 99) -
            (priorityOrder[b.priority] ?? 99)
        );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(tasks, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "board_create_task",
    "Create a task in a project. Status defaults to 'todo' and priority to 'medium' if not specified. If the initial status is 'in_progress', started_at is auto-set to now; if 'done', completed_at is auto-set. Writes an activity_log entry for audit. Use parent_task_id to create a subtask under another task (common pattern for decomposing work). Use depends_on to express ordering ('task B blocks on task A'). Returns { id, title, status, priority, message }.",
    {
      project_id: z.string().describe("Project ID (from board_get_projects) where this task belongs"),
      title: z.string().describe("Short title — one line, what needs doing. Appears in handoff summaries and task lists."),
      description: z.string().optional().describe("Longer details: context, acceptance criteria, file refs, links. Recommended for any task that will outlive the current session."),
      status: z
        .enum(["backlog", "todo", "in_progress", "blocked", "review", "done"])
        .optional()
        .describe("Initial status. Default 'todo'. Use 'backlog' for not-yet-prioritized ideas."),
      priority: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .describe("Priority — drives sort order in board_get_tasks and handoff. Default 'medium'. Reserve 'critical' for blocking issues."),
      assigned_agent: z
        .string()
        .optional()
        .describe("Agent name responsible for this task (free-form string, e.g., 'main', 'code-reviewer', 'database-specialist'). Omit if unassigned."),
      parent_task_id: z
        .string()
        .optional()
        .describe("If this is a subtask, the ID of the parent task. Subtasks inherit no fields from the parent — they just share a parent_task_id link."),
      depends_on: z
        .array(z.string())
        .optional()
        .describe("IDs of tasks that must complete before this one can start. The server does not auto-block — this is advisory metadata that callers can check."),
      riper_mode: z
        .enum(["research", "innovate", "plan", "execute", "review", "commit"])
        .optional()
        .describe("Which RIPER phase this task belongs to. Useful when tasks span a multi-phase workflow."),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional key/value metadata (e.g., { file: 'src/foo.ts', line: 42, issue: 'XSS' }). Merged shallowly on board_update_task."),
    },
    async ({
      project_id,
      title,
      description,
      status,
      priority,
      assigned_agent,
      parent_task_id,
      depends_on,
      riper_mode,
      metadata,
    }) => {
      const now = Timestamp.now();
      const taskStatus = status ?? "todo";

      const docRef = await db.collection("tasks").add({
        project_id,
        title,
        description: description ?? null,
        status: taskStatus,
        priority: priority ?? "medium",
        assigned_agent: assigned_agent ?? null,
        parent_task_id: parent_task_id ?? null,
        depends_on: depends_on ?? [],
        riper_mode: riper_mode ?? null,
        metadata: metadata ?? {},
        created_at: now,
        updated_at: now,
        started_at: taskStatus === "in_progress" ? now : null,
        completed_at: taskStatus === "done" ? now : null,
      });

      await db.collection("activity_log").add({
        task_id: docRef.id,
        session_id: null,
        agent_name: assigned_agent ?? "system",
        action: "created",
        details: `Task "${title}" created with status ${taskStatus}`,
        metadata: {},
        created_at: now,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                id: docRef.id,
                title,
                status: taskStatus,
                priority: priority ?? "medium",
                message: `Task "${title}" created successfully`,
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
    "board_update_task",
    "Update a task's status, assignment, priority, RIPER mode, project, or other fields. Pass project_id to move the task to a different project (the target project must exist; subtasks are NOT auto-moved — caller must move them separately if needed).",
    {
      task_id: z.string().describe("Task ID to update"),
      status: z
        .enum(["backlog", "todo", "in_progress", "blocked", "review", "done"])
        .optional()
        .describe("New status"),
      priority: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .describe("New priority"),
      assigned_agent: z
        .string()
        .optional()
        .describe("New agent assignment (empty string to unassign)"),
      riper_mode: z
        .enum(["research", "innovate", "plan", "execute", "review", "commit"])
        .optional()
        .describe("New RIPER mode"),
      title: z.string().optional().describe("Updated title"),
      description: z.string().optional().describe("Updated description"),
      depends_on: z
        .array(z.string())
        .optional()
        .describe("Updated dependency list"),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Metadata to merge"),
      project_id: z
        .string()
        .optional()
        .describe(
          "Move task to this project. Target project must exist. Subtasks are NOT auto-moved — their parent_task_id link will cross projects unless the caller also moves them. Returns a warning in the message if the task has subtasks still in the source project."
        ),
    },
    async ({
      task_id,
      status,
      priority,
      assigned_agent,
      riper_mode,
      title,
      description,
      depends_on,
      metadata,
      project_id,
    }) => {
      const taskRef = db.collection("tasks").doc(task_id);
      const taskSnap = await taskRef.get();

      if (!taskSnap.exists) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Task ${task_id} not found` }),
            },
          ],
        };
      }

      const oldData = taskSnap.data()!;
      const now = Timestamp.now();
      const updates: Record<string, unknown> = { updated_at: now };
      const changes: string[] = [];
      const warnings: string[] = [];

      // Project reassignment — validate target project exists before writing.
      // Uses a single-field subtask query (parent_task_id only) then JS-side
      // project_id filtering to avoid requiring a Firestore composite index.
      let projectMoveApplied = false;
      if (project_id !== undefined && project_id !== oldData.project_id) {
        const targetProjSnap = await db.collection("projects").doc(project_id).get();
        if (!targetProjSnap.exists) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Target project ${project_id} not found. Task not moved.`,
                }),
              },
            ],
          };
        }

        // Resolve names for the audit log (both projects). Old project name
        // is best-effort: legacy tasks may have no project_id, or the old
        // project may have been deleted since the task was created.
        let oldProjName: string = "(none)";
        if (oldData.project_id) {
          const oldProjSnap = await db
            .collection("projects")
            .doc(oldData.project_id)
            .get();
          oldProjName = oldProjSnap.exists
            ? (oldProjSnap.data()?.name ?? oldData.project_id)
            : `${oldData.project_id} (deleted)`;
        }
        const newProjName = targetProjSnap.data()?.name ?? project_id;
        const oldProjIdDisplay = oldData.project_id ?? "none";

        updates.project_id = project_id;
        changes.push(
          `project: ${oldProjName} (${oldProjIdDisplay}) → ${newProjName} (${project_id})`
        );
        projectMoveApplied = true;

        // Detect subtasks that'd be orphaned in the source project after the
        // move. Query by parent_task_id only (single field, no index needed),
        // then filter by source project_id in JS. Skip entirely when the task
        // is a legacy row with no source project_id — undefined in a Firestore
        // .where clause would throw.
        const subtaskSnap = await db
          .collection("tasks")
          .where("parent_task_id", "==", task_id)
          .get();
        if (oldData.project_id && !subtaskSnap.empty) {
          const stillInSource = subtaskSnap.docs.filter(
            (d) => d.data().project_id === oldData.project_id
          );
          if (stillInSource.length > 0) {
            warnings.push(
              `${stillInSource.length} subtask(s) still in source project ${oldData.project_id}. Move them separately if desired.`
            );
          }
        }
      }

      if (status !== undefined) {
        updates.status = status;
        changes.push(`status: ${oldData.status} → ${status}`);

        // Set started_at when first moving to in_progress (preserve on re-entry from blocked/review)
        if (status === "in_progress" && !oldData.started_at) {
          updates.started_at = now;
        }
        // Clear started_at if task is sent back to todo/backlog (genuinely un-started)
        if ((status === "todo" || status === "backlog") && oldData.started_at) {
          updates.started_at = null;
        }

        if (status === "done" && oldData.status !== "done") {
          updates.completed_at = now;
        } else if (status !== "done" && oldData.status === "done") {
          updates.completed_at = null;
        }
      }

      if (priority !== undefined) {
        updates.priority = priority;
        changes.push(`priority: ${oldData.priority} → ${priority}`);
      }

      if (assigned_agent !== undefined) {
        updates.assigned_agent = assigned_agent === "" ? null : assigned_agent;
        changes.push(
          `assigned: ${oldData.assigned_agent ?? "none"} → ${assigned_agent || "none"}`
        );
      }

      if (riper_mode !== undefined) {
        updates.riper_mode = riper_mode;
        changes.push(`riper_mode: ${oldData.riper_mode ?? "none"} → ${riper_mode}`);
      }

      if (title !== undefined) {
        updates.title = title;
        changes.push(`title updated`);
      }

      if (description !== undefined) {
        updates.description = description;
        changes.push(`description updated`);
      }

      if (depends_on !== undefined) {
        updates.depends_on = depends_on;
        changes.push(`dependencies updated`);
      }

      if (metadata !== undefined) {
        updates.metadata = { ...oldData.metadata, ...metadata };
        changes.push(`metadata updated`);
      }

      await taskRef.update(updates);

      const action = status === "done" ? "completed" :
                     status === "blocked" ? "blocked" :
                     assigned_agent !== undefined ? "claimed" :
                     riper_mode !== undefined ? "mode_changed" : "updated";

      const logMetadata: Record<string, unknown> = {};
      if (updates.project_id !== undefined) {
        logMetadata.project_id_from = oldData.project_id ?? null;
        logMetadata.project_id_to = updates.project_id;
      }

      await db.collection("activity_log").add({
        task_id,
        session_id: null,
        agent_name: (assigned_agent !== undefined && assigned_agent !== "")
          ? assigned_agent
          : oldData.assigned_agent ?? "system",
        action,
        details: changes.join(", "),
        metadata: logMetadata,
        created_at: now,
      });

      const responseMessage =
        warnings.length > 0
          ? `Task updated: ${changes.join(", ")}. Warnings: ${warnings.join("; ")}`
          : `Task updated: ${changes.join(", ")}`;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                id: task_id,
                changes,
                warnings: warnings.length > 0 ? warnings : undefined,
                message: responseMessage,
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
    "board_get_task",
    "Fetch a single task by its ID. Use this when you have a task ID (from board_create_task, a handoff note, or an activity_log entry) and need the full task record — for listing many tasks under a project, use board_get_tasks instead. Returns every field: id, project_id, title, description, status, priority, assigned_agent, parent_task_id, depends_on, riper_mode, metadata, and ISO timestamps (created_at, updated_at, started_at, completed_at). Returns { error } when the task doesn't exist rather than throwing — callers should check for the error key before treating the result as a task.",
    {
      task_id: z.string().describe("Task ID to fetch. Get this from the response of board_create_task, from handoff notes, or from activity_log entries."),
    },
    async ({ task_id }) => {
      const snap = await db.collection("tasks").doc(task_id).get();
      if (!snap.exists) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Task ${task_id} not found` }),
            },
          ],
        };
      }
      const data = snap.data() ?? {};
      const toISO = (v: unknown) =>
        v && typeof v === "object" && "toDate" in (v as object)
          ? (v as { toDate(): Date }).toDate().toISOString()
          : null;
      const task = {
        id: snap.id,
        ...data,
        created_at: toISO((data as Record<string, unknown>).created_at),
        updated_at: toISO((data as Record<string, unknown>).updated_at),
        started_at: toISO((data as Record<string, unknown>).started_at),
        completed_at: toISO((data as Record<string, unknown>).completed_at),
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(task, null, 2) },
        ],
      };
    }
  );

  server.tool(
    "board_bulk_update_tasks",
    "Apply the same update to multiple tasks in one call. Useful for consolidation (move N tasks to a different project) or bulk status/priority/agent changes. All tasks are validated first — if any task is missing, NO tasks are updated (all-or-nothing). Activity log entries are written per task.",
    {
      task_ids: z
        .array(z.string())
        .min(1)
        .max(100)
        .describe("Task IDs to update (1-100)"),
      project_id: z
        .string()
        .optional()
        .describe(
          "Move all listed tasks to this project. Target project must exist."
        ),
      status: z
        .enum(["backlog", "todo", "in_progress", "blocked", "review", "done"])
        .optional()
        .describe("New status for all listed tasks"),
      priority: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .describe("New priority for all listed tasks"),
      assigned_agent: z
        .string()
        .optional()
        .describe("New agent assignment for all listed tasks (empty string to unassign)"),
    },
    async ({ task_ids, project_id, status, priority, assigned_agent }) => {
      // Validate at least one field is being updated.
      if (
        project_id === undefined &&
        status === undefined &&
        priority === undefined &&
        assigned_agent === undefined
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error:
                  "At least one of project_id / status / priority / assigned_agent must be provided.",
              }),
            },
          ],
        };
      }

      // If moving to a new project, validate target exists first.
      if (project_id !== undefined) {
        const projSnap = await db.collection("projects").doc(project_id).get();
        if (!projSnap.exists) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Target project ${project_id} not found. No tasks updated.`,
                }),
              },
            ],
          };
        }
      }

      // Preflight: fetch all tasks, verify all exist. All-or-nothing.
      const taskRefs = task_ids.map((id) => db.collection("tasks").doc(id));
      const snaps = await db.getAll(...taskRefs);
      const missing = snaps
        .map((s, i) => ({ s, id: task_ids[i] }))
        .filter(({ s }) => !s.exists)
        .map(({ id }) => id);
      if (missing.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Task(s) not found: ${missing.join(", ")}. No tasks updated.`,
              }),
            },
          ],
        };
      }

      // Base update payload (fields that are uniform across all tasks).
      const now = Timestamp.now();
      const baseUpdates: Record<string, unknown> = { updated_at: now };
      if (project_id !== undefined) baseUpdates.project_id = project_id;
      if (status !== undefined) baseUpdates.status = status;
      if (priority !== undefined) baseUpdates.priority = priority;
      if (assigned_agent !== undefined) {
        baseUpdates.assigned_agent =
          assigned_agent === "" ? null : assigned_agent;
      }

      // Write updates via batch (up to 500 writes per batch; we cap at 100 tasks
      // = 200 writes including activity_log, well within the 500 limit).
      //
      // Per-task divergences (started_at / completed_at) mirror board_update_task
      // single-task behavior so bulk ops don't leave stale timestamps.
      const batch = db.batch();
      for (let i = 0; i < taskRefs.length; i++) {
        const ref = taskRefs[i];
        const oldData = snaps[i].data() ?? {};
        const perTask: Record<string, unknown> = { ...baseUpdates };

        if (status !== undefined) {
          // started_at: set on first move to in_progress; clear when sent
          // back to todo/backlog (task is genuinely un-started).
          if (status === "in_progress" && !oldData.started_at) {
            perTask.started_at = now;
          } else if (
            (status === "todo" || status === "backlog") &&
            oldData.started_at
          ) {
            perTask.started_at = null;
          }

          // completed_at: set on transition to done, clear on move away from done.
          if (status === "done" && oldData.status !== "done") {
            perTask.completed_at = now;
          } else if (status !== "done" && oldData.status === "done") {
            perTask.completed_at = null;
          }
        }

        batch.update(ref, perTask);
      }
      // Activity log entries per task.
      for (let i = 0; i < task_ids.length; i++) {
        const oldData = snaps[i].data() ?? {};
        const changes: string[] = [];
        if (project_id !== undefined && project_id !== oldData.project_id) {
          changes.push(`project: ${oldData.project_id ?? "none"} → ${project_id}`);
        }
        if (status !== undefined && status !== oldData.status) {
          changes.push(`status: ${oldData.status} → ${status}`);
        }
        if (priority !== undefined && priority !== oldData.priority) {
          changes.push(`priority: ${oldData.priority} → ${priority}`);
        }
        if (assigned_agent !== undefined) {
          changes.push(
            `assigned: ${oldData.assigned_agent ?? "none"} → ${assigned_agent || "none"}`
          );
        }
        if (changes.length === 0) continue; // no effective change, skip log

        const action =
          status === "done"
            ? "completed"
            : status === "blocked"
              ? "blocked"
              : "updated";
        const logMetadata: Record<string, unknown> = { bulk: true };
        if (project_id !== undefined) {
          logMetadata.project_id_from = oldData.project_id ?? null;
          logMetadata.project_id_to = project_id;
        }
        const logRef = db.collection("activity_log").doc();
        batch.set(logRef, {
          task_id: task_ids[i],
          session_id: null,
          agent_name: "system",
          action,
          details: changes.join(", "),
          metadata: logMetadata,
          created_at: now,
        });
      }

      // Count effective changes per task for accurate reporting.
      let changedCount = 0;
      let noOpCount = 0;
      for (let i = 0; i < task_ids.length; i++) {
        const oldData = snaps[i].data() ?? {};
        const hasChange =
          (project_id !== undefined && project_id !== oldData.project_id) ||
          (status !== undefined && status !== oldData.status) ||
          (priority !== undefined && priority !== oldData.priority) ||
          assigned_agent !== undefined;
        if (hasChange) changedCount++;
        else noOpCount++;
      }

      await batch.commit();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                requested: task_ids.length,
                changed: changedCount,
                no_op: noOpCount,
                project_id: project_id ?? null,
                status: status ?? null,
                priority: priority ?? null,
                assigned_agent: assigned_agent ?? null,
                message: `Bulk update: ${changedCount} task(s) changed, ${noOpCount} no-op.`,
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
    "board_delete_task",
    "Hard-delete a task and optionally its subtasks. Safety guard: by default only allows deleting tasks with status=done (prevents deleting in-progress work). Pass require_done=false to override. Also deletes associated activity_log entries. This is irreversible — cannot be undone.",
    {
      task_id: z.string().describe("Task ID to delete"),
      require_done: z
        .boolean()
        .optional()
        .describe(
          "If true (default), refuse to delete unless the task's status is 'done'. Pass false to force-delete a non-done task."
        ),
      cascade_subtasks: z
        .boolean()
        .optional()
        .describe(
          "If true, also delete all tasks with parent_task_id == task_id (each child also subject to require_done check). Default false — subtasks are orphaned but kept."
        ),
    },
    async ({ task_id, require_done, cascade_subtasks }) => {
      const requireDone = require_done ?? true;
      const cascade = cascade_subtasks ?? false;

      const taskRef = db.collection("tasks").doc(task_id);
      const taskSnap = await taskRef.get();
      if (!taskSnap.exists) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Task ${task_id} not found` }),
            },
          ],
        };
      }

      const data = taskSnap.data() ?? {};
      if (requireDone && data.status !== "done") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Task ${task_id} has status="${data.status}". Set status to "done" first, or pass require_done=false to force delete. Refusing to delete in-progress work.`,
              }),
            },
          ],
        };
      }

      const toDelete: string[] = [task_id];
      if (cascade) {
        const childrenSnap = await db
          .collection("tasks")
          .where("parent_task_id", "==", task_id)
          .get();
        for (const child of childrenSnap.docs) {
          const childData = child.data() ?? {};
          if (requireDone && childData.status !== "done") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: `Subtask ${child.id} has status="${childData.status}". Parent ${task_id} not deleted. Either complete subtasks first or pass require_done=false.`,
                  }),
                },
              ],
            };
          }
          toDelete.push(child.id);
        }
      }

      // Gather activity_log entries for the tasks being deleted.
      const activityRefs: FirebaseFirestore.DocumentReference[] = [];
      for (const id of toDelete) {
        const activitySnap = await db
          .collection("activity_log")
          .where("task_id", "==", id)
          .get();
        for (const doc of activitySnap.docs) activityRefs.push(doc.ref);
      }

      // Delete in order: activity_log entries first, task docs last. If the
      // multi-batch loop fails mid-way, we'd rather have a task doc with
      // truncated history than an orphaned history pointing at a deleted
      // task_id. Task deletions go in the final batch so they're atomic
      // with the most recent history writes. Firestore batch limit is 500
      // writes; chunk at 450 to leave headroom.
      const CHUNK = 450;
      // Activity log first (in chunks).
      for (let i = 0; i < activityRefs.length; i += CHUNK) {
        const batch = db.batch();
        for (const ref of activityRefs.slice(i, i + CHUNK)) batch.delete(ref);
        await batch.commit();
      }
      // Task docs last, all together (≤100 cascade limit, well under 500).
      const taskBatch = db.batch();
      for (const id of toDelete) taskBatch.delete(db.collection("tasks").doc(id));
      await taskBatch.commit();

      // Write a final audit entry for the deletion itself. Because the task
      // is gone, this entry has task_id=null and details capture what was removed.
      await db.collection("activity_log").add({
        task_id: null,
        session_id: null,
        agent_name: "system",
        action: "updated",
        details: `Deleted task${cascade && toDelete.length > 1 ? `s` : ""}: ${toDelete.join(", ")}`,
        metadata: {
          deleted_task_ids: toDelete,
          deleted_activity_count: activityRefs.length,
          require_done: requireDone,
          cascade_subtasks: cascade,
        },
        created_at: Timestamp.now(),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                deleted_task_ids: toDelete,
                deleted_activity_entries: activityRefs.length,
                message: `Deleted ${toDelete.length} task(s) and ${activityRefs.length} activity log entries.`,
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
