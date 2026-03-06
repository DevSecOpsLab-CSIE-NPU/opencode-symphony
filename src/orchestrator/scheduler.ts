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

  constructor(
    private readonly callbacks: SchedulerCallbacks,
    private readonly tickIntervalMs: number = 500,
    private readonly pollIntervalMs: number = 30_000,
  ) {}

  start(): void {
    // Scheduler tick — promotes retry_wait entries that are now due, dispatches queued issues
    this.tickTimer = setInterval(() => {
      const now = new Date().toISOString() as IsoDateTime;
      const { commands } = this.callbacks.onEvent({ type: "scheduler.tick", now });
      void this.callbacks.executeCommands(commands);
    }, this.tickIntervalMs);

    // Linear poller — fail-open: LinearUnavailableError is swallowed (logged only)
    this.pollTimer = setInterval(() => {
      void (async () => {
        const polledAt = new Date().toISOString() as IsoDateTime;
        try {
          const issues = await this.callbacks.pollLinear();
          const { commands } = this.callbacks.onEvent({ type: "linear.polled", issues, polledAt });
          await this.callbacks.executeCommands(commands);
        } catch (err) {
          if (err instanceof LinearUnavailableError) {
            // Transient / rate-limit: log and continue
            console.warn("[Scheduler] Linear temporarily unavailable:", err.message);
          } else {
            // Fatal / unexpected error — still log but don’t crash
            console.error("[Scheduler] Linear poll error:", err);
          }
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
      emitEvent: (evt) => { this.emitEvent(evt); },
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

  /** Apply an event through the pure reducer, then execute resulting commands. */
  emitEvent(evt: OrchestratorEvent): { state: OrchestratorState; commands: OrchestratorCommand[] } {
    const result = applyEvent(this.state, evt);
    this.state = result.state;
    void executeCommands(result.commands, this.deps);
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
    const { commands } = this.emitEvent({ type: "scheduler.tick", now });
    return commands;
  }
}
