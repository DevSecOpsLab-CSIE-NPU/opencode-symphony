import { describe, it, expect } from "bun:test";
import { applyEvent, computeBackoffMs, type OrchestratorCommand } from "../src/orchestrator/state.js";
import type {
  OrchestratorState,
  OrchestratorEvent,
  IssueId,
  IssueKey,
  AttemptId,
  SessionId,
  IsoDateTime,
  Millis,
  WorkflowDefinition,
  LinearIssue,
} from "../src/orchestrator/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeWorkflow(overrides?: { maxAttempts?: number; maxRetryBackoffMs?: number }): WorkflowDefinition {
  return {
    path: "/WORKFLOW.md",
    revision: 1,
    loadedAt: "2026-01-01T00:00:00.000Z" as IsoDateTime,
    frontMatter: {
      linear: { pollIntervalMs: 30000 },
      workspace: { root: "/workspaces" as import("../src/orchestrator/types.js").WorkspaceRoot, maxConcurrentAgents: 10 },
      retry: {
        maxAttempts: overrides?.maxAttempts ?? 3,
        maxRetryBackoffMs: (overrides?.maxRetryBackoffMs ?? 300_000) as Millis,
      },
      timeouts: {
        workerRunTimeoutMs: 600_000 as Millis,
        reviewerRunTimeoutMs: 120_000 as Millis,
        sessionIdleTimeoutMs: 1800_000 as Millis,
      },
      appServer: { command: "opencode" },
    },
    liquidTemplate: "",
  };
}

function makeIssue(id = "issue-1"): LinearIssue {
  return {
    id: id as IssueId,
    key: `TEAM-${id}` as IssueKey,
    title: "Test Issue",
    url: "https://linear.app/test",
    state: { id: "state-1", name: "In Progress", type: "started" },
    labels: [],
    updatedAt: "2026-01-01T00:00:00.000Z" as IsoDateTime,
    createdAt: "2026-01-01T00:00:00.000Z" as IsoDateTime,
    assignee: null,
  };
}

function makeState(overrides?: {
  maxAttempts?: number;
  maxRetryBackoffMs?: number;
}): OrchestratorState {
  const workflow = makeWorkflow(overrides);
  return {
    workflow,
    issuesById: new Map(),
    issueLifecycleById: new Map(),
    maxConcurrentAgents: 10,
    runningIssueIds: new Set(),
    queuedIssueIds: new Set(),
    retryByIssueId: new Map(),
    sessionsById: new Map(),
    sessionIdByIssueId: new Map(),
    attemptsById: new Map(),
    attemptIdsByIssueId: new Map(),
    inflightRpc: new Map(),
    startedAt: "2026-01-01T00:00:00.000Z" as IsoDateTime,
    isRunning: true,
  };
}

const NOW = "2026-01-01T00:00:00.000Z" as IsoDateTime;
const ISSUE_ID = "issue-1" as IssueId;
const ATTEMPT_ID = "attempt-1" as AttemptId;

// ── computeBackoffMs ───────────────────────────────────────────────────────

describe("computeBackoffMs", () => {
  it("attempt 1 → 10000 (base delay)", () => {
    expect(computeBackoffMs(1, 300_000 as Millis)).toBe(10_000);
  });

  it("attempt 2 → 20000", () => {
    expect(computeBackoffMs(2, 300_000 as Millis)).toBe(20_000);
  });

  it("attempt 6 → 300000 (capped at maxMs)", () => {
    // Math.min(10000 * 2^5, 300000) = Math.min(320000, 300000) = 300000
    expect(computeBackoffMs(6, 300_000 as Millis)).toBe(300_000);
  });
});

// ── Normal flow ────────────────────────────────────────────────────────────

describe("applyEvent — normal flow", () => {
  it("linear.polled adds issue and enqueues started issues", () => {
    const state = makeState();
    const issue = makeIssue();
    const { state: s } = applyEvent(state, {
      type: "linear.polled",
      issues: [issue],
      polledAt: NOW,
    });
    expect(s.issuesById.has(ISSUE_ID)).toBe(true);
    expect(s.queuedIssueIds.has(ISSUE_ID)).toBe(true);
  });

  it("issue.start_work transitions to running", () => {
    const state = makeState();
    state.queuedIssueIds.add(ISSUE_ID);
    const { state: s } = applyEvent(state, {
      type: "issue.start_work",
      issueId: ISSUE_ID,
      at: NOW,
    });
    expect(s.runningIssueIds.has(ISSUE_ID)).toBe(true);
    expect(s.queuedIssueIds.has(ISSUE_ID)).toBe(false);
    const lc = s.issueLifecycleById.get(ISSUE_ID);
    expect(lc?.kind).toBe("running");
  });

  it("worker.finished transitions to awaiting_review and spawns reviewer", () => {
    const state = makeState();
    state.runningIssueIds.add(ISSUE_ID);
    state.issueLifecycleById.set(ISSUE_ID, {
      kind: "running",
      sessionId: "ses-1" as SessionId,
      attempt: 1,
      startedAt: NOW,
    });

    const { state: s, commands } = applyEvent(state, {
      type: "worker.finished",
      issueId: ISSUE_ID,
      attemptId: ATTEMPT_ID,
      result: { summary: "Done" },
      at: NOW,
    });

    const lc = s.issueLifecycleById.get(ISSUE_ID);
    expect(lc?.kind).toBe("awaiting_review");
    expect(commands.some((c) => c.type === "spawn_and_run_reviewer")).toBe(true);
  });

  it("reviewer.finished(pass) transitions to succeeded and closes session", () => {
    const state = makeState();
    const sid = "ses-1" as SessionId;
    state.runningIssueIds.add(ISSUE_ID);
    state.sessionIdByIssueId.set(ISSUE_ID, sid);
    state.issueLifecycleById.set(ISSUE_ID, {
      kind: "awaiting_review",
      sessionId: sid,
      attempt: 1,
      workerAttemptId: ATTEMPT_ID,
      startedAt: NOW,
    });

    const { state: s, commands } = applyEvent(state, {
      type: "reviewer.finished",
      issueId: ISSUE_ID,
      attemptId: "review-1" as AttemptId,
      result: { gate: "pass", summary: "LGTM" },
      at: NOW,
    });

    const lc = s.issueLifecycleById.get(ISSUE_ID);
    expect(lc?.kind).toBe("succeeded");
    expect(s.runningIssueIds.has(ISSUE_ID)).toBe(false);
    const closeCmd = commands.find((c) => c.type === "close_session") as
      | Extract<OrchestratorCommand, { type: "close_session" }>
      | undefined;
    expect(closeCmd?.sessionId).toBe(sid);
  });

  it("manual.stop sets isRunning to false", () => {
    const state = makeState();
    const { state: s } = applyEvent(state, { type: "manual.stop", at: NOW });
    expect(s.isRunning).toBe(false);
  });
});

