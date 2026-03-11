// ========== Branding helpers ==========
type Brand<T, B extends string> = T & { readonly __brand: B };

export type IssueId       = Brand<string, "IssueId">;
export type IssueKey      = Brand<string, "IssueKey">;       // e.g. "TEAM-123"
export type WorkspaceRoot = Brand<string, "WorkspaceRoot">;  // absolute path
export type WorkspacePath = Brand<string, "WorkspacePath">;  // absolute path
export type IsoDateTime   = Brand<string, "IsoDateTime">;
export type Millis        = Brand<number, "Millis">;
export type AttemptId     = Brand<string, "AttemptId">;
export type SessionId     = Brand<string, "SessionId">;
export type RpcId         = Brand<string, "RpcId">;
export type Role          = "orchestrator" | "worker" | "reviewer";

// ========== WORKFLOW.md front matter ==========
export interface WorkflowFrontMatter {
  linear: {
    apiUrl?: string;           // default: https://api.linear.app/graphql
    pollIntervalMs: number;    // default: 30000
    teamIds?: string[];
    states?: string[];
    labels?: string[];
    stateIds?: {
      inProgress?: string;
      done?: string;
    };
  };
  workspace: {
    root: WorkspaceRoot;
    maxConcurrentAgents: number; // default: 10
    cleanupOnSuccess: boolean;      // default: true
    cleanupOnFailure: boolean;      // default: false
    keepHistoryDays: string;        // default: "30"
  };
    root: WorkspaceRoot;
    maxConcurrentAgents: number; // default: 10
  };
  retry: {
    maxAttempts: number;
    maxRetryBackoffMs: Millis;
  };
  timeouts: {
    workerRunTimeoutMs: Millis;
    reviewerRunTimeoutMs: Millis;
    sessionIdleTimeoutMs: Millis;
  };
  appServer: {
    command: string;           // e.g. "opencode"
    args?: string[];
    env?: Record<string, string>;
  };
}

export interface WorkflowDefinition {
  path: string;
  revision: number;           // increments on reload
  loadedAt: IsoDateTime;
  frontMatter: WorkflowFrontMatter;
  liquidTemplate: string;     // WORKFLOW.md body
}

// ========== Linear Issue (normalized) ==========
export interface LinearIssue {
  id: IssueId;
  key: IssueKey;
  title: string;
  url: string;
  description?: string;
  state: {
    id: string;
    name: string;
    type?: "triage" | "backlog" | "started" | "completed" | "canceled";
  };
  priority?: number;
  assignee?: { id: string; name: string } | null;
  labels: string[];
  updatedAt: IsoDateTime;
  createdAt: IsoDateTime;
}

// ========== Per-issue lifecycle ==========
export type IssueLifecycleState =
  | { kind: "discovered";      firstSeenAt: IsoDateTime }
  | { kind: "queued";          queuedAt: IsoDateTime; reason: string }
  | { kind: "running";         sessionId: SessionId; attempt: number; startedAt: IsoDateTime }
  | { kind: "awaiting_review"; sessionId: SessionId; attempt: number; workerAttemptId: AttemptId; startedAt: IsoDateTime }
  | { kind: "reviewing";       sessionId: SessionId; attempt: number; reviewerAttemptId: AttemptId; startedAt: IsoDateTime }
  | { kind: "needs_changes";   sessionId: SessionId; attempt: number; reviewSummary: string; updatedAt: IsoDateTime }
  | { kind: "succeeded";       sessionId: SessionId; finishedAt: IsoDateTime; pr?: PullRequestDraft }
  | { kind: "failed";          sessionId?: SessionId; finishedAt: IsoDateTime; error: SerializableError }
  | { kind: "retry_wait";      nextRunAt: IsoDateTime; attempt: number; reason: string; backoffMs: Millis };

// ========== Attempt ==========
export type AttemptStatus = "scheduled" | "running" | "succeeded" | "failed" | "canceled" | "timed_out";
export type AttemptKind   = "work" | "review";

export interface RunAttempt {
  id: AttemptId;
  issueId: IssueId;
  issueKey: IssueKey;
  kind: AttemptKind;
  role: Extract<Role, "worker" | "reviewer">;
  attempt: number;                 // 1-based
  workflowRevision: number;
  status: AttemptStatus;
  scheduledAt: IsoDateTime;
  startedAt?: IsoDateTime;
  endedAt?: IsoDateTime;
  timeoutMs: Millis;
  backoffMs?: Millis;
  error?: SerializableError;
  sessionId?: SessionId;
  appServerPid?: number;
  artifacts?: AttemptArtifacts;
}

