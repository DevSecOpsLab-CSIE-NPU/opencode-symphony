// src/orchestrator/commands.ts — Side-effect command executor
// Runs commands emitted by applyEvent(). Pure side effects only—no state reads.

import { randomUUID } from "node:crypto";
import type {
  OrchestratorState,
  OrchestratorEvent,
  IssueId,
  AttemptId,
  SessionId,
  IsoDateTime,
  WorkResult,
} from "./types.js";
import type { OrchestratorCommand } from "./state.js";
import type { LinearClient } from "../linear/client.js";
import type { WorkspaceManager } from "../workspace/WorkspaceManager.js";
import type { WorkerRunner, WorkerRunnerOptions } from "../worker/WorkerRunner.js";
import type { OpenCodeAgentClient } from "../worker/OpenCodeAgentClient.js";
import type { ReviewerWorkflow, ReviewerWorkflowOptions } from "../reviewer/ReviewerWorkflow.js";
import type { LiquidRenderer } from "../workflow/LiquidRenderer.js";

// ─────────────────────────────────────────────────────────────────────────────
// Deps injected into executeCommands
// ─────────────────────────────────────────────────────────────────────────────

export interface CommandDeps {
  getState: () => OrchestratorState;
  emitEvent: (evt: OrchestratorEvent) => void;
  linear: LinearClient;
  workspaceManager: WorkspaceManager;
  agentClient: OpenCodeAgentClient;
  liquidRenderer: LiquidRenderer;
  /** Factory so tests can inject mock runners. */
  createWorkerRunner?: (opts: WorkerRunnerOptions) => WorkerRunner;
  createReviewerWorkflow?: (opts: ReviewerWorkflowOptions) => ReviewerWorkflow;
}

// ─────────────────────────────────────────────────────────────────────────────
// executeCommands — main dispatch
// ─────────────────────────────────────────────────────────────────────────────

export async function executeCommands(
  commands: OrchestratorCommand[],
  deps: CommandDeps,
): Promise<void> {
  for (const cmd of commands) {
    // Fire-and-forget: each command runs independently; errors emitted back as events
    void executeOneCommand(cmd, deps);
  }
}

