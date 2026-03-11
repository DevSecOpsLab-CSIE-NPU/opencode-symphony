// src/orchestrator/scheduler.ts — Scheduler loop, Linear poller, OrchestratorEngine

import type {
  OrchestratorState,
  OrchestratorEvent,
  IsoDateTime,
  WorkflowDefinition,
} from "./types.js";
import type { OrchestratorCommand } from "./state.js";
import { applyEvent } from "./state.js";
import type { LinearClient } from "../linear/client.js";
import { LinearUnavailableError } from "../linear/client.js";
import type { CommandDeps } from "./commands.js";
import { executeCommands } from "./commands.js";

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler — low-level tick + poll timers
// ─────────────────────────────────────────────────────────────────────────────

export type SchedulerCallbacks = {
  onEvent(evt: OrchestratorEvent): { state: OrchestratorState; commands: OrchestratorCommand[] };
  executeCommands(commands: OrchestratorCommand[]): Promise<void>;
  pollLinear(): Promise<import("./types.js").LinearIssue[]>;
};

export class Scheduler {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isTickRunning = false;
  private isPollRunning = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly callbacks: SchedulerCallbacks,
    private readonly tickIntervalMs: number = 500,
    private readonly pollIntervalMs: number = 30_000,
  ) {}

  start(): void {
    console.log("[Scheduler] start: tickIntervalMs=%d pollIntervalMs=%d", this.tickIntervalMs, this.pollIntervalMs);
    // Scheduler tick — promotes retry_wait entries that are now due, dispatches queued issues
    this.tickTimer = setInterval(async () => {
      if (this.isTickRunning) {
        console.log("[Scheduler] tick already running, skipping");
        return;
      }
      this.isTickRunning = true;
      try {
        const now = new Date().toISOString() as IsoDateTime;
        console.log("[Scheduler] tick at", now);
        const { commands } = this.callbacks.onEvent({ type: "scheduler.tick", now });
        console.log("[Scheduler] tick produced", commands.length, "commands");
        await this.callbacks.executeCommands(commands);
      } finally {
        this.isTickRunning = false;
      }
    }, this.tickIntervalMs);

    // Linear poller — fail-open: LinearUnavailableError is swallowed (logged only)
    this.pollTimer = setInterval(() => {
      void (async () => {
        if (this.isPollRunning) {
          console.log("[Scheduler] poll already running, skipping");
          return;
        }
        this.isPollRunning = true;
        try {
          const polledAt = new Date().toISOString() as IsoDateTime;
          console.log("[Scheduler] poll timer fired at", polledAt);
          console.log("[Scheduler] pollLinear at", polledAt);
          const issues = await this.callbacks.pollLinear();
          console.log("[Scheduler] pollLinear returned", issues.length, "issues");
          const { commands } = this.callbacks.onEvent({ type: "linear.polled", issues, polledAt });
          console.log("[Scheduler] linear.polled produced", commands.length, "commands");
          await this.callbacks.executeCommands(commands);
        } catch (err) {
          if (err instanceof LinearUnavailableError) {
            console.warn("[Scheduler] Linear temporarily unavailable:", err.message);
          } else {
            console.error("[Scheduler] Linear poll error:", err);
          }
        } finally {
          this.isPollRunning = false;
        }
      })();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OrchestratorEngine — top-level facade wiring state + scheduler + commands
// ─────────────────────────────────────────────────────────────────────────────

export interface OrchestratorEngineOptions {
  workflow: WorkflowDefinition;
  linear: LinearClient;
  commandDeps: Omit<CommandDeps, "getState" | "emitEvent" | "linear">;
  /** Tick interval override (default: 500ms) */
  tickIntervalMs?: number;
}

/**
 * OrchestratorEngine ties together the pure reducer (applyEvent),
 * the side-effect executor (executeCommands), and the two timers (tick + poll).
 *
 * Usage:
 *   const engine = new OrchestratorEngine({ workflow, linear, commandDeps });
 *   engine.start();
 *   // ... call engine.emitEvent() from MCP tools
 *   engine.stop();
 */
export class OrchestratorEngine {
  private state: OrchestratorState;
  private readonly scheduler: Scheduler;
  private readonly deps: CommandDeps;

  constructor(private readonly opts: OrchestratorEngineOptions) {
    const wf = opts.workflow;
    this.state = {
      workflow: wf,
      issuesById: new Map(),
      issueLifecycleById: new Map(),
      maxConcurrentAgents: wf.frontMatter.workspace.maxConcurrentAgents,
      runningIssueIds: new Set(),
      queuedIssueIds: new Set(),
      retryByIssueId: new Map(),
      sessionsById: new Map(),
      sessionIdByIssueId: new Map(),
      attemptsById: new Map(),
      attemptIdsByIssueId: new Map(),
      inflightRpc: new Map(),
      startedAt: new Date().toISOString() as IsoDateTime,
      isRunning: false,
    };

    this.deps = {
      ...opts.commandDeps,
      getState: () => this.state,
      emitEvent: (evt) => this.emitEvent(evt),
      linear: opts.linear,
    };

    this.scheduler = new Scheduler(
      {
        onEvent: (evt) => this.emitEvent(evt),
        executeCommands: (cmds) => executeCommands(cmds, this.deps),
        pollLinear: () =>
          opts.linear.getActiveIssues({
            ...(wf.frontMatter.linear.teamIds !== undefined && {
              teamIds: wf.frontMatter.linear.teamIds,
            }),
            ...(wf.frontMatter.linear.states !== undefined && {
              states: wf.frontMatter.linear.states,
            }),
          }),
      },
      opts.tickIntervalMs ?? 500,
      wf.frontMatter.linear.pollIntervalMs,
    );
  }

  /** Start the scheduler loops. */
  start(): void {
    this.state.isRunning = true;
    this.scheduler.start();
  }

  /** Stop the scheduler loops and mark engine as stopped. */
  stop(): void {
    this.scheduler.stop();
    this.state.isRunning = false;
  }

  /** Apply an event through the pure reducer. Commands returned for caller to execute. */
  emitEvent(evt: OrchestratorEvent): { state: OrchestratorState; commands: OrchestratorCommand[] } {
    const result = applyEvent(this.state, evt);
    this.state = result.state;
    return result;
  }

  /** Read-only view of current state (for MCP tools). */
  getState(): OrchestratorState {
    return this.state;
  }

  /** Force a hot-reload of the workflow definition. */
  reloadWorkflow(workflow: WorkflowDefinition): void {
    this.emitEvent({ type: "workflow.reloaded", workflow });
  }

  /** Run one scheduler tick manually (for debugging). */
  runOnce(): OrchestratorCommand[] {
    const now = new Date().toISOString() as IsoDateTime;
    console.log("[Scheduler] runOnce tick at", now);
    const { commands } = this.emitEvent({ type: "scheduler.tick", now });
    console.log("[Scheduler] runOnce produced", commands.length, "commands");
    return commands;
  }
}
