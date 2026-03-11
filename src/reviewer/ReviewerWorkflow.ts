// src/editor/ReviewerWorkflow.ts — Decision tree + LLM review

import type { ReviewResult, PullRequestDraft } from "../orchestrator/types.js";
import type { LinearIssue } from "../orchestrator/types.js";
import type { OpenCodeAgentClient } from "../worker/OpenCodeAgentClient.js";
import { runDeterministicGates } from "./gates.js";

export class ReviewerOutputInvalidError extends Error {
  override readonly name = "ReviewerOutputInvalidError" as const;
  constructor(message: string) {
    super(message);
  }
}

// TS note: use the same interface as OpenCodeAgentClient rather than the full SDK client
// so we can mock it in tests.

export interface ReviewerWorkflowOptions {
  issue: LinearIssue;
  workspacePath: string;
  workspaceId: string;
  workerSummary?: string;
  attempt: number;
}

export class ReviewerWorkflow {
  constructor(
    private readonly opts: ReviewerWorkflowOptions,
    /**
     * Agent client used to run the LLM reviewer turn.
     * Must be configured with read-only tools only.
     */
    private readonly agentClient: OpenCodeAgentClient,
  ) {}

  async run(): Promise<ReviewResult> {
    const { issue, workspacePath, workspaceId, workerSummary, attempt } = this.opts;

    // ──────────────────────────────────────────────────
    // Step 1: Deterministic gates
    // ──────────────────────────────────────────────────
    let diff: string | undefined;
    try {
      diff = await getDiff(workspacePath);
    } catch {
      diff = undefined;
    }

    const gateResults = await runDeterministicGates({
      workspacePath,
      ...(diff !== undefined && { diff }),
    });

    const failedGates = gateResults.filter((g) => g.status === "fail");
    if (failedGates.length > 0) {
      const details = failedGates.map((g) => `[${g.name}] ${g.details ?? "failed"}`).join("\n");
      return {
        gate: "fail",
        summary: `Deterministic gates failed:\n${details}`,
        requiredChanges: failedGates.map((g) => g.details ?? g.name),
      };
    }

    // ──────────────────────────────────────────────────
    // Step 2: LLM Reviewer using read-only "explore" agent
    // ──────────────────────────────────────────────────
    const reviewSessionId = `reviewer-${issue.key}-attempt${attempt}`;
    const reviewPrompt = buildReviewerPrompt({ issue, diff, workerSummary });

    const turnResult = await this.agentClient.runTurn({
      sessionId: reviewSessionId,
      cwd: workspacePath,
      role: "worker", 
      input: reviewPrompt,
    });

    if (turnResult.status === "cancelled") {
      throw new Error("Reviewer session was cancelled");
    }
    if (turnResult.status === "failed") {
      throw new Error(`Reviewer LLM failed: ${turnResult.summary}`);
    }

    // ──────────────────────────────────────────────────
    // Step 3: Parse structured JSON from LLM output
    // ──────────────────────────────────────────────────
    const parsed = extractJson(turnResult.summary);
    if (parsed === null) {
      throw new ReviewerOutputInvalidError(`No JSON found in reviewer output: ${turnResult.summary.slice(0, 200)}`);
    }

    return buildReviewResult(parsed);
  }
}

// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────

async function getDiff(workspacePath: string): Promise<string> {
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const execAsync = promisify(execFile);
  const { stdout } = await execAsync("git", ["-C", workspacePath, "diff", "HEAD"], { timeout: 15_000 });
  return stdout;
}

interface ReviewerLLMOutput {
  decision: "approve" | "request_changes";
  summary: string;
  prTitle?: string;         // when approve
  prBody?: string;          // when approve (markdown)
  requiredChanges?: string[]; // when request_changes
}

function buildReviewerPrompt(params: {
  issue: LinearIssue;
  diff: string | undefined;
  workerSummary: string | undefined;
}): string {
  const { issue, diff, workerSummary } = params;
  return `You are a senior code reviewer using OpenCode's "explore" agent (read-only only). Review the following changes and output ONLY a JSON object (no markdown fences, no prose).

Issue: ${issue.key} — ${issue.title}
URL: ${issue.url}

Worker summary:
${workerSummary ?? "(no summary provided)"}

Diff (truncated to 8000 chars):
\`\`\`diff
${(diff ?? "(no diff)").slice(0, 8000)}
\`\`\`

Output ONLY this JSON (no other text):
{
  "decision": "approve" | "request_changes",
  "summary": "<1-3 sentence explanation>",
  "prTitle": "<PR title when approve>",
  "prBody": "<PR body markdown when approve>",
  "requiredChanges": ["<specific fix 1>", "<specific fix 2>"]
}

Rules:
- Set decision to \"approve\" if the changes adequately resolve the issue and tests pass.
- Set decision to \"request_changes\" if there are bugs, missing tests, or the issue is not resolved.
- requiredChanges is required when decision is request_changes.
- prTitle and prBody are required when decision is approve.

IMPORTANT: You are running in read-only mode via the "explore" agent. You CANNOT write files. Only analyze.`;
}

/** Extract the first JSON object from arbitrary text (LLM output may have prose before/after). */
function extractJson(text: string): ReviewerLLMOutput | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (raw.decision !== "approve" && raw.decision !== "request_changes") return null;
    return raw as unknown as ReviewerLLMOutput;
  } catch {
    return null;
  }
}

function buildReviewResult(output: ReviewerLLMOutput): ReviewResult {
  if (output.decision === "approve") {
    const pr: PullRequestDraft | undefined =
      output.prTitle !== undefined && output.prBody !== undefined
        ? { title: output.prTitle, body: output.prBody }
        : undefined;
    return {
      gate: "pass",
      summary: output.summary,
      ...(pr !== undefined && { prDraft: pr }),
    };
  }
  return {
    gate: "fail",
    summary: output.summary,
    ...(output.requiredChanges !== undefined && { requiredChanges: output.requiredChanges }),
  };
}
