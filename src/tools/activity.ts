import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Firestore, Timestamp, Query, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { z } from "zod";

export function registerActivityTools(server: McpServer, db: Firestore) {
  server.tool(
    "board_log_activity",
    "Append an entry to the activity_log — a write-only audit stream of what agents did, decided, or observed. Use this for: RESEARCH observations the next session should see, decisions made during PLAN/REVIEW, blockers, notable failures, or any context that shouldn't be lost. Most status/assignment changes via board_update_task and board_create_task already write their own activity_log entries automatically — call this explicitly for free-form comments (action='commented') or to flag a plan deviation (action='deviation_flagged' — the RIPER EXECUTE gate; queryable on its own via board_get_activity). The action list is a fixed enum: any other value is rejected before it reaches Firestore. Read back via board_get_activity. Returns { id, action, message }.",
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
          "deviation_flagged",
        ])
        .describe("Action type. Fixed enum — an unlisted value fails validation. Most values correspond to lifecycle events written automatically by other tools; use 'commented' for free-form notes/observations logged manually and 'deviation_flagged' when execution departs from the plan (explain planned-vs-built in details)."),
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
          "deviation_flagged",
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
      let query: Query = db.collection("activity_log");
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
      let lastDoc: QueryDocumentSnapshot | null = null;
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

  server.tool(
    "board_delete_activity",
    "Hard-delete a single activity_log entry by its document ID. Irreversible — cannot be undone. Use board_bulk_delete_activity for filter-based deletion. Returns { id, deleted }.",
    {
      activity_id: z
        .string()
        .describe("Activity log document ID to delete (the `id` field returned by board_get_activity)"),
    },
    async ({ activity_id }) => {
      const docRef = db.collection("activity_log").doc(activity_id);
      const snap = await docRef.get();
      if (!snap.exists) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  id: activity_id,
                  deleted: false,
                  message: "Activity log entry not found",
                },
                null,
                2
              ),
            },
          ],
        };
      }
      await docRef.delete();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                id: activity_id,
                deleted: true,
                message: "Activity log entry deleted",
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
    "board_bulk_delete_activity",
    "Hard-delete activity_log entries matching the provided filters. At least one filter must be supplied (refuses to wipe the entire collection). Filters AND together (all must match). Irreversible — cannot be undone. Returns { matched, deleted, truncated, note }. Bounded by max_delete (default 500, max 5000) to prevent runaway deletes. If matched > max_delete, no deletions occur and truncated=true is returned so the caller can confirm scope before raising the cap.",
    {
      task_id: z
        .string()
        .optional()
        .describe("Filter by related task ID (exact match)"),
      session_id: z
        .string()
        .optional()
        .describe("Filter by related session ID (exact match)"),
      agent_name: z
        .string()
        .optional()
        .describe("Filter by agent name (exact match)"),
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
          "deviation_flagged",
        ])
        .optional()
        .describe("Filter by action type"),
      activity_ids: z
        .array(z.string())
        .optional()
        .describe("Explicit list of activity_log document IDs to delete. When provided, other filters are IGNORED and only these specific IDs are deleted (subject to max_delete). Max 5000."),
      max_delete: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe("Maximum number of entries to delete in this call (default 500, max 5000). Safety guard: if the filter matches more than this, NO deletions occur and the caller must re-invoke with a higher cap after confirming scope."),
      dry_run: z
        .boolean()
        .optional()
        .describe("If true, return the matched count without deleting. Default false."),
    },
    async ({ task_id, session_id, agent_name, action, activity_ids, max_delete, dry_run }) => {
      const effectiveMax = Math.min(max_delete ?? 500, 5000);
      const isDryRun = dry_run === true;

      // Explicit-ID path: delete the listed IDs directly (subject to max_delete).
      if (activity_ids && activity_ids.length > 0) {
        if (activity_ids.length > effectiveMax) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    matched: activity_ids.length,
                    deleted: 0,
                    truncated: true,
                    note: `activity_ids count (${activity_ids.length}) exceeds max_delete (${effectiveMax}). No deletions performed. Re-invoke with a higher max_delete or a smaller list.`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        if (isDryRun) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    matched: activity_ids.length,
                    deleted: 0,
                    dry_run: true,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        // Batched deletes (Firestore batch cap is 500 writes).
        let deleted = 0;
        for (let i = 0; i < activity_ids.length; i += 500) {
          const slice = activity_ids.slice(i, i + 500);
          const batch = db.batch();
          for (const id of slice) {
            batch.delete(db.collection("activity_log").doc(id));
          }
          await batch.commit();
          deleted += slice.length;
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  matched: activity_ids.length,
                  deleted,
                  truncated: false,
                  message: "Activity log entries deleted by explicit ID list",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Filter path: require at least one filter to prevent accidental
      // whole-collection wipe.
      if (
        task_id === undefined &&
        session_id === undefined &&
        agent_name === undefined &&
        action === undefined
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  matched: 0,
                  deleted: 0,
                  error:
                    "At least one filter (task_id, session_id, agent_name, action, or activity_ids) must be provided. Refusing to wipe entire activity_log collection.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Build the same single-Firestore-filter + JS-filter strategy used by
      // board_get_activity so we don't require composite indexes.
      let query: Query = db.collection("activity_log");
      const jsFilters: Array<[string, unknown]> = [];

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

      // Scan up to effectiveMax + 1 matching docs (the +1 lets us detect
      // overflow without scanning the entire collection).
      const SCAN_HARD_CAP = Math.min(effectiveMax * 4, 20000);
      const matchedDocs: QueryDocumentSnapshot[] = [];
      let scanned = 0;
      let lastDoc: QueryDocumentSnapshot | null = null;
      const PAGE_SIZE = 500;

      while (matchedDocs.length <= effectiveMax && scanned < SCAN_HARD_CAP) {
        let pageQuery = query.limit(Math.min(PAGE_SIZE, SCAN_HARD_CAP - scanned));
        if (lastDoc) pageQuery = pageQuery.startAfter(lastDoc);
        const snap = await pageQuery.get();
        if (snap.empty) break;
        scanned += snap.size;
        for (const d of snap.docs) {
          const data = d.data();
          const passes = jsFilters.every(
            ([k, v]) => (data as Record<string, unknown>)[k] === v
          );
          if (passes) matchedDocs.push(d);
          if (matchedDocs.length > effectiveMax) break;
        }
        if (snap.size < PAGE_SIZE) break;
        lastDoc = snap.docs[snap.docs.length - 1];
      }

      if (matchedDocs.length > effectiveMax) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  matched: `>${effectiveMax}`,
                  deleted: 0,
                  truncated: true,
                  note: `Matched more than max_delete (${effectiveMax}) entries. No deletions performed. Either raise max_delete (up to 5000) or tighten filters and re-invoke. To preview the count without raising the cap, pass dry_run=true.`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (isDryRun) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  matched: matchedDocs.length,
                  deleted: 0,
                  dry_run: true,
                  scanned,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Delete in 500-document Firestore batches.
      let deleted = 0;
      for (let i = 0; i < matchedDocs.length; i += 500) {
        const slice = matchedDocs.slice(i, i + 500);
        const batch = db.batch();
        for (const d of slice) {
          batch.delete(d.ref);
        }
        await batch.commit();
        deleted += slice.length;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                matched: matchedDocs.length,
                deleted,
                scanned,
                truncated: false,
                message: "Activity log entries deleted",
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
