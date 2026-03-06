// src/reviewer/types.ts — Reviewer domain types

export interface ReviewerConfig {
  timeoutMs: number;
}

export interface ReviewerOutput {
  decision: "approve" | "request_changes";
  summary: string;
  requiredChanges?: string[];
  prTitle?: string;
  prBody?: string;
}
