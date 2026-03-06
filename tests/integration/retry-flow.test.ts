// tests/integration/retry-flow.test.ts
//
// Retry with exponential backoff:
//   Attempt 1 → worker fails → retry_wait (backoff=10000)
//   Attempt 2 → worker fails → retry_wait (backoff=20000)
//   Attempt 3 → worker succeeds → Reviewer approves → succeeded
//
// Verifies exact backoff formula: min(10000 * 2^(attempt-1), maxRetryBackoffMs)

import { describe, it, expect, mock } from "bun:test";
import { applyEvent, computeBackoffMs } from "../../src/orchestrator/state.js";
import { executeCommands } from "../../src/orchestrator/commands.js";
import type { CommandDeps } from "../../src/orchestrator/commands.js";
import type {
  OrchestratorState,
  IssueId,
  IssueKey,
  IsoDateTime,
  Millis,
  WorkflowDefinition,
  LinearIssue,
  ReviewResult,
  AttemptId,
} from "../../src/orchestrator/types.js";
import type { WorkerRunnerOptions, WorkerRunner, WorkerExitStatus } from "../../src/worker/WorkerRunner.js";
import type { ReviewerWorkflowOptions } from "../../src/reviewer/ReviewerWorkflow.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const NOW = "2026-01-01T00:00:00.000Z" as IsoDateTime;

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

function makeIssue(): LinearIssue {
  return {
    id: "issue-retry" as IssueId,
    key: "TEAM-R1" as IssueKey,
    title: "Retry Test Issue",
    url: "https://linear.app/test/issue/TEAM-R1",
    state: { id: "state-started", name: "In Progress", type: "started" },
    labels: [],
    updatedAt: NOW,
    createdAt: NOW,
    assignee: null,
  };
}

function makeInitialState(): OrchestratorState {
  const workflow = makeWorkflow();
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("retry-flow integration", () => {
  it("backoff formula: attempt 1 → 10000, attempt 2 → 20000, attempt 3 → 40000", () => {
    const maxMs = 300_000 as Millis;
    expect(computeBackoffMs(1, maxMs)).toBe(10_000);
    expect(computeBackoffMs(2, maxMs)).toBe(20_000);
    expect(computeBackoffMs(3, maxMs)).toBe(40_000);
    // Cap check
    expect(computeBackoffMs(6, maxMs)).toBe(300_000);
  });

  it("worker fails twice, succeeds on attempt 3 → succeeded", async () => {
    const issue = makeIssue();
    const ISSUE_ID = "issue-retry" as IssueId;
    let state = makeInitialState();

    // Step 1: Poll issues
    ({ state } = applyEvent(state, {
      type: "linear.polled",
      issues: [issue],
      polledAt: NOW,
    }));

    // Step 2: Tick → dispatch worker
    const { state: s2, commands: cmds2 } = applyEvent(state, {
      type: "scheduler.tick",
      now: NOW,
    });
    state = s2;
    expect(cmds2.some((c) => c.type === "spawn_and_run_worker")).toBe(true);

    let workerCallCount = 0;

    const mockLinear = {
      getActiveIssues: mock(async () => [issue]),
      updateIssueState: mock(async () => {}),
      addComment: mock(async () => {}),
      linkPRAttachment: mock(async () => {}),
    } as unknown as import("../../src/linear/client.js").LinearClient;

    const mockWorkspaceManager = {
      ensureWorkspace: mock(async () => ({
        identifier: "team-r1",
        absPath: "/tmp/symphony-test/team-r1",
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
      getState: () => state,
      emitEvent: (evt) => {
        const result = applyEvent(state, evt);
        state = result.state;
        void executeCommands(result.commands, deps);
      },
      linear: mockLinear,
      workspaceManager: mockWorkspaceManager,
      agentClient: mockAgentClient,
      liquidRenderer: mockLiquidRenderer,
      createWorkerRunner: (_opts: WorkerRunnerOptions): WorkerRunner => {
        workerCallCount++;
        const call = workerCallCount;
        return {
          async run(): Promise<WorkerExitStatus> {
            if (call <= 2) {
              // attempts 1 and 2 fail
              return { status: "failed", error: { code: "MockError", message: `attempt ${call} failed` } };
            }
            // attempt 3 succeeds
            return { status: "completed", lastTurnSummary: "Finally fixed. DONE.", turns: 1 };
          },
          cancel: mock(() => Promise.resolve()),
        };
      },
      createReviewerWorkflow: (_opts: ReviewerWorkflowOptions) =>
        ({
          async run(): Promise<ReviewResult> {
            return { gate: "pass", summary: "LGTM" };
          },
        }) as import("../../src/reviewer/ReviewerWorkflow.js").ReviewerWorkflow,
    };

    // ── Attempt 1: worker fails → retry_wait with backoff=10000 ───────────────
    await executeCommands(cmds2, deps);
    await new Promise((r) => setTimeout(r, 50));

    {
      const lc = state.issueLifecycleById.get(ISSUE_ID);
      expect(lc?.kind).toBe("retry_wait");
      if (lc?.kind === "retry_wait") {
        expect(lc.backoffMs).toBe(10_000);
        expect(lc.attempt).toBe(1);
      }
    }

    // ── Advance time past backoff → scheduler tick promotes retry ────────────
    const futureNow = new Date(Date.now() + 15_000).toISOString() as IsoDateTime;
    const { state: s3, commands: cmds3 } = applyEvent(state, {
      type: "scheduler.tick",
      now: futureNow,
    });
    state = s3;
    expect(cmds3.some((c) => c.type === "spawn_and_run_worker")).toBe(true);

    // ── Attempt 2: worker fails → retry_wait with backoff=20000 ───────────────
    await executeCommands(cmds3, deps);
    await new Promise((r) => setTimeout(r, 50));

    {
      const lc = state.issueLifecycleById.get(ISSUE_ID);
      expect(lc?.kind).toBe("retry_wait");
      if (lc?.kind === "retry_wait") {
        expect(lc.backoffMs).toBe(20_000);
        expect(lc.attempt).toBe(2);
      }
    }

    // ── Advance time past second backoff ──────────────────────────────────────
    const futureNow2 = new Date(Date.now() + 30_000).toISOString() as IsoDateTime;
    const { state: s4, commands: cmds4 } = applyEvent(state, {
      type: "scheduler.tick",
      now: futureNow2,
    });
    state = s4;
    expect(cmds4.some((c) => c.type === "spawn_and_run_worker")).toBe(true);

    // ── Attempt 3: worker succeeds → Reviewer approves → succeeded ────────────
    await executeCommands(cmds4, deps);
    await new Promise((r) => setTimeout(r, 50));

    const lc = state.issueLifecycleById.get(ISSUE_ID);
    expect(lc?.kind).toBe("succeeded");
    expect(state.runningIssueIds.has(ISSUE_ID)).toBe(false);

    // Worker was called exactly 3 times
    expect(workerCallCount).toBe(3);
  });
});
