import path from "node:path";
import { access } from "node:fs/promises";

export type HookName = "after_create" | "before_run" | "after_run" | "before_remove";

export interface WorkspaceRef {
  identifier: string;
  absPath: string;
}

export interface HooksConfig {
  hooksDir: string;
  hookTimeoutMs?: number; // default 60_000
}

// ── Error types ──────────────────────────────────────────────────────────────

export class HookTimeoutError extends Error {
  override readonly name = "HookTimeoutError" as const;
  constructor(
    public readonly hookName: HookName,
    public readonly workspaceId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Hook "${hookName}" timed out after ${timeoutMs}ms (workspace: ${workspaceId})`);
  }
}

export class HookFailedError extends Error {
  override readonly name = "HookFailedError" as const;
  constructor(
    public readonly hookName: HookName,
    public readonly workspaceId: string,
    public readonly exitCode: number,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(
      `Hook "${hookName}" failed with exit code ${exitCode} (workspace: ${workspaceId})\nstderr: ${stderr.slice(-500)}`,
    );
  }
}

// ── Hook resolution ───────────────────────────────────────────────────────────

/**
 * Look for <hooksDir>/<hookName> or <hooksDir>/<hookName>.sh
 * Returns the path if found and executable, otherwise null.
 */
async function resolveHookPath(hooksDir: string, hookName: HookName): Promise<string | null> {
  const candidates = [path.join(hooksDir, hookName), path.join(hooksDir, `${hookName}.sh`)];
  for (const candidate of candidates) {
    try {
      // constants.X_OK = 1; check execute permission
      await access(candidate, 1);
      return candidate;
    } catch {
      // not found or not executable — try next
    }
  }
  return null;
}

// ── Core executor ─────────────────────────────────────────────────────────────

/**
 * Run a lifecycle hook for the given workspace.
 *
 * - If no hook file is found → silently skip (hooks are optional).
 * - Enforces a configurable timeout (default 60s); kills the process and throws HookTimeoutError on expiry.
 * - On non-zero exit → throws HookFailedError with captured stdout/stderr (last 2000 chars each).
 * - Hook receives WORKSPACE and WORKSPACE_ID env vars in addition to caller-supplied env.
 */
export async function runHook(
  hookName: HookName,
  ws: WorkspaceRef,
  env: Record<string, string>,
  cfg: HooksConfig,
): Promise<void> {
  const timeoutMs = cfg.hookTimeoutMs ?? 60_000;
  const MAX_CAPTURE = 2000;

  const hookPath = await resolveHookPath(cfg.hooksDir, hookName);
  if (hookPath === null) {
    // Hooks are optional — silently skip if not present
    return;
  }

  const proc = Bun.spawn([hookPath], {
    cwd: ws.absPath,
    env: {
      ...process.env,
      ...env,
      // Guaranteed env vars for every hook
      WORKSPACE: ws.absPath,
      WORKSPACE_ID: ws.identifier,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Collect output streams, capped at MAX_CAPTURE chars to avoid memory bloat
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  let stdoutLen = 0;
  let stderrLen = 0;

  async function drainStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    chunks: Uint8Array[],
  ): Promise<void> {
    while (true) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      chunks.push(value);
    }
  }

  // Set up timeout race
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const processPromise = (async (): Promise<number> => {
    const stdoutReader = proc.stdout.getReader();
    const stderrReader = proc.stderr.getReader();
    await Promise.all([
      drainStream(stdoutReader, stdoutChunks),
      drainStream(stderrReader, stderrChunks),
    ]);
    stdoutLen = stdoutChunks.reduce((n, c) => n + c.length, 0);
    stderrLen = stderrChunks.reduce((n, c) => n + c.length, 0);
    void stdoutLen; void stderrLen;
    return proc.exited;
  })();

  const result = await Promise.race([processPromise, timeoutPromise]);

  if (timeoutId !== null) clearTimeout(timeoutId);

  if (result === "timeout") {
    proc.kill();
    throw new HookTimeoutError(hookName, ws.identifier, timeoutMs);
  }

  const exitCode = result as number;
  const decoder = new TextDecoder();
  const stdoutFull = stdoutChunks.map((c) => decoder.decode(c)).join("");
  const stderrFull = stderrChunks.map((c) => decoder.decode(c)).join("");
  const stdoutStr = stdoutFull.slice(-MAX_CAPTURE);
  const stderrStr = stderrFull.slice(-MAX_CAPTURE);

  if (exitCode !== 0) {
    throw new HookFailedError(hookName, ws.identifier, exitCode, stdoutStr, stderrStr);
  }
}
