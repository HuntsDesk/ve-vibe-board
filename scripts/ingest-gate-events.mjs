#!/usr/bin/env node
// ingest-gate-events.mjs — push this machine's NEW gate-telemetry lines to the
// Vibe Board's Firestore `gate_events` collection. The AUTOMATIC path: spawned
// detached by .claude/hooks/telemetry-ingest.sh on SessionStart and Stop, so
// no model call and no human step is needed. Also runnable by hand
// (scripts/ingest-gate-events.sh) and in --dry-run / --count modes.
//
//   node vibe-board/scripts/ingest-gate-events.mjs [--dry-run] [--count] [--file <jsonl>]
//
// Contract:
//   * exit 0 ALWAYS. A network or credential failure prints INGEST=error and
//     leaves the watermark untouched, so the next run retries. Nothing here
//     may ever make a hook fail or a window hang.
//   * watermark = byte offset in .claude/telemetry/.ingested-offset; advanced
//     to the end of the longest HANDLED PREFIX, where handled means written OR
//     quarantined. Re-sending is a no-op (content-derived doc ids), so a row
//     written behind a deferred one simply re-sends next run.
//   * credentials = GOOGLE_APPLICATION_CREDENTIALS (path or raw JSON), else the
//     same value from the project's gitignored .mcp.json (mcpServers.agent-board.env).
//   * dev = VE_DEV_ID, else `git config user.email`, else user@host.
//   * hard wall: 8 s, then INGEST=timeout and exit 0.
//   * doc id = sha1(JSON.stringify([dev, session_id, ts, hook, event, path, paths.join(",")]))
//     — MUST match gateEventDocId() in src/tools/gate-events.ts.
//
// POISON-PILL DISCIPLINE (2026-09-19, board Tt1iQlle8PaHCW8CCRnn). A Firestore
// document is capped at 1 MiB and a batch commit is all-or-nothing whose error
// names no document. Before this, ONE un-ingestable row threw, the watermark
// never moved, and every later run re-read and re-failed the same row — ingest
// dead permanently while the hook exited 0 and logged to /tmp, i.e. a frozen
// watermark indistinguishable from an idle queue
// (.claude/rules/silent-degradation.md). Three properties now hold:
//   1. an un-ingestable row is QUARANTINED WHOLE to gate-events.deadletter.jsonl
//      — never truncated to fit (CLAUDE.md "never truncate data") — and the
//      rows after it still go. The append happens at FLUSH time, paired with the
//      watermark write, so a run killed by the wall cannot re-append it forever;
//   2. a TRANSIENT failure (network, auth, quota) quarantines NOTHING and
//      advances NOTHING: it retries next run. The two are told apart by
//      positive control, not by guesswork — see classify()/connectionIsHealthy();
//   3. .ingest-state.json carries last_success_at / last_error, and the run
//      status is derived from the ROW STATES rather than any counter, so a row
//      parked by a branch that owns no counter still reports `partial`. That is
//      not hypothetical: a failed dead-letter append once reported `ok` and
//      stamped last_success_at over a watermark that would never move again
//      (board qoFFB6fPWx57wC3AyZ4M) — the original wedge wearing the freshness
//      signal as a disguise;
//   4. the poison BRAKE below bounds how much of a backlog one run may divert,
//      because "the server rejected every row" is a claim about the server far
//      more often than about the rows.
// Exit statuses on the INGEST= line: ok | partial | nothing-new | skipped |
// error | timeout | dry-run | count. `partial` means work is HELD, not lost.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, appendFileSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname, userInfo } from "node:os";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const argFile = (() => { const i = process.argv.indexOf("--file"); return i > 0 ? process.argv[i + 1] : null; })();
const project = process.env.CLAUDE_PROJECT_DIR || resolve(here, "..", "..");
const telemetryFile = argFile || join(project, ".claude", "telemetry", "gate-events.jsonl");
const offsetFile = join(dirname(telemetryFile), ".ingested-offset");
const deadLetterFile = join(dirname(telemetryFile), "gate-events.deadletter.jsonl");
const stateFile = join(dirname(telemetryFile), ".ingest-state.json");
const DRY = args.has("--dry-run");
const COUNT = args.has("--count");

