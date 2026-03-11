// tests/integration/sessionid-lifecycle.test.ts
//
// Verifies that sessionId is consistently stored in both:
//   - state.sessionIdByIssueId (the canonical store)
//   - the lifecycle state (running → awaiting_review → succeeded)
//
// Also verifies that a worker with status="max_turns" transitions to
// awaiting_review (not worker.failed), mirroring the "completed" path.
//
// Covers the bug fixed in AUG-9: sessionId in lifecycle must match
// sessionIdByIssueId after worker.finished.

import { describe, it, expect, mock } from "bun:test";
import { applyEvent } from "../../src/orchestrator/state.js";
import { executeCommands } from "../../src/orchestrator/commands.js";
import type { CommandDeps } from "../../src/orchestrator/commands.js";
import type {
  OrchestratorState,
  IssueId,
  IssueKey,
  IsoDateTime,
  Millis,
  SessionId,
  WorkflowDefinition,
  LinearIssue,
  ReviewResult,
} from "../../src/orchestrator/types.js";
import type { WorkerRunnerOptions, WorkerRunner, WorkerExitStatus } from "../../src/worker/WorkerRunner.js";
import type { ReviewerWorkflowOptions } from "../../src/reviewer/ReviewerWorkflow.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const NOW = "2026-01-01T00:00:00.000Z" as IsoDateTime;
const MOCK_SESSION_ID = "thread-TEAM-1-attempt1-1";

function makeWorkflow(): WorkflowDefinition {
  return {
    path: "/WORKFLOW.md",
    revision: 1,
    loadedAt: NOW,
    frontMatter: {
      linear: { pollIntervalMs: 30_000 },
      workspace: {
        root: "/tmp/symphony-test" as import("../../src/orchestrator/types.js").WorkspaceRoot,
        maxConcurrentAgents: 5,
      },
      retry: { maxAttempts: 3, maxRetryBackoffMs: 300_000 as Millis },
      timeouts: {
        workerRunTimeoutMs: 60_000 as Millis,
        reviewerRunTimeoutMs: 30_000 as Millis,
        sessionIdleTimeoutMs: 60_000 as Millis,
      },
      appServer: { command: "opencode" },
    },
    liquidTemplate: "You are a worker. Issue: {{ issue.title }}",
  };
}

function makeIssue(id = "issue-1"): LinearIssue {
  return {
    id: id as IssueId,
    key: "TEAM-1" as IssueKey,
    title: "Fix the bug",
    url: "https://linear.app/test/issue/TEAM-1",
    state: { id: "state-started", name: "In Progress", type: "started" },
    labels: [],
    updatedAt: NOW,
    createdAt: NOW,
    assignee: null,
  };
}

function makeInitialState(workflow = makeWorkflow()): OrchestratorState {
  return {
    workflow,
    issuesById: new Map(),
    issueLifecycleById: new Map(),
    maxConcurrentAgents: 5,
    runningIssueIds: new Set(),
    queuedIssueIds: new Set(),
    retryByIssueId: new Map(),
    sessionsById: new Map(),
    sessionIdByIssueId: new Map(),
    attemptsById: new Map(),
    attemptIdsByIssueId: new Map(),
    inflightRpc: new Map(),
    startedAt: NOW,
    isRunning: true,
  };
}

