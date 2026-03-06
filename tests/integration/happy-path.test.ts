// tests/integration/happy-path.test.ts
//
// Complete happy path:
//   Linear poll → Scheduler tick → Worker (2 turns, completed) →
//   Reviewer (gate pass, LLM approve) → succeeded lifecycle
//
// All external I/O is mocked:
//   - LinearClient.getActiveIssues  — returns 1 "started" issue
//   - LinearClient mutations        — tracked for assertion
//   - WorkspaceManager.ensureWorkspace — returns fake workspace
//   - OpenCodeAgentClient.runTurn   — controlled turn-by-turn
//   - ReviewerWorkflow               — injected via createReviewerWorkflow

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
  SessionId,
  WorkflowDefinition,
  LinearIssue,
  ReviewResult,
  WorkResult,
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
    id: "issue-1" as IssueId,
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("happy-path integration", () => {
  it("Linear poll → Worker 2 turns completed → Reviewer approve → succeeded", async () => {
    const start = Date.now();
    const issue = makeIssue();
    const workflow = makeWorkflow();
    let state = makeInitialState(workflow);

    // ── Step 1: Simulate linear.polled ────────────────────────────────────────
    ({ state } = applyEvent(state, {
      type: "linear.polled",
      issues: [issue],
      polledAt: NOW,
    }));

    expect(state.issuesById.has("issue-1" as IssueId)).toBe(true);
    expect(state.queuedIssueIds.has("issue-1" as IssueId)).toBe(true);

    // ── Step 2: Scheduler tick dispatches the issue ───────────────────────────
    const tickResult = applyEvent(state, { type: "scheduler.tick", now: NOW });
    state = tickResult.state;
    const tickCommands = tickResult.commands;

    expect(tickCommands.some((c) => c.type === "spawn_and_run_worker")).toBe(true);

    // ── Step 3: Execute spawn_and_run_worker with mock WorkerRunner ───────────
    // Mock: WorkerRunner completes after 2 turns
    const turnLog: string[] = [];

    const mockWorkerRunner: WorkerRunner = {
      async run(): Promise<WorkerExitStatus> {
        turnLog.push("turn-1");
        turnLog.push("turn-2");
        return { status: "completed", lastTurnSummary: "Implemented the fix. DONE.", turns: 2 };
      },
      cancel: mock(() => Promise.resolve()),
    };

    // Mock: ReviewerWorkflow approves
    const approveResult: ReviewResult = {
      gate: "pass",
      summary: "LGTM — all gates passed, LLM approves.",
      prDraft: {
        title: "Fix the bug (TEAM-1)",
        body: "Resolves TEAM-1.",
      },
    };

    const mockReviewerWorkflow = {
      async run(): Promise<ReviewResult> {
        return approveResult;
      },
    };

    // Mock linear mutations (just track calls)
    const linearMutationCalls: string[] = [];
    const mockLinear = {
      getActiveIssues: mock(async () => [issue]),
      updateIssueState: mock(async (_id: string, _stateId: string) => {
        linearMutationCalls.push(`updateIssueState(${_id})`);
      }),
      addComment: mock(async (_id: string, _body: string) => {
        linearMutationCalls.push(`addComment(${_id})`);
      }),
      linkPRAttachment: mock(async (_id: string, _url: string) => {
        linearMutationCalls.push(`linkPRAttachment(${_id})`);
      }),
    } as unknown as import("../../src/linear/client.js").LinearClient;

    // Mock: WorkspaceManager.ensureWorkspace
    const mockWorkspaceManager = {
      ensureWorkspace: mock(async () => ({
        identifier: "team-issue-1",
        absPath: "/tmp/symphony-test/team-issue-1",
        created: true,
      })),
      prepareRun: mock(async () => {}),
      finalizeRun: mock(async () => {}),
      cleanupWorkspace: mock(async () => {}),
    } as unknown as import("../../src/workspace/WorkspaceManager.js").WorkspaceManager;

    // Mock: LiquidRenderer
    const mockLiquidRenderer = {
      renderWorkflow: mock(async (_tpl: string, _ctx: unknown) => "Rendered workflow"),
    } as unknown as import("../../src/workflow/LiquidRenderer.js").LiquidRenderer;

    // Mock: agentClient (not used directly — WorkerRunner and ReviewerWorkflow are injected)
    const mockAgentClient = {
      runTurn: mock(async () => ({
        status: "ok" as const,
        summary: "mock",
      })),
    } as unknown as import("../../src/worker/OpenCodeAgentClient.js").OpenCodeAgentClient;

    const deps: CommandDeps = {
      getState: () => state,
      emitEvent: (evt) => {
        const result = applyEvent(state, evt);
        state = result.state;
        // Execute commands produced by this event (e.g. spawn_and_run_reviewer after worker.finished)
        void executeCommands(result.commands, deps);
      },
      linear: mockLinear,
      workspaceManager: mockWorkspaceManager,
      agentClient: mockAgentClient,
      liquidRenderer: mockLiquidRenderer,
      createWorkerRunner: (_opts: WorkerRunnerOptions) => mockWorkerRunner,
      createReviewerWorkflow: (_opts: ReviewerWorkflowOptions) =>
        mockReviewerWorkflow as import("../../src/reviewer/ReviewerWorkflow.js").ReviewerWorkflow,
    };

    // Execute commands (spawn_and_run_worker)
    await executeCommands(tickCommands, deps);

    // Allow microtasks to settle
    await new Promise((r) => setTimeout(r, 50));

    // ── Assertions ────────────────────────────────────────────────────────────

    // Worker ran 2 turns
    expect(turnLog).toEqual(["turn-1", "turn-2"]);

    // Issue ended in succeeded state
    const lc = state.issueLifecycleById.get("issue-1" as IssueId);
    expect(lc?.kind).toBe("succeeded");

    // PR draft is attached
    if (lc?.kind === "succeeded") {
      expect(lc.pr?.title).toBe("Fix the bug (TEAM-1)");
    }

    // No longer running
    expect(state.runningIssueIds.has("issue-1" as IssueId)).toBe(false);

    // Completed in < 5s (all mocked)
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});