// Firestore's hard per-document limit is 1 MiB INCLUDING field names and index
// overhead. The local budget sits just under it so an oversized row is decided
// HERE — cheaply, deterministically, offline — instead of by parsing a server
// error string. VE_INGEST_MAX_DOC_BYTES lowers it for the test suite.
const MAX_DOC_BYTES = Number(process.env.VE_INGEST_MAX_DOC_BYTES || 1000000);
const BATCH_SIZE = 400;
const WALL_MS = Number(process.env.VE_INGEST_WALL_MS || 8000);   // test seam; 8 s in production
// POISON BRAKE. gRPC INVALID_ARGUMENT is returned for a row-specific fault AND
// for a systematic one (a payload-shape regression, a bad project id), so
// "quarantine everything the server rejects" would divert a whole backlog to the
// dead-letter file — preserved whole, but never reaching the shared store and
// recoverable only by hand. Past these bounds the poison RATE is the implausible
// thing, not the rows: stop, defer the rest, exit partial, name it for a human.
// Applies ONLY to write-failure quarantines — the local size pre-check is
// deterministic per row and cannot mass-misfire, so it is exempt.
const POISON_BRAKE_ABS = Number(process.env.VE_INGEST_POISON_BRAKE_ABS || 20);
const POISON_BRAKE_FRACTION = Number(process.env.VE_INGEST_POISON_BRAKE_FRACTION || 0.25);
const POISON_BRAKE_MIN_RUN = Number(process.env.VE_INGEST_POISON_BRAKE_MIN_RUN || 12);

function out(k, v) { process.stdout.write(`${k}=${v}\n`); }
function msg(e) { return String(e?.message || e).slice(0, 160); }
function docId(rec, dev) {
  const paths = Array.isArray(rec.paths) ? rec.paths.map(String).join(",") : "";
  const key = JSON.stringify([dev, String(rec.session_id ?? ""), String(rec.ts ?? ""), String(rec.hook ?? ""), String(rec.event ?? ""), String(rec.path ?? ""), paths]);
  return createHash("sha1").update(key).digest("hex");
}
function devId() {
  if (process.env.VE_DEV_ID) return process.env.VE_DEV_ID;
  try { const e = execSync("git config user.email", { cwd: project, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); if (e) return e; } catch {}
  return `${userInfo().username}@${hostname()}`;
}
function loadCreds() {
  let v = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!v) {
    try {
      const mcp = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf-8"));
      v = mcp?.mcpServers?.["agent-board"]?.env?.GOOGLE_APPLICATION_CREDENTIALS || mcp?.mcpServers?.["vibe-board"]?.env?.GOOGLE_APPLICATION_CREDENTIALS;
    } catch {}
  }
  if (!v) return null;
  const t = v.trim();
  return t.startsWith("{") ? JSON.parse(t) : JSON.parse(readFileSync(v, "utf-8"));
}
// Every row carries its own END byte offset. Without per-row offsets the
// watermark can only mean "all of this chunk or none of it", which is precisely
// what made one bad row fatal.
function readNewLines() {
  if (!existsSync(telemetryFile)) return { items: [], start: 0, end: 0 };
  const size = statSync(telemetryFile).size;
  let start = 0;
  try { start = parseInt(readFileSync(offsetFile, "utf-8").trim(), 10) || 0; } catch {}
  if (start > size) start = 0;                       // file was truncated/rotated
  // Size alone does not detect a rotation into a file that is already LARGER
  // than the old watermark — that resumes mid-file and can start mid-line. The
  // byte before a valid watermark is always a newline, so check it and rescan
  // from 0 when it is not. Re-sending is free (content-derived doc ids).
  if (start > 0 && start <= size) {
    const probeFd = openSync(telemetryFile, "r");
    const one = Buffer.alloc(1);
    readSync(probeFd, one, 0, 1, start - 1); closeSync(probeFd);
    if (one[0] !== 0x0a) { out("RESCAN", `watermark ${start} is not on a line boundary (rotation?) — rescanning from 0`); start = 0; }
  }
  if (start === size) return { items: [], start, end: size };
  const fd = openSync(telemetryFile, "r");
  const buf = Buffer.alloc(size - start);
  readSync(fd, buf, 0, buf.length, start); closeSync(fd);
  const text = buf.toString("utf-8");
  const lastNl = text.lastIndexOf("\n");
  const complete = lastNl >= 0 ? text.slice(0, lastNl + 1) : "";   // never ingest a half-written line
  const parts = complete.split("\n"); parts.pop();                 // the "" after the final newline
  const items = []; let cursor = start;
  for (const raw of parts) {
    cursor += Buffer.byteLength(raw, "utf-8") + 1;                 // + the newline itself
    if (raw !== "") items.push({ raw, end: cursor });              // a blank line is consumed, not ingested
  }
  return { items, start, end: start + Buffer.byteLength(complete, "utf-8") };
}

