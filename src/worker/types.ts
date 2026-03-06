// src/worker/types.ts — Worker domain types

export type WorkerExitStatus = "completed" | "cancelled" | "failed" | "input_required" | "max_turns";

export interface WorkerResult {
  status: WorkerExitStatus;
  turns: number;
  lastSessionId?: string;
  workspacePath: string;
  workspaceId: string;
  lastTurnSummary?: string;
  error?: { code: string; message: string; details?: unknown };
}

export interface WorkerConfig {
  maxTurns: number;
  pollLinearEachTurn: boolean;
  timeoutMs: number;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  maxTurns: 20,
  pollLinearEachTurn: false,
  timeoutMs: 1_800_000, // 30 min
};
