import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  Firestore,
  Timestamp,
  FieldValue,
  Query,
  DocumentData,
  QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { z } from "zod";

/**
 * Shared dev memory — real-time cross-developer fact store.
 *
 * Complements (does NOT replace) the file-based auto-memory at
 * ~/.claude/projects/.../memory/ which is per-dev (or git-symlinked
 * via Phase 2 of board task 1UQWUEPVfmKfmwUWld11).
 *
 * Architecture per design RFC `65tBpLhjNaBbHCGeLbcU`:
 * - Firestore collection `shared_memories`
 * - Two MCP tools (this file): board_save_shared_memory + board_search_shared_memories
 * - MVP: text/tag/recency filter only — no embeddings (see ADR-1)
 * - MVP: no SessionStart auto-injection — Claude calls when relevant (see ADR-2)
 * - access_count + last_accessed_at fields populated from day 1 for future
 *   decay-scoring even though scoring isn't built yet (ADR-4)
 *
 * Real-time semantics: Firestore writes are visible to other readers within
 * the standard consistency window (~100ms). Tom saves → Hunter's NEXT
 * board_search_shared_memories call returns Tom's memory. No git operations,
 * no Claude restart needed.
 */
export function registerMemoryTools(server: McpServer, db: Firestore) {
  server.tool(
    "board_save_shared_memory",
    "Save a shared dev memory visible to all agents and humans in real time across all dev sessions. Use this for cross-developer-valuable facts: ops gotchas, schema discoveries, infra patterns, project conventions, recurring bugs and fixes. DO NOT use this for personal preferences (those go to your local ~/.claude/projects/.../memory/) or for ephemeral task-context (those go to board tasks). Returns { id, title, message }. Other agents see this memory the moment Firestore replicates (~100ms) — no git pull, no Claude restart required.",
    {
      title: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "Short title — appears in search results. Make it specific enough that a future search by topic + keyword will find it. e.g., 'psycopg3 savepoint pattern' not 'database tip'."
        ),
      body: z
        .string()
        .min(1)
        .max(10000)
        .describe(
          "Markdown content of the memory. Lead with the rule/fact, then **Why:** (the incident or reason) and **How to apply:** (when/where the rule kicks in). Include file paths + line numbers if applicable."
        ),
      topic: z
        .string()
        .optional()
        .describe(
          "Optional tag for grouping. Recommended values: 'ops' (infra/deployment), 'coding' (patterns/idioms), 'project' (initiative status), 'reference' (external system pointers), 'feedback' (user/agent behavioral norms), 'session' (process discipline), or any free-form string. Used by board_search_shared_memories topic filter."
        ),
      author: z
        .string()
        .optional()
        .describe(
          "Who/what wrote this memory. Free-form (e.g., 'hunter', 'tom', 'code-reviewer', 'chat-specialist'). Defaults to 'system' if omitted."
        ),
    },
    async ({ title, body, topic, author }) => {
      const now = Timestamp.now();
      const docRef = await db.collection("shared_memories").add({
        title,
        body,
        topic: topic ?? null,
        author: author ?? "system",
        access_count: 0,
        last_accessed_at: null,
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
                title,
                topic: topic ?? null,
                message: `Shared memory "${title}" saved successfully — visible to all dev sessions in real time.`,
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
    "board_search_shared_memories",
    "Search shared dev memories across the team in real time. Filter by topic + free-text + recency. Returns memories sorted by updated_at descending. Increments access_count + sets last_accessed_at on each returned doc (used by future decay-scoring). Use at session start with recency_days=7 to surface anything new since your last session. Use mid-session with query_text=<topic keyword> when the user's question touches a domain that might have shared knowledge. Returns up to 50 memories per call.",
    {
      topic: z
        .string()
        .optional()
        .describe(
          "Exact-match filter on the topic field. Omit to search all topics."
        ),
      query_text: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring filter applied to title + body. Omit to match everything (subject to topic + recency filters). MVP: no semantic search — only literal substring match. Choose terms that are likely to appear verbatim in the memory text."
        ),
      recency_days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe(
          "Only return memories updated within the last N days. Common values: 1 (latest changes), 7 (this week), 30 (this month). Omit for all-time."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe(
          "Max results to return. Default 10. Cap 50."
        ),
    },
    async ({ topic, query_text, recency_days, limit }) => {
      const effectiveLimit = limit ?? 10;
      let query: Query<DocumentData> = db
        .collection("shared_memories");

      if (topic) {
        query = query.where("topic", "==", topic);
      }

      if (recency_days) {
        const cutoff = new Date(Date.now() - recency_days * 24 * 60 * 60 * 1000);
        query = query.where("updated_at", ">=", Timestamp.fromDate(cutoff));
      }

      // Order by updated_at DESC for recency-first. Limit fetched to 2× the
      // requested limit when text-filtering, since query_text is applied
      // client-side after the Firestore query (no native substring index).
      const fetchMultiplier = query_text ? 2 : 1;
      query = query.orderBy("updated_at", "desc").limit(effectiveLimit * fetchMultiplier);

      const snapshot = await query.get();
      const needle = query_text?.toLowerCase().trim();

      const allDocs = snapshot.docs.map((doc: QueryDocumentSnapshot) => {
        const data = doc.data();
        return {
          id: doc.id,
          title: data.title as string,
          body: data.body as string,
          topic: data.topic as string | null,
          author: data.author as string,
          access_count: (data.access_count as number | undefined) ?? 0,
          last_accessed_at:
            data.last_accessed_at?.toDate?.()?.toISOString() ?? null,
          created_at: data.created_at?.toDate?.()?.toISOString() ?? null,
          updated_at: data.updated_at?.toDate?.()?.toISOString() ?? null,
        };
      });

      // Apply client-side text filter (case-insensitive substring on
      // title + body) if query_text was provided.
      const filtered = needle
        ? allDocs.filter(
            (m: { title: string; body: string }) =>
              m.title.toLowerCase().includes(needle) ||
              m.body.toLowerCase().includes(needle)
          )
        : allDocs;

      const results = filtered.slice(0, effectiveLimit);

      // Best-effort access-count + last_accessed_at increment for each
      // returned doc. Failures are logged but don't fail the search.
      // Firestore atomic increment via FieldValue.increment(1).
      const now = Timestamp.now();
      const updatePromises = results.map((m: { id: string }) =>
        db
          .collection("shared_memories")
          .doc(m.id)
          .update({
            access_count: FieldValue.increment(1),
            last_accessed_at: now,
          })
          .catch((e: Error) => {
            console.error(
              `Failed to bump access_count for memory ${m.id}: ${e.message}`
            );
          })
      );
      // Fire-and-forget — don't block search response on telemetry writes.
      Promise.all(updatePromises);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                count: results.length,
                filtered_from: snapshot.size,
                memories: results,
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
    "board_delete_shared_memory",
    "Hard-delete a single shared memory by its document ID. Irreversible. Use sparingly — most stale memories should be UPDATED (rewrite the body) rather than deleted, so the institutional history stays intact. Returns { id, title, deleted } on success or { error } when the memory doesn't exist. Use dry_run=true to preview what would be deleted without actually deleting.",
    {
      memory_id: z
        .string()
        .describe(
          "Document ID of the shared memory to delete. Get from board_save_shared_memory response or board_search_shared_memories results."
        ),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "If true, return the memory metadata without actually deleting. Useful for confirming you're targeting the right doc. Default false."
        ),
    },
    async ({ memory_id, dry_run }) => {
      const docRef = db.collection("shared_memories").doc(memory_id);
      const snap = await docRef.get();

      if (!snap.exists) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Shared memory ${memory_id} not found`,
              }),
            },
          ],
        };
      }

      const data = snap.data() ?? {};
      const title = (data.title as string | undefined) ?? "(no title)";

      if (dry_run) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  dry_run: true,
                  id: memory_id,
                  title,
                  topic: (data.topic as string | null) ?? null,
                  author: (data.author as string | undefined) ?? null,
                  body_length: ((data.body as string | undefined) ?? "").length,
                  message: `DRY RUN — would delete memory "${title}" (${memory_id}). Re-call with dry_run=false to actually delete.`,
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
                id: memory_id,
                title,
                deleted: true,
                message: `Deleted shared memory "${title}" (${memory_id}). This is irreversible.`,
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
