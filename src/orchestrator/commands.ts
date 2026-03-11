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

// ─────────────────────────────────────────────────────────────────────
// Deps injected into executeCommands
// ──────────────────────────────────────────────────────────────────────

export interface CommandDeps {
  getState: () => OrchestratorState;
  emitEvent: (evt: OrchestratorEvent) => { state: OrchestratorState; commands: OrchestratorCommand[] };
  linear: LinearClient;
  workspaceManager: WorkspaceManager;
  agentClient: OpenCodeAgentClient;
  liquidRenderer: LiquidRenderer;
  /** Factory so tests can inject mock runners. */
  createWorkerRunner?: (opts: WorkerRunnerOptions) => WorkerRunner;
  createReviewerWorkflow?: (opts: ReviewerWorkflowOptions) => ReviewerWorkflow;
}

export async function emitEventAndExecute(
  evt: OrchestratorEvent,
  deps: CommandDeps,
): Promise<{ state: OrchestratorState; commands: OrchestratorCommand[] }> {
  const result = deps.emitEvent(evt);
  await executeCommands(result.commands, deps);
  return result;
}

// ───────────────────────────── Main Dispatch ──────────────────────────

export async function executeCommands(
  commands: OrchestratorCommand[],
  deps: CommandDeps,
): Promise<void> {
  for (const cmd of commands) {
    await executeOneCommand(cmd, deps);
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
      await handleCloseSession(cmd.sessionId, cmd.reason, deps);
      break;

    case "update_linear_state":
      await handleUpdateLinearState(cmd.issueId, cmd.stateId, deps);
      break;

    case "create_pull_request":
      await handleCreatePullRequest(cmd.issueId, cmd.prDraft, deps);
      break;

    default: {
      const _exhaustive: never = cmd;
      console.warn("[commands] unknown command:", _exhaustive);
    }
  }
}

// ──────────────────── spawn_and_run_worker ────────────────────────────

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
  await emitEventAndExecute({ type: "issue.start_work", issueId, at: now() }, deps);


  // Provision workspace
  let workspacePath: string;
  let workspaceId: string;
  try {
    const ws = await deps.workspaceManager.ensureWorkspace({ rawIdentifier: issue.key });
    workspacePath = ws.absPath;
    workspaceId = ws.identifier;
  } catch (err) {
    await emitEventAndExecute({ type: "worker.failed", issueId, attemptId, error: toSerializable(err), at: now() }, deps);
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
    await emitEventAndExecute({ type: "worker.failed", issueId, attemptId, error: toSerializable(err), at: now() }, deps);
    return;
  }

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
      await emitEventAndExecute({ type: "worker.finished", issueId, attemptId, result: workResult, at: now() }, deps);
    } else if (result.status === "cancelled") {
      await emitEventAndExecute({ type: "attempt.canceled", issueId, attemptId, at: now() }, deps);
    } else {
      const error = result.error
        ? { name: result.error.code, message: result.error.message }
        : { name: "WorkerError", message: result.status };
      recordAttempt(state, issueId, attemptId);
      await emitEventAndExecute({ type: "worker.failed", issueId, attemptId, error, at: now() }, deps);
    }
  } catch (err: unknown) {
    recordAttempt(state, issueId, attemptId);
    if (err instanceof Error && err.message === "worker timeout") {
      await emitEventAndExecute({ type: "attempt.timed_out", issueId, attemptId, role: "worker", at: now() }, deps);
    } else {
      await emitEventAndExecute({ type: "worker.failed", issueId, attemptId, error: toSerializable(err), at: now() }, deps);
    }
  }
}

// ──────────────────── spawn_and_reviewer ───────────────────────────────

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
  const attempt = (lc as any)?.attempt ?? 1;
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
    await emitEventAndExecute({ type: "reviewer.finished", issueId, attemptId, result, at: now() }, deps);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "reviewer timeout") {
      await emitEventAndExecute({ type: "attempt.timed_out", issueId, attemptId, role: "reviewer", at: now() }, deps);
    } else {
      await emitEventAndExecute({ type: "reviewer.failed", issueId, attemptId, error: toSerializable(err), at: now() }, deps);
    }
  }
}

// ──────────────────── create_pull_request ──────────────────────────────