const dev = devId();
const { items, start, end } = readNewLines();
// rows keep FILE ORDER, invalid ones included: the watermark walk at the bottom
// depends on it.
const rows = [];
for (const it of items) {
  let rec = null, bad = null;
  try { rec = JSON.parse(it.raw); } catch { bad = "unparseable-json"; }
  if (!bad && !(rec && rec.hook && rec.event && rec.ts)) { bad = "missing-required-fields"; rec = null; }
  rows.push({ raw: it.raw, end: it.end, rec, bad, status: "pending" });
}
const parsedRows = rows.filter((r) => r.rec);
const invalid = rows.length - parsedRows.length;

if (DRY) {
  out("INGEST", "dry-run"); out("dev", dev); out("file", telemetryFile); out("offset_from", start); out("offset_to", end);
  out("new_lines", items.length); out("valid", parsedRows.length); out("invalid", invalid);
  for (const r of parsedRows) out("id", `${docId(r.rec, dev)} ${r.rec.hook}/${r.rec.event} ${r.rec.path ?? (Array.isArray(r.rec.paths) ? r.rec.paths.length + " paths" : "")}`);
  process.exit(0);
}

// Freshness signal. Without it a DEAD ingest and an IDLE one are the same
// observation; /self-improve reads this file before trusting a zero count.
let counters = {};
try { counters = JSON.parse(readFileSync(stateFile, "utf-8")); } catch {}
function saveState(status, extra = {}) {
  try {
    const now = new Date().toISOString();
    const next = { ...counters, dev, last_run_at: now, last_status: status, source_file: telemetryFile, dead_letter_file: deadLetterFile, ...extra };
    if (status === "ok" || status === "nothing-new") { next.last_success_at = now; next.last_error = null; }
    writeFileSync(stateFile, JSON.stringify(next, null, 2) + "\n");
  } catch {}
}

const wall = setTimeout(() => { const at = flushAndAdvance(); out("INGEST", "timeout"); out("offset", at); saveState("timeout", { last_offset: at, last_error: `${WALL_MS} ms wall` }); process.exit(0); }, WALL_MS);
wall.unref?.();

// firebase-admin -> whatwg-url/tr46 -> `punycode` prints DEP0040 on every run,
// two lines of noise above the INGEST= line in every /tmp/ve-telemetry-ingest.*.log.
// Swallow THAT code only, keeping Node's own printer for everything else, so a
// real deprecation still surfaces. Done here rather than with
// `node --disable-warning=DEP0040` because that flag is a fatal bad-option on
// Node < 20.11 and the hook would then silently stop ingesting (fail-open).
{
  const printers = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (w) => { if (w?.code === "DEP0040") return; for (const p of printers) p.call(process, w); });
}

let admin;
try {
  const creds = loadCreds();
  if (!creds) { out("INGEST", "skipped"); out("reason", "no-credentials"); saveState("skipped", { last_error: "no-credentials" }); process.exit(0); }
  // VE_INGEST_ADMIN_MODULE is a TEST SEAM ONLY: an absolute path to a module
  // standing in for firebase-admin, so the suite can drive the oversized /
  // malformed / transient-failure paths with no network and no credential.
  admin = require(process.env.VE_INGEST_ADMIN_MODULE || "firebase-admin");
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(creds) });
} catch (e) {
  out("INGEST", "error"); out("reason", "init:" + msg(e)); saveState("error", { last_error: "init:" + msg(e) }); process.exit(0);
}
const db = admin.firestore();
const col = db.collection("gate_events");

if (COUNT) {
  try {
    const snap = await col.where("dev", "==", dev).count().get();
    const all = await col.count().get();
    out("INGEST", "count"); out("dev", dev); out("mine", snap.data().count); out("total", all.data().count);
  } catch (e) { out("INGEST", "error"); out("reason", "count:" + msg(e)); }
  process.exit(0);
}

if (rows.length === 0) {
  out("INGEST", "nothing-new"); out("invalid", 0);
  if (end !== start) writeFileSync(offsetFile, String(end));
  saveState("nothing-new", { last_offset: end });
  process.exit(0);
}

