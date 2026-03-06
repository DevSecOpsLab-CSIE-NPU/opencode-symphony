# plugin-symphony 設計結論

> 版本：v1.0 | 日期：2026-03-06  
> 目標：在 OpenCode 內實作 OpenAI Symphony SPEC，採用 Orchestrator + Worker + Reviewer 三角色 LLM 協作架構。

---

## 目錄

1. [專案總覽](#1-專案總覽)
2. [三角色分工邊界](#2-三角色分工邊界)
3. [目錄結構](#3-目錄結構)
4. [Domain Types（完整 TypeScript）](#4-domain-types完整-typescript)
5. [Orchestrator 狀態機](#5-orchestrator-狀態機)
6. [MCP Tools 定義](#6-mcp-tools-定義)
7. [WorkspaceManager](#7-workspacemanager)
8. [Worker Turn Loop](#8-worker-turn-loop)
9. [Liquid 渲染設定](#9-liquid-渲染設定)
10. [Reviewer 決策樹與品質門檻](#10-reviewer-決策樹與品質門檻)
11. [Linear GraphQL 操作](#11-linear-graphql-操作)
12. [跨模組訊息型別](#12-跨模組訊息型別)
13. [WORKFLOW.md 格式](#13-workflowmd-格式)
14. [錯誤處理策略](#14-錯誤處理策略)
15. [關鍵技術決策](#15-關鍵技術決策)
16. [實作優先順序](#16-實作優先順序)
17. [待解問題](#17-待解問題)

---

## 1. 專案總覽

### 核心假設
- **Runtime**：TypeScript + Bun（`~/.bun/bin/bun`，v1.3.10）
- **Plugin SDK**：`@opencode-ai/plugin`（`tool()` helper + Zod schema）
- **Issue Tracker**：Linear（Symphony SPEC 原生支援）
- **Prompt Template**：WORKFLOW.md（YAML front matter + Liquid body）
- **PR 建立**：`gh` CLI 優先（無 `gh` 則 GitHub REST API）

### Symphony SPEC 安全不變量
```
workspace path 必須在 workspace root 內
驗證方式：realpath(candidate).startsWith(realpath(root) + path.sep)
```

### Retry Backoff 公式（SPEC exact）
```ts
Math.min(10000 * Math.pow(2, attempt - 1), max_retry_backoff_ms)
```

---

## 2. 三角色分工邊界

| 面向 | Orchestrator | Worker | Reviewer |
|------|-------------|--------|----------|
| **核心責任** | Poll Linear、排程、並行控制、狀態機、重試、工作區安全、動態重載 WORKFLOW | 在單一 issue workspace 產生/修改程式碼、執行指令、產出變更 | Code review、品質門檻(gates)、撰寫 PR 描述、建立 PR |
| **禁止做的事** | 不直接寫 code、不直接變更 workspace | 不決定排程/重試策略、不操作其他 issue workspace | 不執行大規模改碼（除非回報「必須修正」並交回 Worker） |
| **輸入** | Linear issue 狀態、WORKFLOW 模板、Worker/Reviewer 回報事件 | Orchestrator 派發任務（渲染後 prompt + workspace 路徑 + 嘗試次數） | Orchestrator 派發 review 任務（含變更摘要/diff/測試結果） |
| **輸出** | 任務派發、狀態更新、重試排程、MCP tool 回應 | diff/檔案列表/命令/測試/錯誤/建議下一步 | Gate 結果（pass/fail）、review 意見、PR 草稿 |
| **可靠性設計** | idempotent 派發、per-issue lock、超時/取消、backoff、workspace 越界防護 | 只在 cwd=workspace 下操作；回報結構化事件；可被取消 | 只讀取產物與報告；輸出結構化 gate/review |

---

## 3. 目錄結構

```
plugin-symphony/
├── src/
│   ├── index.ts                          # Plugin entry point (MCP tools registration)
│   ├── messages.ts                       # Cross-module message types
│   ├── orchestrator/
│   │   ├── types.ts                      # OrchestratorState, OrchestratorEvent
│   │   ├── state.ts                      # applyEvent() reducer
│   │   ├── scheduler.ts                  # tick loop, Linear poller
│   │   └── commands.ts                   # Side-effect command executor
│   ├── worker/
│   │   ├── WorkerRunner.ts               # Turn loop
│   │   ├── OpenCodeAgentClient.ts        # Agent adapter interface
│   │   └── types.ts                      # WorkerEvent, WorkerConfig, WorkerResult
│   ├── reviewer/
│   │   ├── ReviewerWorkflow.ts           # Decision tree
│   │   ├── gates.ts                      # Deterministic quality gates
│   │   └── types.ts                      # ReviewResult, GateStatus
│   ├── workspace/
│   │   ├── WorkspaceManager.ts           # create/reuse/hooks/cleanup
│   │   └── hooks.ts                      # Hook executor (60s timeout)
│   ├── workflow/
│   │   ├── loader.ts                     # WORKFLOW.md YAML + body parser
│   │   ├── watcher.ts                    # fs.watch hot reload
│   │   └── LiquidRenderer.ts            # strictVariables: true
│   └── linear/
│       ├── client.ts                     # GraphQL client
│       ├── queries.ts                    # Issue/state queries
│       └── mutations.ts                  # updateState, addComment, linkPR
├── WORKFLOW.md                           # Default workflow template
├── package.json
├── tsconfig.json
└── DESIGN.md                            # 本文件
```

---

## 4. Domain Types（完整 TypeScript）

```ts
// ========== Branding helpers ==========
type Brand<T, B extends string> = T & { readonly __brand: B };

export type IssueId     = Brand<string, "IssueId">;
export type IssueKey    = Brand<string, "IssueKey">;       // e.g. "TEAM-123"
export type WorkspaceRoot = Brand<string, "WorkspaceRoot">; // absolute path
export type WorkspacePath = Brand<string, "WorkspacePath">; // absolute path
export type IsoDateTime = Brand<string, "IsoDateTime">;
export type Millis      = Brand<number, "Millis">;
export type AttemptId   = Brand<string, "AttemptId">;
export type SessionId   = Brand<string, "SessionId">;
export type RpcId       = Brand<string, "RpcId">;
export type Role        = "orchestrator" | "worker" | "reviewer";

// ========== WORKFLOW.md front matter ==========
export interface WorkflowFrontMatter {
  linear: {
    apiUrl?: string;           // default: https://api.linear.app/graphql
    pollIntervalMs: number;    // default: 30000
    teamIds?: string[];
    states?: string[];
    labels?: string[];
  };
  workspace: {
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
  | { kind: "discovered";     firstSeenAt: IsoDateTime }
  | { kind: "queued";         queuedAt: IsoDateTime; reason: string }
  | { kind: "running";        sessionId: SessionId; attempt: number; startedAt: IsoDateTime }
  | { kind: "awaiting_review"; sessionId: SessionId; attempt: number; workerAttemptId: AttemptId; startedAt: IsoDateTime }
  | { kind: "reviewing";      sessionId: SessionId; attempt: number; reviewerAttemptId: AttemptId; startedAt: IsoDateTime }
  | { kind: "needs_changes";  sessionId: SessionId; attempt: number; reviewSummary: string; updatedAt: IsoDateTime }
  | { kind: "succeeded";      sessionId: SessionId; finishedAt: IsoDateTime; pr?: PullRequestDraft }
  | { kind: "failed";         sessionId?: SessionId; finishedAt: IsoDateTime; error: SerializableError }
  | { kind: "retry_wait";     nextRunAt: IsoDateTime; attempt: number; reason: string; backoffMs: Millis };

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
```

---

## 5. Orchestrator 狀態機

### 核心原則
- **純 reducer**：`applyEvent()` 不做任何 side effect，只回傳新 state + command list
- **Command layer**：spawn/kill/timeout 都在 command layer 執行，完成後再 emit 對應事件
- **Idempotent**：亂序/重複事件不會破壞狀態（`runningIssueIds` 做 lock）

```ts
// orchestrator/state.ts

export type OrchestratorCommand =
  | { type: "spawn_and_run_worker";   issueId: IssueId; attemptId: AttemptId }
  | { type: "spawn_and_run_reviewer"; issueId: IssueId; attemptId: AttemptId; workerResult: WorkResult }
  | { type: "schedule_retry";         issueId: IssueId; entry: RetryEntry }
  | { type: "close_session";          sessionId: SessionId; reason: string };

function computeBackoffMs(attempt: number, maxMs: Millis): Millis {
  return Math.min(10000 * Math.pow(2, attempt - 1), maxMs as number) as Millis;
}

export function applyEvent(
  state: OrchestratorState,
  evt: OrchestratorEvent
): { state: OrchestratorState; commands: OrchestratorCommand[] } {
  const commands: OrchestratorCommand[] = [];

  switch (evt.type) {
    case "workflow.reloaded":
      state.workflow = evt.workflow;
      state.maxConcurrentAgents = evt.workflow.frontMatter.workspace.maxConcurrentAgents;
      break;

    case "linear.polled":
      for (const issue of evt.issues) {
        state.issuesById.set(issue.id, issue);
        if (!state.issueLifecycleById.has(issue.id)) {
          state.issueLifecycleById.set(issue.id, { kind: "discovered", firstSeenAt: evt.polledAt });
        }
        // Enqueue issues in "started" state
        if (issue.state.type === "started" && !state.runningIssueIds.has(issue.id)) {
          state.queuedIssueIds.add(issue.id);
        }
      }
      break;

    case "scheduler.tick":
      // 1. 促發到期的 retry
      for (const [issueId, entry] of state.retryByIssueId.entries()) {
        if (new Date(entry.nextRunAt).getTime() <= new Date(evt.now).getTime()) {
          state.queuedIssueIds.add(issueId);
          state.retryByIssueId.delete(issueId);
        }
      }
      // 2. 派發 queued issues（受 semaphore 限制）
      for (const issueId of state.queuedIssueIds) {
        if (state.runningIssueIds.size >= state.maxConcurrentAgents) break;
        if (state.runningIssueIds.has(issueId)) continue;
        commands.push({ type: "spawn_and_run_worker", issueId, attemptId: ("" as AttemptId) }); // AttemptId 由 command layer 產生
      }
      break;

    case "issue.enqueue":
      state.queuedIssueIds.add(evt.issueId);
      state.issueLifecycleById.set(evt.issueId, { kind: "queued", queuedAt: evt.at, reason: evt.reason });
      break;

    case "issue.start_work": {
      state.runningIssueIds.add(evt.issueId);
      state.queuedIssueIds.delete(evt.issueId);
      const attempt = (state.attemptIdsByIssueId.get(evt.issueId) ?? []).length + 1;
      state.issueLifecycleById.set(evt.issueId, {
        kind: "running",
        sessionId: "" as SessionId, // filled by command layer
        attempt,
        startedAt: evt.at,
      });
      break;
    }

    case "worker.finished": {
      const lc = state.issueLifecycleById.get(evt.issueId);
      if (!lc || (lc.kind !== "running" && lc.kind !== "needs_changes")) break;
      state.issueLifecycleById.set(evt.issueId, {
        kind: "awaiting_review",
        sessionId: (lc as any).sessionId,
        attempt: (lc as any).attempt,
        workerAttemptId: evt.attemptId,
        startedAt: evt.at,
      });
      commands.push({
        type: "spawn_and_run_reviewer",
        issueId: evt.issueId,
        attemptId: "" as AttemptId,
        workerResult: evt.result,
      });
      break;
    }

    case "worker.failed":
    case "attempt.timed_out": {
      if (evt.type === "attempt.timed_out" && evt.role !== "worker") break;
      const issue = state.issuesById.get(evt.issueId);
      const attemptIds = state.attemptIdsByIssueId.get(evt.issueId) ?? [];
      const currentAttempt = attemptIds.length;
      const maxAttempts = state.workflow.frontMatter.retry.maxAttempts;

      if (!issue || currentAttempt >= maxAttempts) {
        state.issueLifecycleById.set(evt.issueId, {
          kind: "failed",
          finishedAt: evt.at,
          error: evt.type === "worker.failed" ? evt.error : { name: "TimeoutError", message: "worker timed out" },
        });
      } else {
        const nextAttempt = currentAttempt + 1;
        const backoffMs = computeBackoffMs(nextAttempt, state.workflow.frontMatter.retry.maxRetryBackoffMs);
        const nextRunAt = new Date(Date.now() + (backoffMs as number)).toISOString() as IsoDateTime;
        const entry: RetryEntry = {
          issueId: evt.issueId,
          issueKey: issue.key,
          attempt: nextAttempt,
          nextRunAt,
          backoffMs,
          reason: evt.type === "worker.failed" ? evt.error.message : "worker timeout",
        };
        state.retryByIssueId.set(evt.issueId, entry);
        state.issueLifecycleById.set(evt.issueId, {
          kind: "retry_wait",
          nextRunAt,
          attempt: nextAttempt,
          reason: entry.reason,
          backoffMs,
        });
      }
      state.runningIssueIds.delete(evt.issueId);
      break;
    }

    case "reviewer.finished": {
      const lc = state.issueLifecycleById.get(evt.issueId);
      if (evt.result.gate === "pass") {
        state.issueLifecycleById.set(evt.issueId, {
          kind: "succeeded",
          sessionId: state.sessionIdByIssueId.get(evt.issueId)!,
          finishedAt: evt.at,
          pr: evt.result.prDraft,
        });
        state.runningIssueIds.delete(evt.issueId);
        const sid = state.sessionIdByIssueId.get(evt.issueId);
        if (sid) commands.push({ type: "close_session", sessionId: sid, reason: "completed" });
      } else {
        state.issueLifecycleById.set(evt.issueId, {
          kind: "needs_changes",
          sessionId: (lc as any)?.sessionId ?? ("" as SessionId),
          attempt: (lc as any)?.attempt ?? 0,
          reviewSummary: evt.result.summary,
          updatedAt: evt.at,
        });
        state.queuedIssueIds.add(evt.issueId);
        state.runningIssueIds.delete(evt.issueId);
      }
      break;
    }

    case "reviewer.failed": {
      const issue = state.issuesById.get(evt.issueId);
      const nextAttempt = (state.attemptIdsByIssueId.get(evt.issueId) ?? []).length + 1;
      const backoffMs = computeBackoffMs(nextAttempt, state.workflow.frontMatter.retry.maxRetryBackoffMs);
      const nextRunAt = new Date(Date.now() + (backoffMs as number)).toISOString() as IsoDateTime;
      if (issue) {
        state.retryByIssueId.set(evt.issueId, {
          issueId: evt.issueId,
          issueKey: issue.key,
          attempt: nextAttempt,
          nextRunAt,
          backoffMs,
          reason: `reviewer failed: ${evt.error.message}`,
        });
        state.issueLifecycleById.set(evt.issueId, { kind: "retry_wait", nextRunAt, attempt: nextAttempt, reason: evt.error.message, backoffMs });
      }
      state.runningIssueIds.delete(evt.issueId);
      break;
    }

    case "manual.retry_issue":
      state.queuedIssueIds.add(evt.issueId);
      state.retryByIssueId.delete(evt.issueId);
      state.issueLifecycleById.set(evt.issueId, { kind: "queued", queuedAt: evt.at, reason: evt.reason });
      break;

    case "manual.stop":
      state.isRunning = false;
      break;
  }

  return { state, commands };
}
```

---

## 6. MCP Tools 定義

```ts
// src/index.ts — 8 個 MCP tools

"symphony.start"         // 啟動 Orchestrator loop
"symphony.stop"          // 停止所有 loop
"symphony.status"        // 輕量狀態快照
"symphony.listIssues"    // 列出 issues + lifecycle
"symphony.reloadWorkflow" // 強制重載 WORKFLOW.md
"symphony.runOnce"       // Debug: 手動觸發一次 scheduler tick
"symphony.retryIssue"    // 手動重試指定 issue
"symphony.inspect"       // Debug: 查詢 issue/session/attempt 細節
```

### Tool params/returns（關鍵）

```ts
// symphony.status
interface StatusResult {
  isRunning: boolean;
  workflow: { path: string; revision: number; loadedAt: IsoDateTime };
  concurrency: { maxConcurrentAgents: number; running: number; queued: number };
  counts: { issues: number; sessions: number; attempts: number; retries: number };
}

// symphony.listIssues
interface ListIssuesParams {
  stateKinds?: IssueLifecycleState["kind"][];
  limit?: number;
}

// symphony.retryIssue
interface RetryIssueParams {
  issueId: IssueId;
  reason: string;
}

// symphony.inspect
interface InspectParams {
  issueId?: IssueId;
  sessionId?: SessionId;
  attemptId?: AttemptId;
}
```

---

## 7. WorkspaceManager

### Workspace 策略（三種）

| 策略 | 使用場景 | 實作 |
|------|---------|------|
| `git_worktree` | 需要隔離 branch（推薦） | `git worktree add <ws> <baseRef>` |
| `git_clone` | 完全隔離副本 | `git clone <repoDir> <ws>` |
| `directory_only` | 非 git 環境 | `mkdir -p <ws>` |

### Hooks（SPEC 對應）

| Hook | 觸發時機 | Timeout |
|------|---------|---------|
| `after_create` | workspace 首次建立後 | 60s |
| `before_run` | Worker turn 開始前 | 60s |
| `after_run` | Worker turn 結束後 | 60s |
| `before_remove` | workspace 清理前 | 60s |

### 安全邊界驗證

```ts
async validatePath(candidate: string, root: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  const realRoot = await realpath(root);
  const realCandidate = await realpath(candidate);
  if (!realCandidate.startsWith(realRoot + path.sep)) {
    throw new Error(`Path traversal detected: ${candidate}`);
  }
  return realCandidate;
}
```

### Identifier Sanitization

```ts
sanitizeIdentifier(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "issue";
}
```

---

## 8. Worker Turn Loop

### 設計原則
- 每 turn 前檢查 Linear issue 是否已 canceled/completed（fail-open：Linear API 失敗時仍繼續）
- Turn 1：完整 Liquid 渲染 prompt
- Turn 2+：只送 continuation guidance（不重送完整 prompt，節省 token）
- 最大 turn 數：20（可設定）

```ts
export type WorkerExitStatus = "completed" | "cancelled" | "failed" | "input_required" | "max_turns";

// WorkerRunner.run() 回傳
export interface WorkerResult {
  status: WorkerExitStatus;
  turns: number;
  lastSessionId?: string;
  workspacePath: string;
  workspaceId: string;
  lastTurnSummary?: string;
  error?: { code: string; message: string; details?: unknown };
}
```

### Session ID 格式
```
<thread_id>-<turn_number>
// e.g. "thread-ENG123-attempt1-3"  (第 3 turn)
```

### OpenCodeAgentClient 介面

```ts
export interface OpenCodeAgentClient {
  runTurn(req: {
    sessionId: string;
    cwd: string;
    role: "worker";
    input: string;
  }): Promise<{
    status: "ok" | "failed" | "input_required" | "cancelled";
    summary: string;
    raw?: unknown;
    inputRequest?: string;
  }>;
  cancelSession?(sessionId: string): Promise<void>;
}
```

> ⚠️ **待解問題**：`OpenCodeAgentClient` 的真實 SDK 呼叫方式需確認 `@opencode-ai/plugin` 的 agent invocation API（目前為 placeholder）

---

## 9. Liquid 渲染設定

### 套件選擇：`liquidjs`

```bash
bun add liquidjs
```

```ts
// src/workflow/LiquidRenderer.ts
import { Liquid } from "liquidjs";

export class LiquidRenderer {
  private readonly engine: Liquid;

  constructor() {
    this.engine = new Liquid({
      strictVariables: true,  // 未知變數立即 throw
      strictFilters: true,    // 未知 filter 立即 throw
    });
  }

  async renderWorkflow(
    workflowMarkdownBody: string,
    vars: { issue: LinearIssue; attempt: number }
  ): Promise<string> {
    // SPEC: 只允許 {issue, attempt} 兩個變數
    return await this.engine.parseAndRender(workflowMarkdownBody, {
      issue: vars.issue,
      attempt: vars.attempt,
    });
  }
}
```

### ⚠️ Liquid strict 注意事項
- `{% if optional_var %}` 若 `optional_var` 未提供會 throw
- 改用 `{% if optional_var != undefined %}`
- Reviewer 回饋**不**塞進 Liquid template，應走 continuation guidance（純文字）

### WORKFLOW.md Hot Reload

```ts
// src/workflow/watcher.ts
import { watch } from "node:fs";

export function watchWorkflow(path: string, onReload: (content: string) => void): () => void {
  const watcher = watch(path, async (event) => {
    if (event === "change") {
      const content = await Bun.file(path).text();
      onReload(content);
    }
  });
  return () => watcher.close();
}
```

- Reload 失敗時保留 last known good config（不中斷 running sessions）
- 新 config 只影響**新 attempt**（running attempt 固定使用其 `workflowRevision`）

---

## 10. Reviewer 決策樹與品質門檻

```
Worker turn_completed
        │
        ▼
┌─────────────────────────┐
│  Deterministic Gates    │
│  (no LLM needed)        │
│  - git diff 是否有變更  │
│  - 無未提交的暫存區衝突 │
│  - test command pass?   │
│  - 無疑似 secrets       │
└─────────────────────────┘
        │
   Gate pass?
   ┌────┴────┐
  No        Yes
   │         │
   │    ┌────▼──────────────────┐
   │    │  Reviewer LLM         │
   │    │  input: diff + logs   │
   │    │  output: JSON         │
   │    │  { decision, title,   │
   │    │    body, requiredFix } │
   │    └────┬──────────────────┘
   │         │
   │    LLM approve?
   │    ┌────┴────┐
   │   No        Yes
   │    │         │
   ▼    ▼         ▼
request_changes  gh pr create
     │           + Linear attachment
     │           + Linear state → "In Review"
     ▼
Linear comment
(具體 requiredChanges)
     │
     ▼
Orchestrator: reviewer.finished (gate: "fail")
     │
     ▼
Worker 下一 turn (continuationGuidance 注入回饋)
```

### Reviewer LLM 輸出 Schema

```ts
interface ReviewerLLMOutput {
  decision: "approve" | "request_changes";
  summary: string;
  prTitle?: string;         // when approve
  prBody?: string;          // when approve (markdown)
  requiredChanges?: string[]; // when request_changes
}
```

---

## 11. Linear GraphQL 操作

### Queries

```graphql
# 取得 active issues
query GetActiveIssues($teamIds: [ID!], $states: [String!]) {
  issues(filter: {
    team: { id: { in: $teamIds } }
    state: { name: { in: $states } }
  }) {
    nodes {
      id
      identifier
      title
      url
      description
      state { id name type }
      priority
      assignee { id name }
      labels { nodes { name } }
      updatedAt
      createdAt
    }
  }
}

# 取得單一 issue
query GetIssue($id: String!) {
  issue(id: $id) {
    id identifier title url state { id name type }
  }
}

# 取得 workflow states（reconciliation 用）
query GetWorkflowStates($teamId: String!) {
  workflowStates(filter: { team: { id: { eq: $teamId } } }) {
    nodes { id name type }
  }
}
```

### Mutations

```graphql
# 更新 issue state
mutation UpdateIssueState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
    issue { id state { id name type } }
  }
}

# 新增 comment
mutation AddComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id url body }
  }
}

# 掛載 PR 連結
mutation LinkPRAttachment($issueId: String!, $title: String!, $url: String!) {
  attachmentCreate(input: { issueId: $issueId, title: $title, url: $url }) {
    success
    attachment { id url title }
  }
}
```

### ⚠️ Linear API 注意事項
- `project(id: "slug")` 可接受 URL slug
- **mutations 必須使用 UUID**（`issueUpdate(id: "UUID")`）
- State type 值：`"triage"` | `"backlog"` | `"started"` | `"completed"` | `"canceled"`

---

## 12. 跨模組訊息型別

```ts
// src/messages.ts

export type SymphonyMsg =
  | WorkerStartMsg
  | WorkerDoneMsg
  | ReviewerRequestMsg
  | ReviewerResultMsg;

export interface WorkerStartMsg {
  type: "worker_start";
  threadId: string;
  attempt: number;
  issue: LinearIssue;
  workflowMarkdown: string;
  continuationGuidance?: string; // reviewer feedback for turn > 1
  workerConfig?: {
    maxTurns?: number;
    pollLinearEachTurn?: boolean;
  };
}

export interface WorkerDoneMsg {
  type: "worker_done";
  threadId: string;
  attempt: number;
  issueId: string;
  workspaceId: string;
  workspacePath: string;
  status: "completed" | "cancelled" | "failed" | "input_required" | "max_turns";
  turns: number;
  lastSessionId?: string;
  lastTurnSummary?: string;
  error?: { code: string; message: string; details?: unknown };
}

export interface ReviewerRequestMsg {
  type: "reviewer_request";
  threadId: string;
  attempt: number;
  issue: LinearIssue;
  workspacePath: string;
  workspaceId: string;
  workerSummary?: string;
}

export type ReviewerDecision = "approve" | "request_changes";

export interface ReviewerResultMsg {
  type: "reviewer_result";
  threadId: string;
  attempt: number;
  issueId: string;
  workspaceId: string;
  decision: ReviewerDecision;
  gates: Array<{ name: string; passed: boolean; details?: string }>;
  pr?: { url: string; title: string; body: string; number?: number };
  feedback?: string;  // fed into next worker continuationGuidance
  error?: { code: string; message: string; details?: unknown };
}
```

---

## 13. WORKFLOW.md 格式

```markdown
---
linear:
  pollIntervalMs: 30000
  teamIds:
    - "YOUR_TEAM_ID"
  states:
    - "In Progress"

workspace:
  root: /tmp/symphony-workspaces
  maxConcurrentAgents: 5

retry:
  maxAttempts: 3
  maxRetryBackoffMs: 300000

timeouts:
  workerRunTimeoutMs: 1800000  # 30 min
  reviewerRunTimeoutMs: 600000  # 10 min
  sessionIdleTimeoutMs: 120000  # 2 min

appServer:
  command: opencode
  args: []
---

You are a skilled software engineer. Your task is to resolve the following Linear issue.

## Issue: {{ issue.identifier }} — {{ issue.title }}

**URL:** {{ issue.url }}

**Description:**
{{ issue.description }}

**This is attempt #{{ attempt }}.**

## Instructions

1. Explore the codebase to understand the context
2. Implement a solution that addresses the issue description
3. Write or update tests as appropriate
4. Ensure all existing tests still pass
5. Leave the code in a clean, reviewable state

Do not ask for clarification. Make your best judgment and proceed.
```

---

## 14. 錯誤處理策略

| 模組 | 錯誤碼 | 可重試？ | 處理方式 |
|------|--------|---------|---------|
| WorkspaceManager | `HOOK_TIMEOUT` | 視情況 | 預設不可重試；附 stderr |
| WorkspaceManager | `HOOK_FAILED` | 視情況 | 回 Linear comment 含 stderr |
| WorkspaceManager | `WORKSPACE_CREATE_FAILED` | 可重試 1 次 | 設定錯誤則 fatal |
| LiquidRenderer | `WORKFLOW_TEMPLATE_ERROR` | **Fatal** | 立刻 comment 回 Linear 指出 template typo |
| WorkerRunner | `AGENT_TURN_FAILED` | 可重試（backoff） | 連續 N 次相同錯誤則 needs human |
| WorkerRunner | `LINEAR_UNAVAILABLE` | fail-open | 不阻塞 turn，下一 turn 再查 |
| ReviewerWorkflow | gate fail | 不丟 exception | 回 `request_changes` + feedback |
| ReviewerWorkflow | `REVIEWER_OUTPUT_INVALID` | 可重試 1 次 | 再失敗退回 deterministic gates |
| ReviewerWorkflow | `PR_CREATE_FAILED` | 不可重試 | 回 request_changes，提示 `gh auth login` |
| LinearClient | HTTP 5xx / rate limit | 可重試（backoff） | 指數退避 |
| LinearClient | 權限/變數錯誤 | **Fatal** | 立刻停止並報告 |
| LinearClient | `LINEAR_BAD_STATE` | **Fatal** | 需要修正 stateId 設定 |

---

## 15. 關鍵技術決策

| 決策 | 選擇 | 理由 |
|------|------|------|
| State machine 風格 | Pure reducer + command list | 可測試、可重播、無 race condition |
| Workspace 隔離 | 每 issue 一個目錄 | 符合 SPEC；防止交叉污染 |
| Liquid engine | `liquidjs` | 支援 `strictVariables`；Bun 相容 |
| File watching | `node:fs` `watch()` | Bun 1.1+ 原生支援；不需 chokidar |
| PR 建立 | `gh` CLI 優先 | 最簡單；auth 由系統管理 |
| Linear 通訊 | 直接 GraphQL fetch | 輕量；不依賴 `@linear/sdk` |
| 並行控制 | `runningIssueIds` Set + maxConcurrentAgents | 符合 SPEC Section 4.1.8 |
| Hot reload 競態 | running attempt 固定 workflowRevision | 避免 prompt 半路變更 |
| 重試去重 | `retryByIssueId` Map | per-issue 唯一 retry entry |

---

## 16. 實作優先順序

| 優先 | 估時 | 模組 | 說明 |
|------|------|------|------|
| **P1** | 0.5d | workflow/ + linear/client + linear/queries | WORKFLOW.md loader + Liquid renderer + Linear poller |
| **P2** | 0.5d | workspace/ | WorkspaceManager + hooks executor + 安全邊界 |
| **P3** | 1d | orchestrator/ | 完整 state machine + scheduler + MCP tools |
| **P4** | 1d | worker/ | WorkerRunner turn loop + OpenCodeAgentClient |
| **P5** | 1d | reviewer/ | ReviewerWorkflow + quality gates + PR creation |
| **P6** | 0.5d | linear/mutations + integration test | Linear mutations + 端到端驗證 |

**總估時：~4.5 天**

---

## 17. 待解問題

1. **OpenCodeAgentClient 實作**：`@opencode-ai/plugin` SDK 的 agent invocation 實際 API（`ctx.client` 或其他方式）需要確認，目前 `WorkerRunner` 使用 placeholder interface。

2. **Reviewer LLM 呼叫**：Reviewer role 如何在 plugin 內呼叫另一個 OpenCode agent session（避免自我遞迴）？

3. **Linear stateId mapping**：WORKFLOW.md 中如何設定「要轉移到哪個 stateId」？目前設計假設 reviewer 可查詢到 state list 並自動 match by name。

4. **Branch/commit 策略**：Worker 是否需要自動建立 feature branch？（預設假設 `git_worktree` 已在隔離 branch 上，但需驗證）

5. **auth 設定**：Linear API key 和 GitHub token 的注入方式（env vars？WORKFLOW.md front matter？）

---

*設計版本 v1.0 — 由 Oracle + Librarian agent 協作完成 | 2026-03-06*
