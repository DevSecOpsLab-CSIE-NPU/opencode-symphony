// tests/integration/reviewer-requeue.test.ts
//
// Reviewer requesting changes then re-queuing:
//   1. Worker completes turn
//   2. Reviewer returns request_changes (gate=fail)
//   3. Issue → needs_changes lifecycle, re-queued
//   4. Worker runs again with continuationGuidance injected in prompt
//   5. Second worker turn → Reviewer approves → succeeded

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
  WorkflowDefinition,
  LinearIssue,
  ReviewResult,
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
    liquidTemplate: "You are a worker. Issue: {{ issue.title }}{% if continuationGuidance %}\n\nCONTINUATION: {{ continuationGuidance }}{% endif %}",
  };
}

function makeIssue(): LinearIssue {
  return {
    id: "issue-requeue" as IssueId,
    key: "TEAM-Q1" as IssueKey,
    title: "Requeue Test Issue",
    url: "https://linear.app/test/issue/TEAM-Q1",
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

describe("reviewer-requeue integration", () => {
  it("Reviewer request_changes → continuationGuidance present in Worker's second turn", async () => {
    const issue = makeIssue();
    const ISSUE_ID = "issue-requeue" as IssueId;
    const REVIEW_SUMMARY = "Please add unit tests for edge cases.";
    let state = makeInitialState();

    // Step 1: Poll + tick
    ({ state } = applyEvent(state, { type: "linear.polled", issues: [issue], polledAt: NOW }));
    const { state: s2, commands: cmds2 } = applyEvent(state, { type: "scheduler.tick", now: NOW });
    state = s2;
    expect(cmds2.some((c) => c.type === "spawn_and_run_worker")).toBe(true);

    // Track continuationGuidance seen by WorkerRunner
    const capturedContinuationGuidance: Array<string | undefined> = [];
    let workerCallCount = 0;
    let reviewerCallCount = 0;

    const mockLinear = {
      getActiveIssues: mock(async () => [issue]),
      updateIssueState: mock(async () => {}),
      addComment: mock(async () => {}),
      linkPRAttachment: mock(async () => {}),
    } as unknown as import("../../src/linear/client.js").LinearClient;

    const mockWorkspaceManager = {
      ensureWorkspace: mock(async () => ({
        identifier: "team-q1",
        absPath: "/tmp/symphony-test/team-q1",
        created: true,
      })),
      prepareRun: mock(async () => {}),
      finalizeRun: mock(async () => {}),
      cleanupWorkspace: mock(async () => {}),
    } as unknown as import("../../src/workspace/WorkspaceManager.js").WorkspaceManager;

    // LiquidRenderer captures context for assertion
    const capturedContexts: Array<Record<string, unknown>> = [];
    const mockLiquidRenderer = {
      renderWorkflow: mock(async (_tpl: string, ctx: unknown) => {
        capturedContexts.push(ctx as Record<string, unknown>);
        return "Rendered workflow";
      }),
    } as unknown as import("../../src/workflow/LiquidRenderer.js").LiquidRenderer;

    const mockAgentClient = {
      runTurn: mock(async () => ({ status: "ok" as const, summary: "mock" })),
    } as unknown as import("../../src/worker/OpenCodeAgentClient.js").OpenCodeAgentClient;

    const deps: CommandDeps = {
      getState: () => state,
      emitEvent: (evt) => {
        const result = applyEvent(state, evt);
        state = result.state;
        // Re-execute any new commands emitted from re-queue
        void executeCommands(result.commands, deps);
      },
      linear: mockLinear,
      workspaceManager: mockWorkspaceManager,
      agentClient: mockAgentClient,
      liquidRenderer: mockLiquidRenderer,
      createWorkerRunner: (opts: WorkerRunnerOptions): WorkerRunner => {
        workerCallCount++;
        capturedContinuationGuidance.push(opts.continuationGuidance);
        return {
          async run(): Promise<WorkerExitStatus> {
            return { status: "completed", lastTurnSummary: "Worker done. DONE.", turns: 1 };
          },
          cancel: mock(() => Promise.resolve()),
        };
      },
      createReviewerWorkflow: (_opts: ReviewerWorkflowOptions) => {
        reviewerCallCount++;
        const call = reviewerCallCount;
        return {
          async run(): Promise<ReviewResult> {
            if (call === 1) {
              // First review: request changes
              return {
                gate: "fail",
                summary: REVIEW_SUMMARY,
                requiredChanges: ["Add unit tests for edge cases"],
              };
            }
            // Second review: approve
            return {
              gate: "pass",
              summary: "All good now. LGTM.",
              prDraft: { title: "Fix TEAM-Q1", body: "Resolves TEAM-Q1." },
            };
          },
        } as import("../../src/reviewer/ReviewerWorkflow.js").ReviewerWorkflow;
      },
    };

    // ── Attempt 1: Worker completes, Reviewer requests changes ────────────────
    await executeCommands(cmds2, deps);
    await new Promise((r) => setTimeout(r, 100));

    // After first round, issue should be needs_changes and re-queued
    {
      const lc = state.issueLifecycleById.get(ISSUE_ID);
      expect(lc?.kind).toBe("needs_changes");
      if (lc?.kind === "needs_changes") {
        expect(lc.reviewSummary).toBe(REVIEW_SUMMARY);
      }
      expect(state.queuedIssueIds.has(ISSUE_ID)).toBe(true);
    }

    // ── Tick again to dispatch second worker run ───────────────────────────────
    const { state: s3, commands: cmds3 } = applyEvent(state, {
      type: "scheduler.tick",
      now: new Date(Date.now() + 100).toISOString() as IsoDateTime,
    });
    state = s3;
    expect(cmds3.some((c) => c.type === "spawn_and_run_worker")).toBe(true);

    await executeCommands(cmds3, deps);
    await new Promise((r) => setTimeout(r, 100));

    // ── Final assertions ──────────────────────────────────────────────────────

    // Workers called twice
    expect(workerCallCount).toBe(2);
    // Reviewers called twice (first: fail, second: pass)
    expect(reviewerCallCount).toBe(2);

    // First worker call: NO continuationGuidance
    expect(capturedContinuationGuidance[0]).toBeUndefined();

    // Second worker call: continuationGuidance = reviewSummary from first reviewer
    expect(capturedContinuationGuidance[1]).toBe(REVIEW_SUMMARY);

    // Issue ended in succeeded
    const lc = state.issueLifecycleById.get(ISSUE_ID);
    expect(lc?.kind).toBe("succeeded");
    if (lc?.kind === "succeeded") {
      expect(lc.pr?.title).toBe("Fix TEAM-Q1");
    }
    expect(state.runningIssueIds.has(ISSUE_ID)).toBe(false);
  });
});
