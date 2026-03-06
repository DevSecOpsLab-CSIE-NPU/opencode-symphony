// src/worker/WorkerRunner.ts — Worker turn loop

import type { LinearIssue } from "../orchestrator/types.js";
import type { OpenCodeAgentClient } from "./OpenCodeAgentClient.js";
import type { WorkerConfig, WorkerResult } from "./types.js";
import { DEFAULT_WORKER_CONFIG } from "./types.js";

export interface WorkerRunnerOptions {
  issue: LinearIssue;
  /** Turn 1 prompt: fully Liquid-rendered WORKFLOW.md body */
  workflowMarkdown: string;
  workspacePath: string;
  workspaceId: string;
  attempt: number;
  /** Injected when resuming after reviewer request_changes */
  continuationGuidance?: string;
  config?: Partial<WorkerConfig>;
  agentClient: OpenCodeAgentClient;
}

export class WorkerRunner {
  private readonly config: WorkerConfig;
  private currentSessionId: string | null = null;

  constructor(private readonly opts: WorkerRunnerOptions) {
    this.config = { ...DEFAULT_WORKER_CONFIG, ...opts.config };
  }

  /**
   * Logical session ID: <thread_id>-<turn_number>
   * e.g. "thread-ENG123-attempt1-3"  (3rd turn of first attempt)
   * All turns for the same attempt share a logical thread ID, so the
   * OpencodeSessionClient can map them to one OpenCode session.
   */
  private makeSessionId(turn: number): string {
    return `thread-${this.opts.issue.key}-attempt${this.opts.attempt}-${turn}`;
  }

  /**
   * Run the full turn loop.
   * • Turn 1: sends the full Liquid-rendered workflow markdown as prompt.
   * • Turn 2+: sends only continuation guidance ("continue / here’s the reviewer feedback").
   * • Stops when: status is ok|failed|input_required|cancelled, OR maxTurns is reached.
   */
  async run(): Promise<WorkerResult> {
    const { issue, workflowMarkdown, workspacePath, workspaceId, attempt } = this.opts;
    let turns = 0;
    let lastSummary = "";

    for (let turn = 1; turn <= this.config.maxTurns; turn++) {
      turns = turn;
      const sessionId = this.makeSessionId(turn);
      this.currentSessionId = sessionId;

      // Build the input for this turn
      let input: string;
      if (turn === 1) {
        // Turn 1: full prompt (Liquid-rendered WORKFLOW.md)
        input = workflowMarkdown;
        // Prepend continuation guidance if retrying after reviewer feedback
        if (this.opts.continuationGuidance !== undefined) {
          input = `## Reviewer Feedback (from previous attempt)\n\n${this.opts.continuationGuidance}\n\n---\n\n${input}`;
        }
      } else {
        // Turn 2+: continuation only (no re-send of full prompt — saves tokens)
        input = lastSummary.length > 0
          ? `Continue working on issue ${issue.key}. Previous turn summary: ${lastSummary.slice(-500)}`
          : `Continue working on issue ${issue.key}.`;
      }

      const result = await this.opts.agentClient.runTurn({
        sessionId,
        cwd: workspacePath,
        role: "worker",
        input,
      });

      lastSummary = result.summary;

      switch (result.status) {
        case "ok":
          // Agent completed this turn; check if more turns needed
          // We treat "ok" + last turn = completed.
          if (turn >= this.config.maxTurns) {
            return {
              status: "max_turns",
              turns,
              lastSessionId: sessionId,
              workspacePath,
              workspaceId,
              lastTurnSummary: lastSummary,
            };
          }
          // Continue to next turn if the model’s output suggests more work.
          // Simple heuristic: if the last output contains a DONE marker we stop.
          if (isDone(lastSummary)) {
            return {
              status: "completed",
              turns,
              lastSessionId: sessionId,
              workspacePath,
              workspaceId,
              lastTurnSummary: lastSummary,
            };
          }
          // Otherwise continue
          break;

        case "cancelled":
          return {
            status: "cancelled",
            turns,
            lastSessionId: sessionId,
            workspacePath,
            workspaceId,
            lastTurnSummary: lastSummary,
          };

        case "input_required":
          return {
            status: "input_required",
            turns,
            lastSessionId: sessionId,
            workspacePath,
            workspaceId,
            lastTurnSummary: lastSummary,
            ...(result.inputRequest !== undefined && {
              error: { code: "INPUT_REQUIRED", message: result.inputRequest },
            }),
          };

        case "failed":
          return {
            status: "failed",
            turns,
            lastSessionId: sessionId,
            workspacePath,
            workspaceId,
            lastTurnSummary: lastSummary,
            error: { code: "AGENT_TURN_FAILED", message: lastSummary },
          };
      }
    }

    // Reached maxTurns
    return {
      status: "max_turns",
      turns,
      workspacePath,
      workspaceId,
      ...(this.currentSessionId !== null && { lastSessionId: this.currentSessionId }),
      lastTurnSummary: lastSummary,
    };
  }

  async cancel(): Promise<void> {
    if (this.currentSessionId !== null) {
      await this.opts.agentClient.cancelSession?.(this.currentSessionId);
      this.currentSessionId = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// isDone — heuristic: did the model signal completion?
// The agent is expected to end its final message with one of these signals.
// ─────────────────────────────────────────────────────────────────────────────

const DONE_PATTERNS = [
  /\bDONE\b/,
  /\bCOMPLETE\b/i,
  /task (?:is )?(?:complete|done|finished)/i,
  /implementation (?:is )?(?:complete|done|finished)/i,
  /all (?:tests? )?pass/i,
];

function isDone(summary: string): boolean {
  const tail = summary.slice(-500);
  return DONE_PATTERNS.some((re) => re.test(tail));
}
