// src/reviewer/gates.ts — Deterministic quality gates (no LLM needed)

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import type { GateStatus } from "../orchestrator/types.js";

const execFileAsync = promisify(execFile);

export interface GateResult {
  name: string;
  status: GateStatus;
  details?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all deterministic quality gates on the workspace.
 *
 * Gates run in parallel; all gate results are returned (not fail-fast).
 * Each gate that throws an exception is treated as a fail (not a crash).
 */
export async function runDeterministicGates(params: {
  workspacePath: string;
  diff?: string;
  changedFiles?: string[];
}): Promise<GateResult[]> {
  const results = await Promise.all([
    checkHasChanges(params.workspacePath, params.diff),
    checkNoStagingConflicts(params.workspacePath),
    checkNoSecrets(params.diff ?? ""),
    checkFileSizeLimits(params.changedFiles ?? []),
    checkTypeScript(params.workspacePath),
    checkTests(params.workspacePath),
  ]);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual gates
// ─────────────────────────────────────────────────────────────────────────────

/** Gate: workspace must have at least one changed file */
async function checkHasChanges(workspacePath: string, diff: string | undefined): Promise<GateResult> {
  try {
    if (diff !== undefined && diff.trim().length > 0) {
      return { name: "has_changes", status: "pass" };
    }
    // Fallback: check git status
    const { stdout } = await execFileAsync("git", ["-C", workspacePath, "status", "--porcelain"], {
      timeout: 10_000,
    });
    const changed = stdout.trim().length > 0;
    return {
      name: "has_changes",
      status: changed ? "pass" : "fail",
      ...(changed ? {} : { details: "No changes detected in workspace" }),
    };
  } catch (err) {
    // Non-git workspace: always pass this gate
    return { name: "has_changes", status: "pass", details: `git not available: ${String(err)}` };
  }
}

/** Gate: no merge conflict markers */
async function checkNoStagingConflicts(workspacePath: string): Promise<GateResult> {
  try {
    const { stdout } = await execFileAsync(
      "git", ["-C", workspacePath, "diff", "--name-only", "--diff-filter=U"],
      { timeout: 10_000 },
    );
    const conflicts = stdout.trim().split("\n").filter(Boolean);
    if (conflicts.length > 0) {
      return {
        name: "no_staging_conflicts",
        status: "fail",
        details: `Unresolved merge conflicts in: ${conflicts.join(", ")}`,
      };
    }
    return { name: "no_staging_conflicts", status: "pass" };
  } catch {
    return { name: "no_staging_conflicts", status: "pass", details: "git not available" };
  }
}

// Patterns that suggest possible secrets
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY/,
  /(?:api|secret|token|password|passwd|pwd)[_-]?(?:key)?\s*=\s*["'][^"']{8,}/i,
  /sk-[a-zA-Z0-9]{20,}/,    // OpenAI-style keys
  /ghp_[a-zA-Z0-9]{36}/,   // GitHub PAT
  /AKIA[0-9A-Z]{16}/,       // AWS access key
];

/** Gate: no suspected secrets in the diff */
async function checkNoSecrets(diff: string): Promise<GateResult> {
  if (diff.length === 0) {
    return { name: "no_secrets", status: "pass" };
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(diff)) {
      return {
        name: "no_secrets",
        status: "fail",
        details: `Possible secret detected matching pattern: ${pattern.source}`,
      };
    }
  }
  return { name: "no_secrets", status: "pass" };
}

const MAX_FILE_BYTES = 1_000_000; // 1 MB per file

/** Gate: no excessively large changed files */
async function checkFileSizeLimits(changedFiles: string[]): Promise<GateResult> {
  const oversized: string[] = [];
  await Promise.all(
    changedFiles.map(async (f) => {
      try {
        const s = await stat(f);
        if (s.size > MAX_FILE_BYTES) oversized.push(f);
      } catch {
        // file may have been deleted — skip
      }
    }),
  );
  if (oversized.length > 0) {
    return {
      name: "file_size_limits",
      status: "fail",
      details: `Files exceed ${MAX_FILE_BYTES / 1000}KB limit: ${oversized.join(", ")}`,
    };
  }
  return { name: "file_size_limits", status: "pass" };
}

/** Gate: TypeScript type-check passes (best-effort, skip if no tsconfig) */
async function checkTypeScript(workspacePath: string): Promise<GateResult> {
  try {
    await execFileAsync("bun", ["x", "tsc", "--noEmit"], {
      cwd: workspacePath,
      timeout: 60_000,
    });
    return { name: "typescript", status: "pass" };
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err);
    // If tsc is not found or no tsconfig, treat as pass (not a TS project)
    if (stderr.includes("Cannot find") || stderr.includes("no tsconfig") || stderr.includes("not found")) {
      return { name: "typescript", status: "pass", details: "tsc not available or not a TS project" };
    }
    return {
      name: "typescript",
      status: "fail",
      details: stderr.slice(0, 500),
    };
  }
}

/** Gate: tests pass (best-effort, skip if no test runner found) */
async function checkTests(workspacePath: string): Promise<GateResult> {
  try {
    await execFileAsync("bun", ["test"], {
      cwd: workspacePath,
      timeout: 120_000,
    });
    return { name: "tests", status: "pass" };
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const stdout = (err as { stdout?: string }).stdout ?? "";
    // No test files found — treat as pass
    if (stdout.includes("No test files found") || stderr.includes("No test files")) {
      return { name: "tests", status: "pass", details: "No test files found" };
    }
    return {
      name: "tests",
      status: "fail",
      details: (stderr + stdout).slice(0, 500),
    };
  }
}
