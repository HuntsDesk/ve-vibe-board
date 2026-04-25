import { Timestamp } from "firebase-admin/firestore";

export type Priority = "critical" | "high" | "medium" | "low";

export interface Project {
  name: string;
  description: string | null;
  status: "active" | "paused" | "completed" | "archived";
  priority: Priority;
  metadata: Record<string, unknown>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Task {
  project_id: string;
  title: string;
  description: string | null;
  status: "backlog" | "todo" | "in_progress" | "blocked" | "review" | "done";
  priority: Priority;
  assigned_agent: string | null;
  parent_task_id: string | null;
  depends_on: string[];
  riper_mode:
    | "research"
    | "innovate"
    | "plan"
    | "execute"
    | "review"
    | "commit"
    | null;
  metadata: Record<string, unknown>;
  created_at: Timestamp;
  updated_at: Timestamp;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
}

export interface Session {
  project_id: string;
  session_type: "solo" | "team" | "background";
  status: "active" | "completed" | "crashed" | "abandoned";
  started_at: Timestamp;
  ended_at: Timestamp | null;
  progress_summary: string | null;
  handoff_notes: string | null;
  context_artifacts: {
    files_modified?: string[];
    decisions_made?: string[];
    blockers?: string[];
    next_steps?: string[];
    [key: string]: unknown;
  };
  metadata: Record<string, unknown>;
}

export interface ActivityLog {
  task_id: string | null;
  session_id: string | null;
  agent_name: string;
  action:
    | "created"
    | "updated"
    | "claimed"
    | "blocked"
    | "completed"
    | "commented"
    | "mode_changed"
    | "session_started"
    | "session_ended";
  details: string | null;
  metadata: Record<string, unknown>;
  created_at: Timestamp;
}

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "blocked",
  "review",
  "done",
] as const;

export const TASK_PRIORITIES = [
  "critical",
  "high",
  "medium",
  "low",
] as const;

export const SESSION_TYPES = ["solo", "team", "background"] as const;

export const RIPER_MODES = [
  "research",
  "innovate",
  "plan",
  "execute",
  "review",
  "commit",
] as const;