export interface AttemptArtifacts {
  summary?: string;
  changedFiles?: string[];
  diff?: string;
  commands?: Array<{
    cmd: string;
    exitCode: number | null;
    startedAt: IsoDateTime;
    endedAt?: IsoDateTime;
    stdoutTail?: string;
    stderrTail?: string;
  }>;
  tests?: Array<{ name: string; passed: boolean; details?: string }>;
  logsRef?: string;
}

// ========== Session ==========
export type SessionStatus = "starting" | "ready" | "busy" | "closing" | "closed" | "crashed";

export interface LiveSession {
  id: SessionId;
  issueId: IssueId;
  issueKey: IssueKey;
  workspaceRoot: WorkspaceRoot;
  workspacePath: WorkspacePath;
  status: SessionStatus;
  createdAt: IsoDateTime;
  lastHeartbeatAt: IsoDateTime;
  processes: Partial<Record<Extract<Role, "worker" | "reviewer">, AppServerProcess>>;
}

export interface AppServerProcess {
  role: Extract<Role, "worker" | "reviewer">;
  pid?: number;
  status: "spawning" | "ready" | "busy" | "exited";
  startedAt: IsoDateTime;
  exitedAt?: IsoDateTime;
  exitCode?: number | null;
}

// ========== Retry ==========
export interface RetryEntry {
  issueId: IssueId;
  issueKey: IssueKey;
  attempt: number;
  nextRunAt: IsoDateTime;
  backoffMs: Millis;
  reason: string;
}

// ========== Review / PR ==========
export interface PullRequestDraft {
  title: string;
  body: string;
  labels?: string[];
  reviewers?: string[];
}

export type GateStatus = "pass" | "fail";

export interface ReviewResult {
  gate: GateStatus;
  summary: string;
  requiredChanges?: string[];
  prDraft?: PullRequestDraft;  // only when gate === "pass"
}

export interface WorkResult {
  summary: string;
  diff?: string;
  changedFiles?: string[];
  suggestedNextStep?: "review" | "more_work";
  notes?: string;
}

// ========== Error ==========
export interface SerializableError {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
}

// ========== Orchestrator state (SPEC 4.1.8) ==========
export interface OrchestratorState {
  workflow: WorkflowDefinition;
  issuesById: Map<IssueId, LinearIssue>;
  issueLifecycleById: Map<IssueId, IssueLifecycleState>;
  maxConcurrentAgents: number;
  runningIssueIds: Set<IssueId>;
  queuedIssueIds: Set<IssueId>;
  retryByIssueId: Map<IssueId, RetryEntry>;
  sessionsById: Map<SessionId, LiveSession>;
  sessionIdByIssueId: Map<IssueId, SessionId>;
  attemptsById: Map<AttemptId, RunAttempt>;
  attemptIdsByIssueId: Map<IssueId, AttemptId[]>;
  inflightRpc: Map<RpcId, {
    attemptId: AttemptId;
    role: "worker" | "reviewer";
    startedAt: IsoDateTime;
    method: string;
  }>;
  startedAt: IsoDateTime;
  isRunning: boolean;
}

// ========== Orchestrator events ==========
export type OrchestratorEvent =
  | { type: "workflow.reloaded";    workflow: WorkflowDefinition }
  | { type: "linear.polled";        issues: LinearIssue[]; polledAt: IsoDateTime }
  | { type: "scheduler.tick";       now: IsoDateTime }
  | { type: "issue.enqueue";        issueId: IssueId; reason: string; at: IsoDateTime }
  | { type: "issue.start_work";     issueId: IssueId; at: IsoDateTime }
  | { type: "worker.finished";      issueId: IssueId; attemptId: AttemptId; result: WorkResult; at: IsoDateTime }
  | { type: "worker.failed";        issueId: IssueId; attemptId: AttemptId; error: SerializableError; at: IsoDateTime }
  | { type: "reviewer.finished";    issueId: IssueId; attemptId: AttemptId; result: ReviewResult; at: IsoDateTime }
  | { type: "reviewer.failed";      issueId: IssueId; attemptId: AttemptId; error: SerializableError; at: IsoDateTime }
  | { type: "attempt.timed_out";    issueId: IssueId; attemptId: AttemptId; role: "worker" | "reviewer"; at: IsoDateTime }
  | { type: "attempt.canceled";     issueId: IssueId; attemptId: AttemptId; at: IsoDateTime }
  | { type: "retry.due";            issueId: IssueId; at: IsoDateTime }
  | { type: "manual.retry_issue";   issueId: IssueId; reason: string; at: IsoDateTime }
  | { type: "manual.stop";          at: IsoDateTime };
