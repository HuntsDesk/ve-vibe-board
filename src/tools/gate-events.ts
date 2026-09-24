import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Firestore, Timestamp, Query, DocumentData } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Gate telemetry — cross-dev store for the Claude Code hook events that each
 * developer machine records locally in `.claude/telemetry/gate-events.jsonl`
 * (fact-gate, protected-files-gate, review-gate, gitleaks-gate denies/overrides
 * and, since 2026-09-16, `bash-edit` edit events for files changed through Bash).
 *
 * Design RFC `UdtTVqFRTACAga9gqbX1` (founder-approved 2026-09-16):
 * - Firestore collection `gate_events`, ONE document per event.
 * - Doc id = sha1(dev | session_id | ts | hook | event | path | paths) so
 *   re-ingesting the same local file is a no-op. The SAME function lives in
 *   `scripts/ingest-gate-events.mjs` (the hook-driven automatic path); keep the
 *   two in sync or duplicates appear.
 * - The hook never writes to the network. Ingest happens OFF the edit path:
 *   SessionStart/Stop hooks spawn the script detached; this MCP tool is the
 *   manual fallback (/close Step 4, /self-improve Step 2).
 * - The local JSONL stays the durable capture; Firestore is the mirror.
 */

export function gateEventDocId(rec: Record<string, unknown>, dev: string): string {
  const paths = Array.isArray(rec.paths) ? (rec.paths as unknown[]).map(String).join(",") : "";
  const key = JSON.stringify([
    dev,
    String(rec.session_id ?? ""),
    String(rec.ts ?? ""),
    String(rec.hook ?? ""),
    String(rec.event ?? ""),
    String(rec.path ?? ""),
    paths,
  ]);
  return createHash("sha1").update(key).digest("hex");
}

export function registerGateEventTools(server: McpServer, db: Firestore) {
  server.tool(
    "board_ingest_gate_events",
    "Upload local gate-telemetry lines (from .claude/telemetry/gate-events.jsonl) into the shared `gate_events` collection so /self-improve can read every developer's hook events, not just this machine's. Idempotent: the document id is derived from the event's content, so sending the same lines twice writes nothing new. The AUTOMATIC path is the SessionStart/Stop hook (scripts/ingest-gate-events.mjs); call this only as the manual fallback (/close Step 4, or a catch-up in /self-improve). Returns { received, written, invalid, dev }.",
    {
      lines: z.array(z.string()).min(1).max(2000).describe("Raw JSONL lines exactly as they appear in the local file (one JSON object per line)."),
      dev: z.string().min(1).max(200).describe("Developer identity for attribution — use `git config user.email`. Every document is stamped with it."),
      source_file: z.string().optional().describe("Optional path of the local file these lines came from (recorded for audit only)."),
    },
    async ({ lines, dev, source_file }) => {
      let written = 0, invalid = 0;
      const col = db.collection("gate_events");
      let batch = db.batch(); let inBatch = 0;
      for (const line of lines) {
        let rec: Record<string, unknown>;
        try { rec = JSON.parse(line); } catch { invalid++; continue; }
        if (!rec || typeof rec !== "object" || !rec.hook || !rec.event || !rec.ts) { invalid++; continue; }
        const id = gateEventDocId(rec, dev);
        batch.set(col.doc(id), {
          ...rec,
          dev,
          ingested_at: Timestamp.now(),
          source_file: source_file ?? null,
        });
        inBatch++; written++;
        if (inBatch >= 400) { await batch.commit(); batch = db.batch(); inBatch = 0; }
      }
      if (inBatch > 0) await batch.commit();
      return { content: [{ type: "text", text: JSON.stringify({ received: lines.length, written, invalid, dev }) }] };
    }
  );

  server.tool(
    "board_query_gate_events",
    "Read gate-telemetry events across ALL developers from the shared `gate_events` collection. Filter by dev (git email), hook (fact-gate | protected-files-gate | review-gate | gitleaks-gate | bash-edit), event (deny | override_consumed | marker_consumed | edit | ...), path (exact repo-relative path; for bash-edit events matches any entry of `paths`), and since (ISO date/time). Returns newest-first with per-dev and per-hook counts, so a /self-improve read can say 'fact-gate denied path X in N sessions across M devs' without touching either machine's local file.",
    {
      dev: z.string().optional(),
      hook: z.string().optional(),
      event: z.string().optional(),
      path: z.string().optional(),
      since: z.string().optional().describe("ISO 8601 lower bound on `ts`, e.g. 2026-09-16 or 2026-09-16T00:00:00Z"),
      limit: z.number().int().min(1).max(1000).optional().describe("Default 200"),
    },
    async ({ dev, hook, event, path, since, limit }) => {
      const lim = limit ?? 200;
      const base = (): Query<DocumentData> => {
        let q: Query<DocumentData> = db.collection("gate_events");
        if (dev) q = q.where("dev", "==", dev);
        if (hook) q = q.where("hook", "==", hook);
        if (event) q = q.where("event", "==", event);
        if (since) q = q.where("ts", ">=", since.length === 10 ? since + "T00:00:00Z" : since);
        return q;
      };
      // `path` is matched SERVER-SIDE with two queries (scalar `path` on gate events,
      // array `paths` on bash-edit events) and merged — a client-side filter after
      // limit() would silently under-return, and "0 denies on this path" must mean
      // exactly that. Every filter combination used here has a declared composite
      // index (firestore.indexes.json: gate_events × {dev,hook,event,hook+event,
      // dev+hook,path,paths} + ts desc).
      const queries: Query<DocumentData>[] = path
        ? [base().where("path", "==", path), base().where("paths", "array-contains", path)]
        : [base()];
      const seen = new Map<string, Record<string, unknown>>();
      let scanned = 0;
      try {
        for (const q of queries) {
          const snap = await q.orderBy("ts", "desc").limit(lim).get();
          scanned += snap.size;
          for (const d of snap.docs) if (!seen.has(d.id)) seen.set(d.id, { id: d.id, ...(d.data() as Record<string, unknown>) });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const missingIndex = /FAILED_PRECONDITION|requires an index/i.test(msg);
        return { content: [{ type: "text", text: JSON.stringify({
          error: missingIndex ? "missing_composite_index" : "query_failed",
          message: msg,
          fix: missingIndex ? "Create the index (the message carries a console link) or `firebase deploy --only firestore:indexes` from docs/ve-vibe-board/; the declared set is in firestore.indexes.json." : undefined,
        }) }], isError: true };
      }
      const rows = [...seen.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, lim);
      const byDev: Record<string, number> = {}; const byHook: Record<string, number> = {};
      for (const r of rows) {
        byDev[String(r.dev)] = (byDev[String(r.dev)] ?? 0) + 1;
        const k = String(r.hook) + "/" + String(r.event);
        byHook[k] = (byHook[k] ?? 0) + 1;
      }
      // window_truncated: a query hit its limit, so older matching events exist beyond this page
      const windowTruncated = scanned >= lim;
      return { content: [{ type: "text", text: JSON.stringify({ count: rows.length, scanned, limit: lim, window_truncated: windowTruncated, by_dev: byDev, by_hook_event: byHook, events: rows }, null, 2) }] };
    }
  );
}
