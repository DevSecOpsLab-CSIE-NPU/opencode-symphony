// src/messages.ts — Cross-module message types

import type { LinearIssue } from "./orchestrator/types.js";

export type SymphonyMsg =
  | WorkerStartMsg
  | WorkerDoneMsg
  | ReviewerRequestMsg
  | ReviewerResultMsg;

export interface WorkerStartMsg {
  type: "worker_start";
  threadId: string;
  attempt: number;
  issue: LinearIssue;
  workflowMarkdown: string;
  continuationGuidance?: string; // reviewer feedback for turn > 1
  workerConfig?: {
    maxTurns?: number;
    pollLinearEachTurn?: boolean;
  };
}

export interface WorkerDoneMsg {
  type: "worker_done";
  threadId: string;
  attempt: number;
  issueId: string;
  workspaceId: string;
  workspacePath: string;
  status: "completed" | "cancelled" | "failed" | "input_required" | "max_turns";
  turns: number;
  lastSessionId?: string;
  lastTurnSummary?: string;
  error?: { code: string; message: string; details?: unknown };
}

export interface ReviewerRequestMsg {
  type: "reviewer_request";
  threadId: string;
  attempt: number;
  issue: LinearIssue;
  workspacePath: string;
  workspaceId: string;
  workerSummary?: string;
}

export type ReviewerDecision = "approve" | "request_changes";

export interface ReviewerResultMsg {
  type: "reviewer_result";
  threadId: string;
  attempt: number;
  issueId: string;
  workspaceId: string;
  decision: ReviewerDecision;
  gates: Array<{ name: string; passed: boolean; details?: string }>;
  pr?: { url: string; title: string; body: string; number?: number };
  feedback?: string;  // fed into next worker continuationGuidance
  error?: { code: string; message: string; details?: unknown };
}
