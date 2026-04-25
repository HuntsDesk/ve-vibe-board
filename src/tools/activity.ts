import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Firestore, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

export function registerActivityTools(server: McpServer, db: Firestore) {
  server.tool(
    "board_log_activity",
    "Append an entry to the activity_log — a write-only audit stream of what agents did, decided, or observed. Use this for: RESEARCH observations the next session should see, decisions made during PLAN/REVIEW, blockers, notable failures, or any context that shouldn't be lost. Most status/assignment changes via board_update_task and board_create_task already write their own activity_log entries automatically — call this explicitly for free-form comments (action='commented') or arbitrary actions. Read back via board_get_activity. Returns { id, action, message }.",
    {
      agent_name: z.string().describe("Name of the agent (free-form string — e.g., 'main', 'code-reviewer', 'gcp-infra'). Used for filtering and audit."),
      action: z
        .enum([
          "created",
          "updated",
          "claimed",
          "blocked",
          "completed",
          "commented",
          "mode_changed",
          "session_started",
          "session_ended",
        ])
        .describe("Action type. Fixed enum. Most values correspond to lifecycle events written automatically by other tools; use 'commented' for free-form notes/observations logged manually."),
      details: z.string().optional().describe("Human-readable description of what happened. Required in practice for 'commented' — without it, the entry is empty."),
      task_id: z.string().optional().describe("Related task ID if this activity is about a specific task. Enables filtering via board_get_activity(task_id=...). Omit for project-level or session-level events."),
      session_id: z.string().optional().describe("Related session ID if this activity is scoped to a specific session. Enables filtering via board_get_activity(session_id=...)."),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional structured payload (e.g., { commit_sha: 'abc123', build_id: 'build-456' }). Stored verbatim, not indexed."),
    },
    async ({ agent_name, action, details, task_id, session_id, metadata }) => {
      const docRef = await db.collection("activity_log").add({
        task_id: task_id ?? null,
        session_id: session_id ?? null,
        agent_name,
        action,
        details: details ?? null,
        metadata: metadata ?? {},
        created_at: Timestamp.now(),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                id: docRef.id,
                action,
                message: "Activity logged successfully",
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
    "board_get_activity",
    "Query the activity_log. Filter by task_id, session_id, agent_name, or action. Results are ordered newest-first and capped at `limit` (default 50, max 200). Useful for auditing what happened on a task, reconstructing a session, or following an agent's actions.",
    {
      task_id: z.string().optional().describe("Filter by related task ID"),
      session_id: z
        .string()
        .optional()
        .describe("Filter by related session ID"),
      agent_name: z
        .string()
        .optional()
        .describe("Filter by agent name"),
      action: z
        .enum([
          "created",
          "updated",
          "claimed",
          "blocked",
          "completed",
          "commented",
          "mode_changed",
          "session_started",
          "session_ended",
        ])
        .optional()
        .describe("Filter by action type"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max entries to return (default 50, max 200)"),
    },
    async ({ task_id, session_id, agent_name, action, limit }) => {
      // Build query with single-field filter then order+limit. Firestore
      // requires a composite index for multi-field filter+order; to avoid
      // that, we pick the most selective filter as the query filter and
      // apply any remaining filters in JS.
      let query: FirebaseFirestore.Query = db.collection("activity_log");
      const jsFilters: Array<[string, unknown]> = [];

      // Pick one field to push to Firestore (ordered by selectivity for our
      // use cases). Remaining filters become JS predicates.
      if (task_id !== undefined) {
        query = query.where("task_id", "==", task_id);
        if (session_id !== undefined) jsFilters.push(["session_id", session_id]);
        if (agent_name !== undefined) jsFilters.push(["agent_name", agent_name]);
        if (action !== undefined) jsFilters.push(["action", action]);
      } else if (session_id !== undefined) {
        query = query.where("session_id", "==", session_id);
        if (agent_name !== undefined) jsFilters.push(["agent_name", agent_name]);
        if (action !== undefined) jsFilters.push(["action", action]);
      } else if (agent_name !== undefined) {
        query = query.where("agent_name", "==", agent_name);
        if (action !== undefined) jsFilters.push(["action", action]);
      } else if (action !== undefined) {
        query = query.where("action", "==", action);
      }
      // Else: unfiltered scan (bounded by limit).

      const effectiveLimit = Math.min(limit ?? 50, 200);
      // Order by created_at DESC directly in Firestore. Equality-filter +
      // order on a different field doesn't require a composite index for
      // our single-equality-filter cases (common composite-index requirement
      // only kicks in with range filters or multi-field equality + order).
      query = query.orderBy("created_at", "desc");

      // Cursor pagination. When JS filters apply, fetch pages until we fill
      // `effectiveLimit` or hit a hard scan cap (prevents runaway reads on
      // highly-selective filters against huge collections).
      const PAGE_SIZE = 200;
      const HARD_SCAN_CAP = 2000;
      const results: Array<Record<string, unknown>> = [];
      let scanned = 0;
      let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
      let hitCap = false;

      const toISO = (v: unknown) =>
        v && typeof v === "object" && "toDate" in (v as object)
          ? (v as { toDate(): Date }).toDate().toISOString()
          : null;

      while (results.length < effectiveLimit && scanned < HARD_SCAN_CAP) {
        let pageQuery = query.limit(
          Math.min(PAGE_SIZE, HARD_SCAN_CAP - scanned)
        );
        if (lastDoc) pageQuery = pageQuery.startAfter(lastDoc);
        const snap = await pageQuery.get();
        if (snap.empty) break;

        scanned += snap.size;
        for (const d of snap.docs) {
          const data = d.data();
          const passes = jsFilters.every(
            ([k, v]) => (data as Record<string, unknown>)[k] === v
          );
          if (!passes) continue;
          results.push({
            id: d.id,
            ...data,
            created_at: toISO(data.created_at),
          });
          if (results.length >= effectiveLimit) break;
        }

        if (snap.size < PAGE_SIZE) break; // reached end of collection
        lastDoc = snap.docs[snap.docs.length - 1];
      }

      if (scanned >= HARD_SCAN_CAP && results.length < effectiveLimit) {
        hitCap = true;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                entries: results,
                scanned,
                truncated: hitCap,
                note: hitCap
                  ? `Scan cap ${HARD_SCAN_CAP} reached before filling limit ${effectiveLimit}. Results may be incomplete. Tighten filters or raise cap.`
                  : undefined,
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
