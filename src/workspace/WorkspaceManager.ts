import path from "node:path";
import { realpath, mkdir, rm, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkspaceRoot, WorkspacePath } from "../orchestrator/types.js";
import { runHook, type HookName, type WorkspaceRef, type HooksConfig } from "./hooks.js";

const execFileAsync = promisify(execFile);

// Suppress unused import warnings (these types are re-exported for consumers)
export type { WorkspaceRoot, WorkspacePath, HookName };

// ── Config ────────────────────────────────────────────────────────────────────

export type WorkspaceStrategy = "git_worktree" | "git_clone" | "directory_only";

export interface WorkspaceManagerConfig {
  rootDir: string;
  hooksDir?: string;
  hookTimeoutMs?: number;
  strategy: WorkspaceStrategy;
  repoDir?: string;
  baseRef?: string;
  cloneArgs?: string[];
}

// ── WorkspaceRef ──────────────────────────────────────────────────────────────

export type { WorkspaceRef };

export interface EnsureWorkspaceResult extends WorkspaceRef {
  created: boolean;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class PathTraversalError extends Error {
  constructor(candidate: string) {
    super(`Path traversal detected: ${candidate}`);
    this.name = "PathTraversalError";
  }
}

// ── WorkspaceManager ─────────────────────────────────────────────────────────

export class WorkspaceManager {
  private readonly cfg: WorkspaceManagerConfig;
  private readonly hooksConfig: HooksConfig | null;

  constructor(cfg: WorkspaceManagerConfig) {
    this.cfg = cfg;
    this.hooksConfig = cfg.hooksDir
      ? {
          hooksDir: cfg.hooksDir,
          ...(cfg.hookTimeoutMs !== undefined && { hookTimeoutMs: cfg.hookTimeoutMs }),
        }
      : null;
  }

  sanitizeIdentifier(raw: string): string {
    return (
      raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80) || "issue"
    );
  }

  async validatePath(candidate: string): Promise<string> {
    const normalized = path.normalize(candidate);
    if (normalized.includes("..")) {
      throw new PathTraversalError(candidate);
    }
    let realRoot: string;
    let realCandidate: string;
    try {
      realRoot = await realpath(this.cfg.rootDir);
    } catch {
      throw new PathTraversalError(`rootDir does not exist: ${this.cfg.rootDir}`);
    }
    try {
      realCandidate = await realpath(candidate);
    } catch {
      throw new PathTraversalError(`candidate does not exist: ${candidate}`);
    }
    if (!realCandidate.startsWith(realRoot + path.sep)) {
      throw new PathTraversalError(candidate);
    }
    return realCandidate;
  }

  async ensureWorkspace(params: {
    rawIdentifier: string;
    env?: Record<string, string>;
  }): Promise<EnsureWorkspaceResult> {
    const identifier = this.sanitizeIdentifier(params.rawIdentifier);
    const absPath = path.join(this.cfg.rootDir, identifier);

    let existed = false;
    try {
      await access(absPath);
      existed = true;
    } catch {
      // not found — will create
    }

    if (!existed) {
      await this.materialize(absPath);
      await this.validatePath(absPath);
    }

    const ws: WorkspaceRef = { identifier, absPath };
    if (!existed && this.hooksConfig) {
      await runHook("after_create", ws, params.env ?? {}, this.hooksConfig);
    }
    return { ...ws, created: !existed };
  }

  async prepareRun(ws: WorkspaceRef, env?: Record<string, string>): Promise<void> {
    if (this.hooksConfig) await runHook("before_run", ws, env ?? {}, this.hooksConfig);
  }

  async finalizeRun(ws: WorkspaceRef, env?: Record<string, string>): Promise<void> {
    if (this.hooksConfig) await runHook("after_run", ws, env ?? {}, this.hooksConfig);
  }

  async cleanupWorkspace(ws: WorkspaceRef, env?: Record<string, string>): Promise<void> {
    if (this.hooksConfig) await runHook("before_remove", ws, env ?? {}, this.hooksConfig);
    await this.dematerialize(ws.absPath);
  }

  private async materialize(absPath: string): Promise<void> {
    switch (this.cfg.strategy) {
      case "directory_only":
        await mkdir(absPath, { recursive: true });
        break;
      case "git_worktree": {
        const repoDir = this.cfg.repoDir;
        if (!repoDir) throw new Error("git_worktree strategy requires repoDir");
        await execFileAsync("git", ["-C", repoDir, "worktree", "add", absPath, this.cfg.baseRef ?? "HEAD"]);
        break;
      }
      case "git_clone": {
        const repoDir = this.cfg.repoDir;
        if (!repoDir) throw new Error("git_clone strategy requires repoDir");
        const args = ["clone", repoDir, absPath];
        if (this.cfg.baseRef) args.push("--branch", this.cfg.baseRef);
        if (this.cfg.cloneArgs) args.push(...this.cfg.cloneArgs);
        await execFileAsync("git", args);
        break;
      }
    }
  }

  private async dematerialize(absPath: string): Promise<void> {
    switch (this.cfg.strategy) {
      case "directory_only":
      case "git_clone":
        await rm(absPath, { recursive: true, force: true });
        break;
      case "git_worktree": {
        const repoDir = this.cfg.repoDir;
        if (!repoDir) { await rm(absPath, { recursive: true, force: true }); return; }
        try {
          await execFileAsync("git", ["-C", repoDir, "worktree", "remove", absPath, "--force"]);
        } catch {
          await rm(absPath, { recursive: true, force: true });
        }
        break;
      }
    }
  }
}