// ── Retry backoff ──────────────────────────────────────────────────────────

describe("applyEvent — retry backoff", () => {
  function stateWithIssue(maxAttempts = 3) {
    const state = makeState({ maxAttempts });
    const issue = makeIssue();
    state.issuesById.set(ISSUE_ID, issue);
    state.runningIssueIds.add(ISSUE_ID);
    state.issueLifecycleById.set(ISSUE_ID, {
      kind: "running",
      sessionId: "ses-1" as SessionId,
      attempt: 1,
      startedAt: NOW,
    });
    return state;
  }

  it("worker.failed with attempts < max → retry_wait with correct backoff", () => {
    const state = stateWithIssue(3);
    // 0 previous attempts in attemptIdsByIssueId
    const { state: s } = applyEvent(state, {
      type: "worker.failed",
      issueId: ISSUE_ID,
      attemptId: ATTEMPT_ID,
      error: { name: "Error", message: "oops" },
      at: NOW,
    });

    const lc = s.issueLifecycleById.get(ISSUE_ID);
    expect(lc?.kind).toBe("retry_wait");
    if (lc?.kind === "retry_wait") {
      // attempt 0 previous → nextAttempt=1 → backoff=10000
      expect(lc.backoffMs).toBe(10_000);
    }
    expect(s.runningIssueIds.has(ISSUE_ID)).toBe(false);
  });

  it("worker.failed with attempts = max → failed (no retry)", () => {
    const state = stateWithIssue(1);
    // Simulate 1 previous attempt already recorded
    state.attemptIdsByIssueId.set(ISSUE_ID, [ATTEMPT_ID]);

    const { state: s } = applyEvent(state, {
      type: "worker.failed",
      issueId: ISSUE_ID,
      attemptId: ATTEMPT_ID,
      error: { name: "Error", message: "oops" },
      at: NOW,
    });

    const lc = s.issueLifecycleById.get(ISSUE_ID);
    expect(lc?.kind).toBe("failed");
  });
});

// ── Idempotent double-dispatch ─────────────────────────────────────────────

describe("applyEvent — idempotent double-dispatch", () => {
  it("duplicate worker.finished event returns empty commands (ignored)", () => {
    const state = makeState();
    state.runningIssueIds.add(ISSUE_ID);
    state.issueLifecycleById.set(ISSUE_ID, {
      kind: "running",
      sessionId: "ses-1" as SessionId,
      attempt: 1,
      startedAt: NOW,
    });

    const evt: OrchestratorEvent = {
      type: "worker.finished",
      issueId: ISSUE_ID,
      attemptId: ATTEMPT_ID,
      result: { summary: "Done" },
      at: NOW,
    };

    // First dispatch
    const { state: s1 } = applyEvent(state, evt);
    // Second dispatch — lifecycle is now awaiting_review, not running
    const { commands: cmds2 } = applyEvent(s1, evt);

    // Should not spawn another reviewer
    expect(cmds2.filter((c) => c.type === "spawn_and_run_reviewer").length).toBe(0);
  });
});

// ── Reviewer gate=fail re-enqueue ─────────────────────────────────────────

describe("applyEvent — reviewer gate=fail re-enqueue", () => {
  it("reviewer.finished(fail) transitions to needs_changes and re-enqueues", () => {
    const state = makeState();
    const sid = "ses-1" as SessionId;
    state.runningIssueIds.add(ISSUE_ID);
    state.sessionIdByIssueId.set(ISSUE_ID, sid);
    state.issueLifecycleById.set(ISSUE_ID, {
      kind: "awaiting_review",
      sessionId: sid,
      attempt: 1,
      workerAttemptId: ATTEMPT_ID,
      startedAt: NOW,
    });

    const { state: s } = applyEvent(state, {
      type: "reviewer.finished",
      issueId: ISSUE_ID,
      attemptId: "review-1" as AttemptId,
      result: { gate: "fail", summary: "Needs changes" },
      at: NOW,
    });

    const lc = s.issueLifecycleById.get(ISSUE_ID);
    expect(lc?.kind).toBe("needs_changes");
    expect(s.queuedIssueIds.has(ISSUE_ID)).toBe(true);
    expect(s.runningIssueIds.has(ISSUE_ID)).toBe(false);
  });
});