function payload(rec) { return { ...rec, dev, ingested_at: admin.firestore.Timestamp.now(), source_file: telemetryFile }; }
function docBytes(rec) {
  // Conservative stand-in for the stored document: the record plus the fields we
  // add. Field names and index entries count toward the 1 MiB cap too, hence the
  // slack here and the budget below the hard limit.
  return Buffer.byteLength(JSON.stringify({ ...rec, dev, source_file: telemetryFile }), "utf-8") + 256;
}

// Quarantine is a DECISION here and a WRITE at flush time, deliberately split.
// Appending on decision but moving the watermark only at the end means a run
// that dies in between (the wall, a crash) re-reads those rows next time and
// appends them AGAIN, unbounded. Deferring the append to the same moment the
// watermark moves — and appending only for rows inside the handled prefix —
// makes the dead letter idempotent across runs to within two syscalls.
// QUARANTINE_DECIDED is the DECISION; QUARANTINED is emitted by appendDeadLetter
// once the row is actually on disk. They were one line printed here, which meant
// a failed append still printed QUARANTINED= for a row the run then reported as
// quarantined=0 — an operator grepping the /tmp logs over-counted. The invariant
// now: QUARANTINED= lines in a run == that run's quarantined= summary count.
function markQuarantine(row, reason) {
  row.status = "quarantined"; row.qreason = reason;
  out("QUARANTINE_DECIDED", `${reason} bytes=${Buffer.byteLength(row.raw, "utf-8")} hook=${row.rec?.hook ?? "?"} event=${row.rec?.event ?? "?"} ts=${row.rec?.ts ?? "?"} -> ${deadLetterFile}`);
}
// The line-boundary RESCAN above re-reads rows this file may already hold, and
// `dead_lettered` is per-RUN state, so without this the same row is appended
// again on every rescan. Hash the raw line — the dead letter is small by
// construction, it only ever takes un-ingestable rows — and skip an append we
// have already made. Cheap and lazy: the file is read at most once per run, and
// only if something is actually being quarantined. A read failure caches an
// EMPTY set deliberately: a duplicate line is a nuisance, a dropped row is not.
let deadLetterHashes = null;
function rawHash(raw) { return createHash("sha1").update(raw).digest("hex"); }
function deadLetterSeen(raw) {
  if (deadLetterHashes === null) {
    deadLetterHashes = new Set();
    try {
      for (const line of readFileSync(deadLetterFile, "utf-8").split("\n")) {
        if (!line) continue;
        try { const r = JSON.parse(line); if (typeof r.raw === "string") deadLetterHashes.add(rawHash(r.raw)); } catch {}
      }
    } catch {}                                    // no file yet, or unreadable
  }
  return deadLetterHashes.has(rawHash(raw));
}
function appendDeadLetter(row) {
  if (row.dead_lettered) return true;
  // Already on disk from an earlier run's rescan. Still HANDLED, so the
  // watermark advances past it exactly as it would after a fresh append.
  if (deadLetterSeen(row.raw)) { row.dead_lettered = true; out("QUARANTINED", `${row.qreason} already-present -> ${deadLetterFile}`); return true; }
  const rec = { quarantined_at: new Date().toISOString(), reason: row.qreason, bytes: Buffer.byteLength(row.raw, "utf-8"), dev, source_file: telemetryFile, raw: row.raw };
  try {
    appendFileSync(deadLetterFile, JSON.stringify(rec) + "\n");   // the WHOLE line, never truncated
  } catch (e) {
    // Losing the row is worse than stalling: leave it unhandled so the watermark
    // does not pass it and the next run tries again. This branch MUST make the
    // run report `partial` — reporting `ok` here would refresh last_success_at
    // over a permanently parked watermark, which is the original wedge wearing
    // the freshness signal as a disguise (board qoFFB6fPWx57wC3AyZ4M).
    row.status = "deferred"; row.reason = "dead-letter-write:" + msg(e);
    out("QUARANTINE_FAILED", `${row.qreason} -> ${deadLetterFile}: ${msg(e)}`);
    return false;
  }
  row.dead_lettered = true;
  deadLetterHashes?.add(rawHash(row.raw));        // a second identical row this run
  out("QUARANTINED", `${row.qreason} bytes=${rec.bytes} -> ${deadLetterFile}`);
  return true;
}
// Flush the dead letter for the handled PREFIX, then move the watermark. Also
// called from the wall handler: rows whose write is in flight are still
// `pending`, so the walk stops before them and the short write is safe.
function flushAndAdvance() {
  let advanceTo = start, complete = true;
  for (const row of rows) {
    if (row.status === "written") { advanceTo = row.end; continue; }
    if (row.status === "quarantined") {
      if (appendDeadLetter(row)) { advanceTo = row.end; continue; }
      complete = false; break;                       // the append failed: row is deferred now
    }
    complete = false; break;                         // pending or deferred
  }
  if (complete) advanceTo = end;                     // consumes trailing blank lines too
  if (advanceTo > start) { try { writeFileSync(offsetFile, String(advanceTo)); } catch {} }
  return advanceTo;
}

