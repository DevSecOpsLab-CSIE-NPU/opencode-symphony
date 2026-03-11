// Local Issue Storage Schema (SQLite)
// Alternative to Linear - self-contained issue tracking system

export interface Issue {
  id: string;              // UUID
  key: string;             // e.g., "SYM-001"
  title: string;
  description: string;
  status: StatusType;      // backlog | todo | in-progress | reviewing | done | canceled
  priority: PriorityType;  // lowest | low | medium | high | highest
  createdAt: Date;
  updatedAt: Date;
}

export type StatusType = "backlog" | "todo" | "in-progress" | "reviewing" | "done" | "canceled";
export type PriorityType = "lowest" | "low" | "medium" | "high" | "highest";

export const STATUS_COLORS = {
  backlog: "gray",
  todo: "yellow",
  "in-progress": "blue",
  reviewing: "cyan",
  done: "green",
  canceled: "red",
};

export const PRIORITY_COLORS = {
  highest: "brightRed",
  high: "red",
  medium: "yellow",
  low: "gray",
  lowest: "dim",
};

// SQLite Schema (run on first initialization)
export const SQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'backlog',
  priority TEXT NOT NULL DEFAULT 'medium',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  
  CHECK (status IN ('backlog', 'todo', 'in-progress', 'reviewing', 'done', 'canceled')),
  CHECK (priority IN ('lowest', 'low', 'medium', 'high', 'highest'))
);

CREATE INDEX IF NOT EXISTS idx_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_priority ON issues(priority);
CREATE INDEX IF NOT EXISTS idx_created_at ON issues(created_at);

-- Activity log for timeline view
CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  action TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);
`;
