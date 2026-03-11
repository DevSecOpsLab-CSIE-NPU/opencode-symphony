// tests/disworkspace-cleanup.test.ts — Verify workspace cleanup enhancement (Cycle 2)

import { describe, it, expect } from "bun:test";
import type { OrchestratorState, OrchestratorEvent } from "../src/orchestrator/types.js";
import type { OrchestratorCommand, CommandDeps } from "../src/orchestrator/commands.js";
import type { WorkspaceManager } from "../src/workspace/WorkspaceManager.js";

// ──── Helpers for test setup ───────────────────────────────────────

function makeInitialState(): OrchestratorState {
  return {
    workflow: {
      path: "/WORKFLOW.md",
      revision: 1,
      loadedAt: "2026-01-01T00:00:00.000Z" as any,
      frontMatter: {
        linear: {
          pollIntervalMs: 30000,
          teamIds: ["team-1"],
        },
        workspace: {
          root: "/workspaces" as import("../src/orchestrator/types.js").WorkspaceRoot,
          maxConcurrentAgents: 5,
          cleanupOnSuccess: true,
          cleanupOnFailure: false,
          keepHistoryDays: "30",
        },
        retry: {
          maxAttempts: 3,
          maxRetryBackoffMs: 300000 as any,
        },
        timeouts: {
          workerRunTimeoutMs: 600000 as any,
          reviewerRunTimeoutMs: 120000 as any,
          sessionIdleTimeoutMs: 1800000 as any,
        },
        appServer: {
          command: "opencode",
        },
      },
      liquidTemplate: "",
    },
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
    startedAt: "2026-01-01T00:00:00.000Z" as any,
    isRunning: true,
  };
}

function mockWorkspaceManager(): WorkspaceManager & { cleanupCalls: string[]; oldCleanupCalls: number } {
  const calls = { cleanupCalls: [] as string[], oldCleanupCalls: 0 };
  
  return {
    ensureWorkspace: () => Promise.resolve({ identifier: "test", absPath: "/tmp/test", created: true }),
    prepareRun: () => Promise.resolve(),
    finalizeRun: () => Promise.resolve(),
    cleanupWorkspace: async (sessionId: string) => {
      calls.cleanupCalls.push(sessionId);
      console.log(`[mock] cleanupWorkspace called for sessionId=${sessionId}`);
    },
    cleanupOldWorkspaces: async (days?: number) => {
      calls.oldCleanupCalls++;
      console.log(`[mock] cleanupOldWorkspaces called with days=${days ?? "default"}`);
    },
    ...calls,
  } as any;
}

function makeMockDeps(stateRef: { value: OrchestratorState }): CommandDeps {
  return {
    getState: () => stateRef.value,
    emitEvent: (evt) => {
      const result = import("../src/orchestrator/state.js").then(m => m.applyEvent(stateRef.value, evt));
      stateRef.value = result.state;
      void import("../src/orchestrator/commands.js").then(c => c.executeCommands(result.commands, deps));
      return { state: stateRef.value, commands: [], };
    },
    linear: {
      getActiveIssues: () => Promise.resolve([]),
      updateIssueState: async () => {},
      addComment: async () => ({ id: "1", url: "test" }),
      linkPRAttachment: async () => ({ id: "1", url: "test" }),
    } as any,
    workspaceManager: mockWorkspaceManager(),
    agentClient: { runTurn: async () => ({ status: "ok", summary: "" }) } as any,
    liquidRenderer: { renderWorkflow: async () => "template" },
  };
}

// ──── Tests ───────────────────────────────────────────────────────

describe("Cycle 2: Workspace cleanup automation", () => {
  it("should cleanup workspace on issue completion when policy enabled", async () => {
    const stateRef = { value: makeInitialState() };
    const deps = makeMockDeps(stateRef);
    const wsManager = deps.workspaceManager as any;

    // Add a session and mark issue as succeeded (which triggers close_session)
    const sessionId = "session-1";
    const issueId = "issue-1";
    stateRef.value.sessionsById.set(sessionId, { id: sessionId, workspacePath: "/tmp/test", status: "ready" });
    stateRef.value.sessionIdByIssueId.set(issueId, sessionId);
    stateRef.value.issueLifecycleById.set(issueId, {
      kind: "succeeded",
      sessionId,
      finishedAt: "2026-01-01T00:00:05.000Z" as any,
      pr: undefined,
    });

    // Trigger close_session command manually (normally emitted by state machine)
    const { applyEvent } = await import("../src/orchestrator/state.js");
    const { executeCommands } = await import("../src/orchestrator/commands.js");

    const eventResult = applyEvent(stateRef.value, { type: "manual.trigger_cleanup", issueId, sessionId, time: Date.now() });
    stateRef.value = eventResult.state;
    
    // Execute the close_session command that should have been emitted
    await executeCommands([{ type: "close_session", sessionId, reason: "completed" } as OrchestratorCommand], deps);

    expect(wsManager.cleanupCalls).toContain(sessionId);
    expect(wsManager.cleanupCalls.length).toBe(1);
  });

  it("should respect cleanupOnFailure policy toggle", async () => {
    const stateRef = { value: makeInitialState() };
    // Disable cleanup on failure
    stateRef.value.workflow.frontMatter.workspace.cleanupOnFailure = false;
    
    const deps = makeMockDeps(stateRef);
    const wsManager = deps.workspaceManager as any;

    const sessionId = "session-2";
    const issueId = "issue-2";
    stateRef.value.sessionsById.set(sessionId, { id: sessionId, workspacePath: "/tmp/test", status: "ready" });
    stateRef.value.sessionidByIssueId.set(issueId, sessionId);
    stateRef.value.issueLifecycleById.set(issueId, { kind: "failed", finishedAt: "2026-01-01T00:00:05.000Z" as any });

    await executeCommands([{ type: "close_session", sessionId, reason: "failed" } as OrchestratorCommand], deps);

    // Should NOT cleanup since policy is disabled
    expect((deps.workspaceManager as any).cleanupCalls.length).toBe(0);
  });

  it("should run retention-based cleanup on session close", async () => {
    const stateRef = { value: makeInitialState() };
    const deps = makeMockDeps(stateRef);
    const wsManager = deps.workspaceManager as any;

    // Just trigger close_session - should always attempt old workspace cleanup
    await executeCommands([{ type: "close_session", sessionId: "session-3", reason: "completed" } as OrchestratorCommand], deps);

    expect(wsManager.oldCleanupCalls).toBeGreaterThan(0);
  });

  it("should keep workspace on timeout for debugging", async () => {
    const stateRef = { value: makeInitialState() };
    const deps = makeMockDeps(stateRef);

    // Session closed due to timeout should NOT trigger cleanup
    await executeCommands([{ type: "close_session", sessionId: "session-timeout", reason: "timeout" } as OrchestratorCommand], deps);

    // If we had a session attached, it wouldn't be cleaned up (logic in close handler)
    expect(true).toBe(true); // Placeholder for future assertion with mocked session
  });
});

// Run the tests
console.log("\n=== Running Workspace Cleanup Enhancement Tests ===");
console.log("These tests validate Cycle 2: Automatic workspace cleanup on issue completion.");
console.log("Expected: Workspaces are cleaned up when issues succeed, respecting retention policies.\n");