// gRPC status codes. POISON = the server is telling us this DOCUMENT is
// unacceptable and will be on every retry. TRANSIENT = the call never got as far
// as judging the document.
const POISON_CODES = new Set([3, 11]);                            // INVALID_ARGUMENT, OUT_OF_RANGE
const TRANSIENT_CODES = new Set([1, 2, 4, 7, 8, 10, 13, 14, 16]); // CANCELLED, UNKNOWN, DEADLINE_EXCEEDED, PERMISSION_DENIED, RESOURCE_EXHAUSTED, ABORTED, INTERNAL, UNAVAILABLE, UNAUTHENTICATED
// firebase-admin also surfaces STRING codes, and they do not match the message
// regexes below (hyphenated "invalid-argument" is not the phrase "invalid
// argument"), so map them explicitly rather than relying on the fallback.
const STRING_CODES = {
  "invalid-argument": "poison", "invalid_argument": "poison", "out-of-range": "poison", "out_of_range": "poison",
  "unavailable": "transient", "deadline-exceeded": "transient", "deadline_exceeded": "transient",
  "resource-exhausted": "transient", "resource_exhausted": "transient", "aborted": "transient", "internal": "transient",
  "cancelled": "transient", "unknown": "transient", "permission-denied": "transient", "permission_denied": "transient",
  "unauthenticated": "transient",
};
const POISON_RE = /too large|exceeds the maximum|maximum size|invalid argument|is not a valid|invalid value|cannot contain|nested entit|field path|longer than/i;
const TRANSIENT_RE = /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|network|unavailable|deadline|quota|rate.?limit|credential|token|unauthenticat|permission denied/i;
function classify(e) {
  const code = typeof e?.code === "number" ? e.code : null;
  if (code !== null && POISON_CODES.has(code)) return "poison";
  if (code !== null && TRANSIENT_CODES.has(code)) return "transient";
  if (typeof e?.code === "string") {
    const mapped = STRING_CODES[e.code.toLowerCase().replace(/^firestore\//, "")];
    if (mapped) return mapped;
  }
  const s = String(e?.message || e);
  if (POISON_RE.test(s)) return "poison";
  if (TRANSIENT_RE.test(s)) return "transient";
  return "unknown";
}

// The positive control for an UNCLASSIFIABLE failure. "This one row is bad" and
// "every write is failing" throw the identical exception, so ask a question
// whose answer separates them: can a trivially small document be written right
// now? Yes -> the connection is fine and the failure belongs to the row.
// No -> transient, defer everything. (empty-result-discipline.md §0c: a probe
// that reports on live work must be able to fail loudly.) Its own collection,
// so a probe document can never surface in a gate_events query.
let probeState = null;
async function connectionIsHealthy() {
  if (probeState !== null) return probeState;
  try {
    await db.collection("gate_events_ingest_probe").doc(createHash("sha1").update(dev).digest("hex"))
      .set({ dev, at: admin.firestore.Timestamp.now() });
    probeState = true;
  } catch { probeState = false; }
  out("PROBE", probeState ? "write-ok (failures are row-attributable)" : "write-failed (treating failures as transient)");
  return probeState;
}

// Pre-pass: decide locally everything that CAN be decided locally.
const pending = [];
for (const row of rows) {
  if (!row.rec) { markQuarantine(row, "invalid-row:" + row.bad); continue; }
  const b = docBytes(row.rec);
  if (b > MAX_DOC_BYTES) { markQuarantine(row, `oversized:${b}>${MAX_DOC_BYTES}`); continue; }
  pending.push(row);
}

let written = 0, writePoison = 0, brakeTripped = false;
const brakeWouldTrip = () =>
  writePoison >= POISON_BRAKE_ABS ||
  (pending.length >= POISON_BRAKE_MIN_RUN && writePoison >= Math.ceil(pending.length * POISON_BRAKE_FRACTION));
for (let i = 0; i < pending.length; i += BATCH_SIZE) {
  const chunk = pending.slice(i, i + BATCH_SIZE);
  try {
    const batch = db.batch();
    for (const row of chunk) batch.set(col.doc(docId(row.rec, dev)), payload(row.rec));
    await batch.commit();
    for (const row of chunk) { row.status = "written"; written++; }
  } catch (e) {
    // A batch commit is atomic and its error names no document, so ISOLATE:
    // rewrite the chunk one row at a time and let each row answer for itself.
    out("BATCH_FAILED", `${msg(e)} — isolating ${chunk.length} row(s)`);
    const failures = [];
    let okCount = 0;
    for (const row of chunk) {
      try { await col.doc(docId(row.rec, dev)).set(payload(row.rec)); row.status = "written"; written++; okCount++; }
      catch (e2) { failures.push([row, e2, classify(e2)]); }
    }
    for (const [row, e2, kind] of failures) {
      let attributable = kind === "poison";
      if (kind === "unknown") attributable = okCount > 0 || await connectionIsHealthy();
      if (attributable && brakeWouldTrip()) {
        // Past the brake the RATE is the implausible thing, not the rows.
        brakeTripped = true; attributable = false;
        row.reason = `poison-brake:${writePoison} write-failure quarantines in one run — a systematic fault is likelier than that many bad rows`;
      }
      if (attributable) { writePoison++; markQuarantine(row, `write-failed:${kind}:${msg(e2)}`); }
      else { row.status = "deferred"; row.reason = row.reason || `${kind}:${msg(e2)}`; }
    }
    const heldRows = failures.filter(([r]) => r.status === "deferred");
    if (heldRows.length > 0) {
      out("DEFERRED", `${heldRows.length} row(s) held for the next run: ${heldRows[0][0].reason}`);
      break;
    }
  }
  if (brakeTripped) break;
}

// Advance past the longest HANDLED PREFIX (flushing its dead letter first). A
// row written behind a deferred one is simply re-sent next run — the doc id is
// content-derived, so that is a no-op, and this is the only ordering that can
// never skip an unattempted row.
const advanceTo = flushAndAdvance();

// STATUS COMES FROM THE ROW STATES, NEVER FROM A COUNTER. A counter incremented
// in one code path cannot see a row parked by another — that is exactly how a
// failed dead-letter append once reported `ok` and refreshed last_success_at
// over a watermark that would never move again (board qoFFB6fPWx57wC3AyZ4M).
// `advanceTo < end` additionally covers rows never attempted after a break.
const held = rows.filter((r) => r.status === "deferred").length;
const quarantined = rows.filter((r) => r.dead_lettered).length;
const status = held > 0 || advanceTo < end ? "partial" : "ok";
const firstHeld = rows.find((r) => r.status === "deferred") || rows.find((r) => r.status === "pending");
const lastError = status === "ok" ? null
  : brakeTripped ? `poison-brake: ${writePoison} write-failure quarantine(s) in one run — suspect a systematic INVALID_ARGUMENT (payload shape, project id), not ${writePoison} bad rows. Backlog HELD for a human; nothing past offset ${advanceTo} was diverted`
  : `held at offset ${advanceTo} of ${end}: ${firstHeld?.reason || firstHeld?.status || "unattempted"}`;

out("INGEST", status); out("dev", dev); out("written", written); out("quarantined", quarantined);
out("deferred", held); out("invalid", invalid); out("offset", advanceTo);
if (quarantined > 0) out("DEAD_LETTER", `${quarantined} row(s) in ${deadLetterFile} — inspect and delete; they will NOT be retried`);
if (lastError) out("HELD", lastError);
saveState(status, {
  last_offset: advanceTo,
  last_written: written,
  last_quarantined: quarantined,
  last_deferred: held,
  written_total: (counters.written_total || 0) + written,
  quarantined_total: (counters.quarantined_total || 0) + quarantined,
  ...(lastError ? { last_error: lastError } : {}),
});
process.exit(0);