async function handleCreatePullRequest(issueId: IssueId, prDraft: import('./orchestrator/types.js').PullRequestDraft, deps: CommandDeps): Promise<void> {
  const state = deps.getState();
  const issue = state.issuesById.get(issueId);
  if (!issue) {
    console.warn(`[commands] create_pull_request: unknown issueId=${issueId}`);
    return;
  }

  try {
    let workspacePath = "";
    for (const session of state.sessionsById.values()) {
      workspacePath = session.workspacePath;
      break;
    }
    
    if (!workspacePath) {
      console.warn(`[commands] create_pull_request: no workspace found for issue ${issue.key}`);
      return;
    }

    const execFile = (await import("node:child_process")).execFile;
    const promisify = (await import("node:util")).promisify;
    const execAsync = promisify(execFile);

    const prBranch = `symphony/${issue.key.toLowerCase()}-${Date.now()}`;

    await execAsync("git", ["add", "."], {
      cwd: workspacePath,
      timeout: 30_000,
    });

    const mainBranch = await getMainBranch(workspacePath);

    await execAsync("git", ["commit", "-m", prDraft.title], {
      cwd: workspacePath,
      timeout: 30_000,
    });

    await execAsync("git", ["checkout", "-b", prBranch], {
      cwd: workspacePath,
      timeout: 30_000,
    });

    await execAsync("git", ["push", "-u", "origin", prBranch], {
      cwd: workspacePath,
      timeout: 60_000,
    });

    const result = await execAsync("gh", [
      "pr",
      "create",
      "--title", prDraft.title,
      "--body", prDraft.body,
      "--base", mainBranch,
      "--head", prBranch,
    ], {
      cwd: workspacePath,
      env: { ...process.env },
      timeout: 60_000,
    });

    const prUrl = result.stdout.trim();
    console.log(`[commands] Created PR ${prUrl} for issue ${issue.key}`);

    try {
      await deps.linear.linkPRAttachment(issue.id, prDraft.title, prUrl);
    } catch (linkErr) {
      console.warn(`[commands] Failed to link PR attachment: ${linkErr instanceof Error ? linkErr.message : String(linkErr)}`);
    }

  } catch (err: unknown) {
    console.warn(
      `[commands] Failed to create PR for issue ${issue.key}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ──────────────────── close_session with workspace cleanup ──────────────

async function handleCloseSession(sessionId: SessionId, reason: string, deps: CommandDeps): Promise<void> {
  const state = deps.getState();
  const session = state.sessionsById.get(sessionId);
  if (!session) {
    console.warn(`[commands] close_session: unknown sessionId=${sessionId}`);
    return;
  }

  // Determine cleanup based on issue completion state
  const issueId = state.sessionIdByIssueId.get(sessionId);
  if (!issueId) return;

  const issueLifecycle = state.issueLifecycleById.get(issueId);
  
  // Get workspace policies from workflow config
  const cfg = state.workflow.frontMatter.workspace;
  const cleanupOnSuccess = cfg.cleanupOnSuccess ?? true;
  const cleanupOnFailure = cfg.cleanupOnFailure ?? false;
  const retentionDays = parseInt(cfg.keepHistoryDays ?? "30") || 30;

  let shouldCleanup = false;

  if (reason === "completed") {
    if (cleanupOnSuccess) {
      shouldCleanup = true;
      console.log(`[commands] Cleaning up workspace ${session.workspacePath} for completed issue`);
    }
  } else if (["failed", "canceled"].includes(issueLifecycle?.kind ?? "")) {
    if (cleanupOnFailure) {
      shouldCleanup = true;
      console.log(`[commands] Cleaning up workspace ${session.workspacePath} for failed/canceled issue`);
    }
  }
  // timeout reason: keep workspace for debugging

  if (shouldCleanup) {
    try {
      await deps.workspaceManager.cleanupWorkspace(sessionId);
      console.log(`[commands] Successfully cleaned up workspace sessionId=${sessionId}`);
    } catch (cleanupErr) {
      console.warn(`[commands] Cleanup failed for ${session.workspacePath}:`, cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
    }
  }

  // Check old workspaces by retention policy
  try {
    await deps.workspaceManager.cleanupOldWorkspaces(retentionDays);
  } catch (err) {
    console.warn(`[commands] Old workspace cleanup failed:`, err instanceof Error ? err.message : err);
  }
}

// ──────────────────── update_linear_state ──────────────────────────────

async function handleUpdateLinearState(issueId: IssueId, stateId: string, deps: CommandDeps): Promise<void> {
  const state = deps.getState();
  const issue = state.issuesById.get(issueId);
  if (!issue) {
    console.warn(`[commands] update_linear_state: unknown issueId=${issueId}`);
    return;
  }

  try {
    await deps.linear.updateIssueState(issue.id, stateId);
    console.log(`[commands] Updated Linear state for issue ${issue.key} to stateId=${stateId}`);
  } catch (err) {
    console.warn(
      `[commands] Failed to update Linear state for issue ${issue.key}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ─────────────────────────── Helpers ──────────────────────────────────

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

async function getMainBranch(workspacePath: string): Promise<string> {
  try {
    const execSync = (await import("node:child_process")).execSync;
    return execSync("git symbolic-ref refs/remotes/origin/HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "main";
  }
}