function makeMockDeps(
  stateRef: { value: OrchestratorState },
  workerFactory: (opts: WorkerRunnerOptions) => WorkerRunner,
): CommandDeps {
  const mockLinear = {
    getActiveIssues: mock(async () => []),
    updateIssueState: mock(async () => {}),
    addComment: mock(async () => {}),
    linkPRAttachment: mock(async () => {}),
  } as unknown as import("../../src/linear/client.js").LinearClient;

  const mockWorkspaceManager = {
    ensureWorkspace: mock(async () => ({
      identifier: "team-1",
      absPath: "/tmp/symphony-test/team-1",
      created: true,
    })),
    prepareRun: mock(async () => {}),
    finalizeRun: mock(async () => {}),
    cleanupWorkspace: mock(async () => {}),
  } as unknown as import("../../src/workspace/WorkspaceManager.js").WorkspaceManager;

  const mockLiquidRenderer = {
    renderWorkflow: mock(async () => "Rendered workflow"),
  } as unknown as import("../../src/workflow/LiquidRenderer.js").LiquidRenderer;

  const mockAgentClient = {
    runTurn: mock(async () => ({ status: "ok" as const, summary: "mock" })),
  } as unknown as import("../../src/worker/OpenCodeAgentClient.js").OpenCodeAgentClient;

  const deps: CommandDeps = {
    getState: () => stateRef.value,
    emitEvent: (evt) => {
      const result = applyEvent(stateRef.value, evt);
      stateRef.value = result.state;
      void executeCommands(result.commands, deps);
    },
    linear: mockLinear,
    workspaceManager: mockWorkspaceManager,
    agentClient: mockAgentClient,
    liquidRenderer: mockLiquidRenderer,
    createWorkerRunner: workerFactory,
    createReviewerWorkflow: (_opts: ReviewerWorkflowOptions) =>
      ({
        async run(): Promise<ReviewResult> {
          return { gate: "pass", summary: "LGTM" };
        },
      }) as import("../../src/reviewer/ReviewerWorkflow.js").ReviewerWorkflow,
  };

  return deps;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sessionId lifecycle consistency", () => {
  it("completed path: sessionId in succeeded lifecycle matches sessionIdByIssueId", async () => {
    const issue = makeIssue();
    const ISSUE_ID = "issue-1" as IssueId;
    const stateRef = { value: makeInitialState() };

    ({ value: stateRef.value } = { value: applyEvent(stateRef.value, { type: "linear.polled", issues: [issue], polledAt: NOW }).state });
    const { state: s2, commands: cmds2 } = applyEvent(stateRef.value, { type: "scheduler.tick", now: NOW });
    stateRef.value = s2;

    const deps = makeMockDeps(stateRef, (_opts) => ({
      async run(): Promise<WorkerExitStatus> {
        return {
          status: "completed",
          turns: 1,
          lastSessionId: MOCK_SESSION_ID,
          workspacePath: "/tmp/symphony-test/team-1",
          workspaceId: "team-1",
          lastTurnSummary: "Fixed it. DONE.",
        };
      },
      cancel: mock(() => Promise.resolve()),
    }));

    await executeCommands(cmds2, deps);
    await new Promise((r) => setTimeout(r, 100));

    const lc = stateRef.value.issueLifecycleById.get(ISSUE_ID);
    expect(lc?.kind).toBe("succeeded");

    const storedSessionId = stateRef.value.sessionIdByIssueId.get(ISSUE_ID);
    expect(storedSessionId).toBe(MOCK_SESSION_ID as SessionId);

    if (lc?.kind === "succeeded") {
      expect(lc.sessionId).toBe(storedSessionId);
    }
  });

  it("max_turns path: transitions to succeeded (not failed), sessionId stored correctly", async () => {
    const issue = makeIssue();
    const ISSUE_ID = "issue-1" as IssueId;
    const stateRef = { value: makeInitialState() };

    ({ value: stateRef.value } = { value: applyEvent(stateRef.value, { type: "linear.polled", issues: [issue], polledAt: NOW }).state });
    const { state: s2, commands: cmds2 } = applyEvent(stateRef.value, { type: "scheduler.tick", now: NOW });
    stateRef.value = s2;

    const deps = makeMockDeps(stateRef, (_opts) => ({
      async run(): Promise<WorkerExitStatus> {
        return {
          status: "max_turns",
          turns: 20,
          lastSessionId: MOCK_SESSION_ID,
          workspacePath: "/tmp/symphony-test/team-1",
          workspaceId: "team-1",
          lastTurnSummary: "Ran out of turns.",
        };
      },
      cancel: mock(() => Promise.resolve()),
    }));

    await executeCommands(cmds2, deps);
    await new Promise((r) => setTimeout(r, 100));

    const lc = stateRef.value.issueLifecycleById.get(ISSUE_ID);
    expect(lc?.kind).toBe("succeeded");

    const storedSessionId = stateRef.value.sessionIdByIssueId.get(ISSUE_ID);
    expect(storedSessionId).toBe(MOCK_SESSION_ID as SessionId);

    if (lc?.kind === "succeeded") {
      expect(lc.sessionId).toBe(storedSessionId);
    }
  });

  it("max_turns without lastSessionId: still reaches succeeded with empty sessionId", async () => {
    const issue = makeIssue();
    const ISSUE_ID = "issue-1" as IssueId;
    const stateRef = { value: makeInitialState() };

    ({ value: stateRef.value } = { value: applyEvent(stateRef.value, { type: "linear.polled", issues: [issue], polledAt: NOW }).state });
    const { state: s2, commands: cmds2 } = applyEvent(stateRef.value, { type: "scheduler.tick", now: NOW });
    stateRef.value = s2;

    const deps = makeMockDeps(stateRef, (_opts) => ({
      async run(): Promise<WorkerExitStatus> {
        return {
          status: "max_turns",
          turns: 20,
          workspacePath: "/tmp/symphony-test/team-1",
          workspaceId: "team-1",
          lastTurnSummary: "Ran out of turns.",
        };
      },
      cancel: mock(() => Promise.resolve()),
    }));

    await executeCommands(cmds2, deps);
    await new Promise((r) => setTimeout(r, 100));

    const lc = stateRef.value.issueLifecycleById.get(ISSUE_ID);
    expect(lc?.kind).toBe("succeeded");
    expect(stateRef.value.runningIssueIds.has(ISSUE_ID)).toBe(false);
  });

  it("sessionId in state.ts worker.finished handler: lifecycle sessionId propagates from running to awaiting_review", () => {
    const workflow = makeWorkflow();
    const state = makeInitialState(workflow);
    const ISSUE_ID = "issue-1" as IssueId;
    const SESSION_ID = "ses-abc" as SessionId;

    state.runningIssueIds.add(ISSUE_ID);
    state.issueLifecycleById.set(ISSUE_ID, {
      kind: "running",
      sessionId: SESSION_ID,
      attempt: 1,
      startedAt: NOW,
    });

    const { state: s } = applyEvent(state, {
      type: "worker.finished",
      issueId: ISSUE_ID,
      attemptId: "attempt-1" as import("../../src/orchestrator/types.js").AttemptId,
      result: { summary: "Done" },
      at: NOW,
    });

    const lc = s.issueLifecycleById.get(ISSUE_ID);
    expect(lc?.kind).toBe("awaiting_review");
    if (lc?.kind === "awaiting_review") {
      expect(lc.sessionId).toBe(SESSION_ID);
    }
  });
});
