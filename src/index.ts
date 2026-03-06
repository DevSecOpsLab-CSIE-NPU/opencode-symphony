import { tool } from "@opencode-ai/plugin";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { join } from "node:path";
import { OrchestratorEngine } from "./orchestrator/scheduler.js";
import { LinearClient } from "./linear/client.js";
import { WorkspaceManager } from "./workspace/WorkspaceManager.js";
import { LiquidRenderer } from "./workflow/LiquidRenderer.js";
import { OpencodeSessionClient } from "./worker/OpenCodeAgentClient.js";
import { loadWorkflow } from "./workflow/loader.js";
import { watchWorkflow } from "./workflow/watcher.js";
import type {
  IssueId,
  SessionId,
  AttemptId,
  IsoDateTime,
  IssueLifecycleState,
} from "./orchestrator/types.js";

// Module-level singleton engine (one per plugin instance)
let engine: OrchestratorEngine | null = null;
let stopWatcher: (() => void) | null = null;

async function buildEngine(ctx: PluginInput, workflowPath: string): Promise<OrchestratorEngine> {
  const workflow = await loadWorkflow(workflowPath);
  const wf = workflow.frontMatter;

  const apiKey = process.env["LINEAR_API_KEY"] ?? "";
  const linear = new LinearClient(
    apiKey,
    ...(wf.linear.apiUrl !== undefined ? [wf.linear.apiUrl] : []),
  );

  const workspaceManager = new WorkspaceManager({
    rootDir: wf.workspace.root,
    strategy: "directory_only",
  });

  const agentClient = new OpencodeSessionClient(ctx.client);
  const liquidRenderer = new LiquidRenderer();

  return new OrchestratorEngine({
    workflow,
    linear,
    commandDeps: {
      workspaceManager,
      agentClient,
      liquidRenderer,
    },
  });
}

