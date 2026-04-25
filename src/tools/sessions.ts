import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Firestore, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

export function registerSessionTools(server: McpServer, db: Firestore) {
  server.tool(
    "board_create_session",
    "Start a new work session on a project and get the previous session's handoff. **Side effect**: any currently-active sessions on the same project are automatically marked 'abandoned' with ended_at=now — there's only ever one active session per project. Call this at the start of every substantive session so the next one can pick up where you left off. The returned handoff includes: last_session (progress_summary + handoff_notes + context_artifacts from the previous run), active_tasks (priority-sorted non-done tasks), and recent_activity (last 20 activity_log entries). Returns { session_id, abandoned_sessions, handoff, message }.",
    {
      project_id: z.string().describe("Project ID (from board_get_projects) the session operates on"),
      session_type: z
        .enum(["solo", "team", "background"])
        .optional()
        .describe("Session type. 'solo' (default) = single agent, 'team' = coordinated multi-agent, 'background' = long-running async work like a Docker worker."),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional metadata (e.g., { worker_id: 'batch-123', hostname: 'mig-5' }). Stored on the session document verbatim."),
    },
    async ({ project_id, session_type, metadata }) => {
      const now = Timestamp.now();

      // 1. Abandon stale active sessions
      const activeSessions = await db
        .collection("sessions")
        .where("project_id", "==", project_id)
        .where("status", "==", "active")
        .get();

      const batch = db.batch();
      activeSessions.docs.forEach((doc) => {
        batch.update(doc.ref, {
          status: "abandoned",
          ended_at: now,
          progress_summary: doc.data().progress_summary ?? "Session abandoned (new session started)",
        });
      });

      // 2. Create new session
      const sessionRef = db.collection("sessions").doc();
      batch.set(sessionRef, {
        project_id,
        session_type: session_type ?? "solo",
        status: "active",
        started_at: now,
        ended_at: null,
        progress_summary: null,
        handoff_notes: null,
        context_artifacts: {},
        metadata: metadata ?? {},
      });

      await batch.commit();

      // 3. Log activity
      await db.collection("activity_log").add({
        task_id: null,
        session_id: sessionRef.id,
        agent_name: "system",
        action: "session_started",
        details: `New ${session_type ?? "solo"} session started${activeSessions.size > 0 ? ` (${activeSessions.size} stale session(s) abandoned)` : ""}`,
        metadata: {},
        created_at: now,
      });

      // 4. Build handoff context
      const handoff = await buildHandoffContext(db, project_id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                session_id: sessionRef.id,
                abandoned_sessions: activeSessions.size,
                handoff: handoff,
                message: "Session started successfully",
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
    "board_end_session",
    "End the current session with a progress summary and handoff notes. This is the single most important call for cross-session continuity — without it, everything you did this session is invisible to the next one. Marks the session status='completed' and sets ended_at=now. The next board_create_session will surface this session's progress_summary, handoff_notes, and context_artifacts in its handoff response. Reference specific task IDs in handoff_notes (the next session reads this as prose, not a parsed list). Returns { session_id, status, message }.",
    {
      session_id: z.string().describe("Session ID to end (the session_id returned from board_create_session at the start of this session)"),
      progress_summary: z
        .string()
        .describe("1-3 sentences on what was accomplished this session. Shown verbatim at the start of the next session's handoff."),
      handoff_notes: z
        .string()
        .optional()
        .describe("Prose notes for the next session — reference task IDs for pending work ('task X is blocked on Y'), not vague descriptions. What the next agent needs to know to continue."),
      context_artifacts: z
        .object({
          files_modified: z.array(z.string()).optional(),
          decisions_made: z.array(z.string()).optional(),
          blockers: z.array(z.string()).optional(),
          next_steps: z.array(z.string()).optional(),
        })
        .passthrough()
        .optional()
        .describe("Structured context. Recognized keys: files_modified (paths touched), decisions_made (choices that set direction), blockers (what stopped progress), next_steps (what the next session should do). Additional keys allowed — passthrough."),
    },
    async ({ session_id, progress_summary, handoff_notes, context_artifacts }) => {
      const sessionRef = db.collection("sessions").doc(session_id);
      const sessionSnap = await sessionRef.get();

      if (!sessionSnap.exists) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Session ${session_id} not found` }),
            },
          ],
        };
      }

      const now = Timestamp.now();
      await sessionRef.update({
        status: "completed",
        ended_at: now,
        progress_summary,
        handoff_notes: handoff_notes ?? null,
        context_artifacts: context_artifacts ?? {},
      });

      await db.collection("activity_log").add({
        task_id: null,
        session_id,
        agent_name: "system",
        action: "session_ended",
        details: progress_summary,
        metadata: {},
        created_at: now,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                session_id,
                status: "completed",
                message: "Session ended successfully. Handoff notes saved.",
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
    "board_get_handoff",
    "Read the full handoff context for a project without starting a new session. board_create_session already returns this automatically at session start — use board_get_handoff mid-session when you need to re-check what was pending, or when a background agent needs context without claiming the session slot. Returns: project (id/name/status/description), last_session (progress_summary + handoff_notes + context_artifacts from the most recent completed/abandoned session, or null if none), active_tasks (all non-done tasks sorted critical → low priority, with id/title/status/priority/assigned_agent/riper_mode/depends_on), active_task_count, and recent_activity (last 20 activity_log entries, newest-first).",
    {
      project_id: z.string().describe("Project ID (from board_get_projects) to read handoff context for."),
    },
    async ({ project_id }) => {
      const handoff = await buildHandoffContext(db, project_id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(handoff, null, 2),
          },
        ],
      };
    }
  );
}

async function buildHandoffContext(db: Firestore, project_id: string) {
  // Get project info
  const projectSnap = await db.collection("projects").doc(project_id).get();
  const projectData = projectSnap.exists ? projectSnap.data() : null;

  // Get last completed or abandoned session
  const lastSessionSnap = await db
    .collection("sessions")
    .where("project_id", "==", project_id)
    .where("status", "in", ["completed", "abandoned"])
    .orderBy("ended_at", "desc")
    .limit(1)
    .get();

  const lastSession = lastSessionSnap.docs[0]
    ? (() => {
        const data = lastSessionSnap.docs[0].data();
        return {
          id: lastSessionSnap.docs[0].id,
          status: data.status,
          progress_summary: data.progress_summary,
          handoff_notes: data.handoff_notes,
          context_artifacts: data.context_artifacts,
          started_at: data.started_at?.toDate?.()?.toISOString() ?? null,
          ended_at: data.ended_at?.toDate?.()?.toISOString() ?? null,
        };
      })()
    : null;

  // Get all non-done tasks sorted by priority
  const tasksSnap = await db
    .collection("tasks")
    .where("project_id", "==", project_id)
    .where("status", "!=", "done")
    .get();

  const priorityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  const activeTasks = tasksSnap.docs
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        title: data.title,
        status: data.status,
        priority: data.priority,
        assigned_agent: data.assigned_agent,
        riper_mode: data.riper_mode,
        depends_on: data.depends_on,
      };
    })
    .sort(
      (a, b) =>
        (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99)
    );

  // Get recent activity
  const activitySnap = await db
    .collection("activity_log")
    .orderBy("created_at", "desc")
    .limit(20)
    .get();

  // Filter to project-related activity (tasks in this project or sessions in this project)
  const taskIds = new Set(tasksSnap.docs.map((d) => d.id));
  const recentActivity = activitySnap.docs
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        action: data.action,
        agent_name: data.agent_name,
        details: data.details,
        task_id: data.task_id,
        session_id: data.session_id,
        created_at: data.created_at?.toDate?.()?.toISOString() ?? null,
      };
    });

  return {
    project: projectData
      ? {
          id: project_id,
          name: projectData.name,
          status: projectData.status,
          description: projectData.description,
        }
      : null,
    last_session: lastSession,
    active_tasks: activeTasks,
    active_task_count: activeTasks.length,
    recent_activity: recentActivity,
  };
}
