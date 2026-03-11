// src/orchestrator/state.ts — Pure reducer: applyEvent()
// No side effects. Returns new state + command list.

import type {
  OrchestratorState,
  OrchestratorEvent,
  IssueId,
  AttemptId,
  SessionId,
  RetryEntry,
  Millis,
} from "./types.js";

export type OrchestratorCommand =
  | { type: "spawn_and_run_worker";   issueId: IssueId; attemptId: AttemptId }
  | { type: "spawn_and_run_reviewer"; issueId: IssueId; attemptId: AttemptId; workerResult: import('./worker/types.js').WorkResult }
  | { type: "create_pull_request";    issueId: IssueId; prDraft: import('./orchestrator/types.js').PullRequestDraft }
  | { type: "schedule_retry";         issueId: IssueId; entry: RetryEntry }
  | { type: "close_session";          sessionId: SessionId; reason: string }
  | { type: "update_linear_state";    issueId: IssueId; stateId: string };

export function computeBackoffMs(attempt: number, maxMs: Millis): Millis {
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
      console.log("[state] linear.polled event: issues=" + evt.issues.map(i => i.key).join(","));
      for (const issue of evt.issues) {
        state.issuesById.set(issue.id, issue);
        if (!state.issueLifecycleById.has(issue.id)) {
          console.log("[state]   NEW:", issue.key);
          state.issueLifecycleById.set(issue.id, { kind: "discovered", firstSeenAt: evt.polledAt });
        }
        const lifecycle = state.issueLifecycleById.get(issue.id);
        const terminal = lifecycle?.kind === "succeeded" || lifecycle?.kind === "failed";
        const alreadyRunning = state.runningIssueIds.has(issue.id);
        const alreadyQueued = state.queuedIssueIds.has(issue.id);
        console.log("[state]   CHK:", issue.key, "terminal=" + terminal + " running=" + alreadyRunning + " queued=" + alreadyQueued + " lifecycle=" + lifecycle?.kind);
        
        if (!terminal && !alreadyRunning && !alreadyQueued) {
          console.log("[state]   QUE:", issue.key);
          state.queuedIssueIds.add(issue.id);
          state.issueLifecycleById.set(issue.id, { kind: "queued", queuedAt: evt.polledAt, reason: "linear.polled" });
        }
      }
      console.log("[state] Done. queued=" + state.queuedIssueIds.size + " running=" + state.runningIssueIds.size);
      break;

    case "scheduler.tick":
      // 1. Promote retry_wait to queued
      for (const [issueId, entry] of state.retryByIssueId.entries()) {
        if (new Date(entry.nextRunAt).getTime() <= new Date(evt.now).getTime()) {
          state.queuedIssueIds.add(issueId);
          state.retryByIssueId.delete(issueId);
        }
      }
      // 2. Dispatch queued issues (respecting concurrency limit)
      console.log("[state] tick: queued=" + state.queuedIssueIds.size + " running=" + state.runningIssueIds.size + " max=" + state.maxConcurrentAgents);
      for (const issueId of state.queuedIssueIds) {
        const issue = state.issuesById.get(issueId);
        if (state.runningIssueIds.size >= state.maxConcurrentAgents) {
          console.log("[state]   FULL: " + issue?.key + " (running count at limit)");
          break;
        }
        if (state.runningIssueIds.has(issueId)) {
          console.log("[state]   SKIP: " + issue?.key + " (already running)");
          continue;
        }
        console.log("[state]   SPAWN: " + issue?.key);
        commands.push({ type: "spawn_and_run_worker", issueId, attemptId: "" as AttemptId });
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
      // Emit command to update Linear state to "In Progress"
      const inProgressStateId = state.workflow.frontMatter.linear.stateIds?.inProgress;
      if (inProgressStateId) {
        commands.push({ type: "update_linear_state", issueId: evt.issueId, stateId: inProgressStateId });
      }
      break;
    }

    case "worker.finished": {
      const lc = state.issueLifecycleById.get(evt.issueId);
      if (!lc || (lc.kind !== "running" && lc.kind !== "needs_changes")) break;
      state.issueLifecycleById.set(evt.issueId, {
        kind: "awaiting_review",
        sessionId: lc.sessionId ?? ("" as SessionId),
        attempt: (lc as any).attempt ?? 1,
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
      const lc0 = state.issueLifecycleById.get(evt.issueId);
      const currentAttempt = (lc0 as any)?.attempt ?? (state.attemptIdsByIssueId.get(evt.issueId)?.length ?? 0);
      const maxAttempts = state.workflow.frontMatter.retry.maxAttempts;

      if (!issue || currentAttempt >= maxAttempts) {
        state.issueLifecycleById.set(evt.issueId, {
          kind: "failed",
          finishedAt: evt.at,
          error: evt.type === "worker.failed"
            ? evt.error
            : { name: "TimeoutError", message: "worker timed out" },
        });
      } else {
        const nextAttempt = currentAttempt;
        const backoffMs = computeBackoffMs(nextAttempt, state.workflow.frontMatter.retry.maxRetryBackoffMs);
        const nextRunAt = new Date(Date.now() + (backoffMs as number)).toISOString() as import("./types.js").IsoDateTime;
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
      if (evt.result.gate === "pass") {
        const succeededState: import("./types.js").IssueLifecycleState & { kind: "succeeded" } = {
          kind: "succeeded",
          sessionId: state.sessionIdByIssueId.get(evt.issueId) ?? ("" as SessionId),
          finishedAt: evt.at,
        };
        if (evt.result.prDraft) succeededState.pr = evt.result.prDraft;
        state.issueLifecycleById.set(evt.issueId, succeededState);
        state.runningIssueIds.delete(evt.issueId);
        
        // If PR draft exists, emit command to create it
        if (evt.result.prDraft) {
          commands.push({ type: "create_pull_request", issueId: evt.issueId, prDraft: evt.result.prDraft });
        }
        
        // Emit command to update Linear state to "Done"
        const doneStateId = state.workflow.frontMatter.linear.stateIds?.done;
        if (doneStateId) {
          commands.push({ type: "update_linear_state", issueId: evt.issueId, stateId: doneStateId });
        }
        const sid = state.sessionIdByIssueId.get(evt.issueId);
        if (sid) commands.push({ type: "close_session", sessionId: sid, reason: "completed" });
      } else {
        const lc = state.issueLifecycleById.get(evt.issueId);
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
      const nextRunAt = new Date(Date.now() + (backoffMs as number)).toISOString() as import("./types.js").IsoDateTime;
      if (issue) {
        state.retryByIssueId.set(evt.issueId, {
          issueId: evt.issueId,
          issueKey: issue.key,
          attempt: nextAttempt,
          nextRunAt,
          backoffMs,
          reason: `reviewer failed: ${evt.error.message}`,
        });
        state.issueLifecycleById.set(evt.issueId, {
          kind: "retry_wait",
          nextRunAt,
          attempt: nextAttempt,
          reason: evt.error.message,
          backoffMs,
        });
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

    case "retry.due":
      // Handled by scheduler.tick — nothing to do here
      break;

    case "attempt.canceled":
      // No state transition needed — attempt is already removed from inflight
      break;
  }

  return { state, commands };
}