async function executeOneCommand(cmd: OrchestratorCommand, deps: CommandDeps): Promise<void> {
  switch (cmd.type) {
    case "spawn_and_run_worker":
      await handleSpawnWorker(cmd.issueId, deps);
      break;

    case "spawn_and_run_reviewer":
      await handleSpawnReviewer(cmd.issueId, cmd.workerResult, deps);
      break;

    case "schedule_retry":
      // No async work needed — Scheduler tick re-enqueues when entry is due.
      break;

    case "close_session":
      // Stateless implementation: no persistent app-server process to close.
      break;

    default: {
      const _exhaustive: never = cmd;
      console.warn("[commands] unknown command:", _exhaustive);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// spawn_and_run_worker
// ─────────────────────────────────────────────────────────────────────────────

async function handleSpawnWorker(issueId: IssueId, deps: CommandDeps): Promise<void> {
  const state = deps.getState();
  const issue = state.issuesById.get(issueId);
  if (!issue) {
    console.warn(`[commands] spawn_and_run_worker: unknown issueId=${issueId}`);
    return;
  }

  const attemptId = randomUUID() as AttemptId;
  const existingAttempts = state.attemptIdsByIssueId.get(issueId) ?? [];
  const attempt = existingAttempts.length + 1;

  // Read continuationGuidance BEFORE issue.start_work mutates the lifecycle
  const preLc = state.issueLifecycleById.get(issueId);
  const continuationGuidance =
    preLc?.kind === "needs_changes" ? preLc.reviewSummary : undefined;

  // Mark issue as started in the state machine
  deps.emitEvent({ type: "issue.start_work", issueId, at: now() });



  // Provision workspace
  let workspacePath: string;
  let workspaceId: string;
  try {
    const ws = await deps.workspaceManager.ensureWorkspace({ rawIdentifier: issue.key });
    workspacePath = ws.absPath;
    workspaceId = ws.identifier;
  } catch (err) {
    deps.emitEvent({ type: "worker.failed", issueId, attemptId, error: toSerializable(err), at: now() });
    return;
  }

  // Render Liquid workflow template for Turn 1
  let workflowMarkdown: string;
  try {
    workflowMarkdown = await deps.liquidRenderer.renderWorkflow(
      state.workflow.liquidTemplate,
      { issue, attempt },
    );
  } catch (err) {
    deps.emitEvent({ type: "worker.failed", issueId, attemptId, error: toSerializable(err), at: now() });
    return;
  }

  // (continuationGuidance already captured above, before issue.start_work)

  const opts: WorkerRunnerOptions = {
    issue,
    workflowMarkdown,
    workspacePath,
    workspaceId,
    attempt,
    agentClient: deps.agentClient,
    config: {
      timeoutMs: state.workflow.frontMatter.timeouts.workerRunTimeoutMs as number,
    },
    ...(continuationGuidance !== undefined && { continuationGuidance }),
  };

  const { WorkerRunner: WR } = await import("../worker/WorkerRunner.js");
  const runner = deps.createWorkerRunner ? deps.createWorkerRunner(opts) : new WR(opts);

  const timeoutMs = state.workflow.frontMatter.timeouts.workerRunTimeoutMs as number;
  const workerTimeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("worker timeout")), timeoutMs),
  );

  try {
    const result = await Promise.race([runner.run(), workerTimeout]);

    if (result.status === "completed") {
      const workResult: WorkResult = {
        summary: result.lastTurnSummary ?? "(no summary)",
        ...(result.turns !== undefined && { notes: `turns=${result.turns}` }),
      };
      recordAttempt(state, issueId, attemptId);
      deps.emitEvent({ type: "worker.finished", issueId, attemptId, result: workResult, at: now() });
    } else if (result.status === "cancelled") {
      deps.emitEvent({ type: "attempt.canceled", issueId, attemptId, at: now() });
    } else {
      const error = result.error
        ? { name: result.error.code, message: result.error.message }
        : { name: "WorkerError", message: result.status };
      recordAttempt(state, issueId, attemptId);
      deps.emitEvent({ type: "worker.failed", issueId, attemptId, error, at: now() });
    }
  } catch (err: unknown) {
    recordAttempt(state, issueId, attemptId);
    if (err instanceof Error && err.message === "worker timeout") {
      deps.emitEvent({ type: "attempt.timed_out", issueId, attemptId, role: "worker", at: now() });
    } else {
      deps.emitEvent({ type: "worker.failed", issueId, attemptId, error: toSerializable(err), at: now() });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// spawn_and_run_reviewer
// ─────────────────────────────────────────────────────────────────────────────

async function handleSpawnReviewer(
  issueId: IssueId,
  workerResult: WorkResult,
  deps: CommandDeps,
): Promise<void> {
  const state = deps.getState();
  const issue = state.issuesById.get(issueId);
  if (!issue) {
    console.warn(`[commands] spawn_and_run_reviewer: unknown issueId=${issueId}`);
    return;
  }

  const attemptId = randomUUID() as AttemptId;
  const lc = state.issueLifecycleById.get(issueId);
  const attempt = (lc as { attempt?: number } | undefined)?.attempt ?? 1;
  const sessionId = state.sessionIdByIssueId.get(issueId) ?? ("" as SessionId);
  const workspacePath = state.sessionsById.get(sessionId)?.workspacePath ?? "";

  const opts: ReviewerWorkflowOptions = {
    issue,
    workspacePath,
    workspaceId: sessionId as string,
    attempt,
    ...(workerResult.summary !== undefined && { workerSummary: workerResult.summary }),
  };

  const { ReviewerWorkflow: RW } = await import("../reviewer/ReviewerWorkflow.js");
  const workflow = deps.createReviewerWorkflow
    ? deps.createReviewerWorkflow(opts)
    : new RW(opts, deps.agentClient);

  const timeoutMs = state.workflow.frontMatter.timeouts.reviewerRunTimeoutMs as number;
  const reviewerTimeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("reviewer timeout")), timeoutMs),
  );

  try {
    const result = await Promise.race([workflow.run(), reviewerTimeout]);
    deps.emitEvent({ type: "reviewer.finished", issueId, attemptId, result, at: now() });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "reviewer timeout") {
      deps.emitEvent({ type: "attempt.timed_out", issueId, attemptId, role: "reviewer", at: now() });
    } else {
      deps.emitEvent({ type: "reviewer.failed", issueId, attemptId, error: toSerializable(err), at: now() });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function recordAttempt(state: OrchestratorState, issueId: IssueId, attemptId: AttemptId): void {
  const existing = state.attemptIdsByIssueId.get(issueId) ?? [];
  existing.push(attemptId);
  state.attemptIdsByIssueId.set(issueId, existing);
}

function now(): IsoDateTime {
  return new Date().toISOString() as IsoDateTime;
}

function toSerializable(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      ...(err.stack !== undefined && { stack: err.stack }),
    };
  }
  return { name: "UnknownError", message: String(err) };
}