export const SymphonyPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      "symphony.start": tool({
        description: "Start the Symphony Orchestrator loop. Begins polling Linear and dispatching issues to Worker agents.",
        args: {
          workflowPath: tool.schema
            .string()
            .optional()
            .describe("Path to WORKFLOW.md (defaults to ./WORKFLOW.md in the project directory)"),
        },
        async execute(args) {
          if (engine !== null) {
            return JSON.stringify({ ok: false, error: "Already running" });
          }
          const wfPath = args.workflowPath ?? join(ctx.directory, "WORKFLOW.md");
          engine = await buildEngine(ctx, wfPath);
          engine.start();

          // Hot-reload watcher
          stopWatcher = watchWorkflow(wfPath, async (_content) => {
            try {
              const updated = await loadWorkflow(wfPath);
              engine?.reloadWorkflow(updated);
            } catch (err) {
              console.warn("[symphony] workflow reload failed, keeping last good config:", err);
            }
          });

          return JSON.stringify({ ok: true, status: "started", workflowPath: wfPath });
        },
      }),

      "symphony.stop": tool({
        description: "Stop the Symphony Orchestrator loop and all running Workers.",
        args: {},
        async execute(_args) {
          if (engine === null) {
            return JSON.stringify({ ok: false, error: "Not running" });
          }
          engine.stop();
          engine = null;
          if (stopWatcher !== null) {
            stopWatcher();
            stopWatcher = null;
          }
          return JSON.stringify({ ok: true, status: "stopped" });
        },
      }),

      "symphony.status": tool({
        description: "Get a lightweight snapshot of the Orchestrator state.",
        args: {},
        async execute(_args) {
          if (engine === null) {
            return JSON.stringify({
              isRunning: false,
              workflow: null,
              concurrency: { maxConcurrentAgents: 0, running: 0, queued: 0 },
              counts: { issues: 0, sessions: 0, attempts: 0, retries: 0 },
            });
          }
          const s = engine.getState();
          return JSON.stringify({
            isRunning: s.isRunning,
            workflow: {
              path: s.workflow.path,
              revision: s.workflow.revision,
              loadedAt: s.workflow.loadedAt,
            },
            concurrency: {
              maxConcurrentAgents: s.maxConcurrentAgents,
              running: s.runningIssueIds.size,
              queued: s.queuedIssueIds.size,
            },
            counts: {
              issues: s.issuesById.size,
              sessions: s.sessionsById.size,
              attempts: s.attemptsById.size,
              retries: s.retryByIssueId.size,
            },
          });
        },
      }),

      "symphony.listIssues": tool({
        description: "List tracked issues and their lifecycle states.",
        args: {
          stateKinds: tool.schema
            .array(
              tool.schema.enum([
                "discovered",
                "queued",
                "running",
                "awaiting_review",
                "reviewing",
                "needs_changes",
                "succeeded",
                "failed",
                "retry_wait",
              ]),
            )
            .optional()
            .describe("Filter by lifecycle state kinds"),
          limit: tool.schema.number().optional().describe("Maximum number of issues to return"),
        },
        async execute(args) {
          if (engine === null) {
            return JSON.stringify({ issues: [] });
          }
          const s = engine.getState();
          const filter = args.stateKinds as IssueLifecycleState["kind"][] | undefined;
          const limit = args.limit ?? 100;

          const issues: unknown[] = [];
          for (const [id, issue] of s.issuesById) {
            const lc = s.issueLifecycleById.get(id);
            if (filter !== undefined && (lc === undefined || !filter.includes(lc.kind))) {
              continue;
            }
            issues.push({
              id: issue.id,
              key: issue.key,
              title: issue.title,
              url: issue.url,
              state: issue.state,
              lifecycle: lc,
            });
            if (issues.length >= limit) break;
          }
          return JSON.stringify({ issues });
        },
      }),

      "symphony.reloadWorkflow": tool({
        description: "Force reload WORKFLOW.md without restarting the Orchestrator.",
        args: {
          workflowPath: tool.schema
            .string()
            .optional()
            .describe("Path to WORKFLOW.md (defaults to current workflow path)"),
        },
        async execute(args) {
          if (engine === null) {
            return JSON.stringify({ ok: false, error: "Not running" });
          }
          const s = engine.getState();
          const wfPath = args.workflowPath ?? s.workflow.path;
          try {
            const updated = await loadWorkflow(wfPath);
            engine.reloadWorkflow(updated);
            return JSON.stringify({ ok: true, revision: updated.revision, path: wfPath });
          } catch (err) {
            return JSON.stringify({ ok: false, error: String(err) });
          }
        },
      }),

      "symphony.runOnce": tool({
        description: "Debug: manually trigger one Orchestrator scheduler tick.",
        args: {},
        async execute(_args) {
          if (engine === null) {
            return JSON.stringify({ ok: false, error: "Not running" });
          }
          const commands = engine.runOnce();
          return JSON.stringify({ ok: true, commandsExecuted: commands.length, commands });
        },
      }),

      "symphony.retryIssue": tool({
        description: "Manually retry a specific issue.",
        args: {
          issueId: tool.schema.string().describe("Linear issue ID to retry"),
          reason: tool.schema.string().describe("Reason for manual retry"),
        },
        async execute(args) {
          if (engine === null) {
            return JSON.stringify({ ok: false, error: "Not running" });
          }
          const at = new Date().toISOString() as IsoDateTime;
          engine.emitEvent({
            type: "manual.retry_issue",
            issueId: args.issueId as IssueId,
            reason: args.reason,
            at,
          });
          return JSON.stringify({ ok: true });
        },
      }),

      "symphony.inspect": tool({
        description: "Debug: inspect detailed state of an issue, session, or attempt.",
        args: {
          issueId: tool.schema.string().optional().describe("Issue ID to inspect"),
          sessionId: tool.schema.string().optional().describe("Session ID to inspect"),
          attemptId: tool.schema.string().optional().describe("Attempt ID to inspect"),
        },
        async execute(args) {
          if (engine === null) {
            return JSON.stringify({ found: false, reason: "Engine not running" });
          }
          const s = engine.getState();

          if (args.issueId !== undefined) {
            const issue = s.issuesById.get(args.issueId as IssueId);
            const lc = s.issueLifecycleById.get(args.issueId as IssueId);
            const attemptIds = s.attemptIdsByIssueId.get(args.issueId as IssueId) ?? [];
            const attempts = attemptIds.map((id) => s.attemptsById.get(id));
            return JSON.stringify({ found: issue !== undefined, issue, lifecycle: lc, attempts });
          }

          if (args.sessionId !== undefined) {
            const session = s.sessionsById.get(args.sessionId as SessionId);
            return JSON.stringify({ found: session !== undefined, session });
          }

          if (args.attemptId !== undefined) {
            const attempt = s.attemptsById.get(args.attemptId as AttemptId);
            return JSON.stringify({ found: attempt !== undefined, attempt });
          }

          return JSON.stringify({ found: false, reason: "No query parameter provided" });
        },
      }),
    },
  };
};

export default SymphonyPlugin;
