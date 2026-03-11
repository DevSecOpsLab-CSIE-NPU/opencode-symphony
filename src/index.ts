// src/index.ts — MCP stdio server for Symphony Orchestrator
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadWorkflow } from "./workflow/loader.js";
import { watchWorkflow } from "./workflow/watcher.js";
import { OrchestratorEngine } from "./orchestrator/scheduler.js";
import { LinearClient } from "./linear/client.js";
import { WorkspaceManager } from "./workspace/WorkspaceManager.js";
import { LiquidRenderer } from "./workflow/LiquidRenderer.js";
import type { IssueId, SessionId, AttemptId, IsoDateTime, IssueLifecycleState } from "./orchestrator/types.js";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { OpencodeSessionClient } from "./worker/OpenCodeAgentClient.js";

// Module-level singleton engine
let engine: OrchestratorEngine | null = null;
let stopWatcher: (() => void) | null = null;
let engineInstanceTag: string | null = null;

const DEFAULT_WORKFLOW_PATH = join(process.cwd(), "WORKFLOW.md");

async function buildEngine(workflowPath: string): Promise<OrchestratorEngine> {
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

  const opencodeBaseURL = process.env["OPENCODE_BASE_URL"] ?? "http://localhost:4096";
  const opencodeClient = createOpencodeClient({ baseUrl: opencodeBaseURL });
  const agentClient = new OpencodeSessionClient(
    opencodeClient as never,
    "build",
    process.env["OPENCODE_MODEL"] ?? "gpt-4o-mini",
  );

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

// Create MCP server
const server = new McpServer({
  name: "symphony",
  version: "0.1.0",
});

// Register symphony.start tool
server.registerTool(
  "symphony.start",
  {
    description: "Start the Symphony Orchestrator loop. Begins polling Linear and dispatching issues to Worker agents.",
    inputSchema: {
      workflowPath: z.string().optional().describe("Path to WORKFLOW.md (defaults to ./WORKFLOW.md in the project directory)"),
    },
  },
  async (args) => {
    if (engine !== null) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Already running" }) }] };
    }
    const wfPath = args.workflowPath ?? DEFAULT_WORKFLOW_PATH;

    try {
      engine = await buildEngine(wfPath);
      engineInstanceTag = `eng-${Date.now()}`;
      console.log("[symphony] start", { engineInstanceTag, workflowPath: wfPath });
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

      return { content: [{ type: "text", text: JSON.stringify({ ok: true, status: "started", workflowPath: wfPath }) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }] };
    }
  }
);

// Register symphony.stop tool
server.registerTool(
  "symphony.stop",
  {
    description: "Stop the Symphony Orchestrator loop and all running Workers.",
    inputSchema: {},
  },
  async () => {
    if (engine === null) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Not running" }) }] };
    }
    engine.stop();
    engine = null;
    if (stopWatcher !== null) {
      stopWatcher();
      stopWatcher = null;
    }
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, status: "stopped" }) }] };
  }
);

// Register symphony.status tool
server.registerTool(
  "symphony.status",
  {
    description: "Get a lightweight snapshot of the Orchestrator state.",
    inputSchema: {},
  },
  async () => {
    if (engine === null) {
      return { content: [{ type: "text", text: JSON.stringify({
        isRunning: false,
        workflow: null,
        concurrency: { maxConcurrentAgents: 0, running: 0, queued: 0 },
        counts: { issues: 0, sessions: 0, attempts: 0, retries: 0 },
      })}] };
    }
    const s = engine.getState();
    return { content: [{ type: "text", text: JSON.stringify({
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
    })}] };
  }
);

// Register symphony.listIssues tool
server.registerTool(
  "symphony.listIssues",
  {
    description: "List tracked issues and their lifecycle states.",
    inputSchema: {
      stateKinds: z.array(z.enum([
        "discovered",
        "queued",
        "running",
        "awaiting_review",
        "reviewing",
        "needs_changes",
        "succeeded",
        "failed",
        "retry_wait",
      ])).optional().describe("Filter by lifecycle state kinds"),
      limit: z.number().optional().describe("Maximum number of issues to return"),
    },
  },
  async (args) => {
    if (engine === null) {
      return { content: [{ type: "text", text: JSON.stringify({ issues: [] }) }] };
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
    return { content: [{ type: "text", text: JSON.stringify({ issues }) }] };
  }
);

// Register symphony.reloadWorkflow tool
server.registerTool(
  "symphony.reloadWorkflow",
  {
    description: "Force reload WORKFLOW.md without restarting the Orchestrator.",
    inputSchema: {
      workflowPath: z.string().optional().describe("Path to WORKFLOW.md (defaults to current workflow path)"),
    },
  },
  async (args) => {
    if (engine === null) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Not running" }) }] };
    }
    const s = engine.getState();
    const wfPath = args.workflowPath ?? s.workflow.path;
    try {
      const updated = await loadWorkflow(wfPath);
      engine.reloadWorkflow(updated);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, revision: updated.revision, path: wfPath }) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }] };
    }
  }
);

// Register symphony.runOnce tool
server.registerTool(
  "symphony.runOnce",
  {
    description: "Debug: manually trigger one Orchestrator scheduler tick.",
    inputSchema: {},
  },
  async () => {
    if (engine === null) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Not running" }) }] };
    }
    const commands = engine.runOnce();
    console.log("[symphony] runOnce", { engineInstanceTag, commands: commands.length });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, commandsExecuted: commands.length, commands }) }] };
  }
);

server.registerTool(
  "symphony.pollNow",
  {
    description: "Debug: manually poll Linear and inject issues into the orchestrator state.",
    inputSchema: {},
  },
  async () => {
    if (engine === null) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Not running" }) }] };
    }
    console.log("[symphony] pollNow", { engineInstanceTag });
    const polledAt = new Date().toISOString() as IsoDateTime;
    const issues = await engine["deps"].linear.getActiveIssues({
      ...(engine.getState().workflow.frontMatter.linear.teamIds !== undefined && {
        teamIds: engine.getState().workflow.frontMatter.linear.teamIds,
      }),
      ...(engine.getState().workflow.frontMatter.linear.states !== undefined && {
        states: engine.getState().workflow.frontMatter.linear.states,
      }),
    });
    const { commands } = engine.emitEvent({ type: "linear.polled", issues, polledAt });
    console.log("[symphony] pollNow result", { issues: issues.length, commands: commands.length });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, issues: issues.length, commandsExecuted: commands.length, commands }) }] };
  }
);

// Register symphony.retryIssue tool
server.registerTool(
  "symphony.retryIssue",
  {
    description: "Manually retry a specific issue.",
    inputSchema: {
      issueId: z.string().describe("Linear issue ID to retry"),
      reason: z.string().describe("Reason for manual retry"),
    },
  },
  async (args) => {
    if (engine === null) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Not running" }) }] };
    }
    const at = new Date().toISOString() as IsoDateTime;
    engine.emitEvent({
      type: "manual.retry_issue",
      issueId: args.issueId as IssueId,
      reason: args.reason,
      at,
    });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  }
);

// Register symphony.inspect tool
server.registerTool(
  "symphony.inspect",
  {
    description: "Debug: inspect detailed state of an issue, session, or attempt.",
    inputSchema: {
      issueId: z.string().optional().describe("Issue ID to inspect"),
      sessionId: z.string().optional().describe("Session ID to inspect"),
      attemptId: z.string().optional().describe("Attempt ID to inspect"),
    },
  },
  async (args) => {
    if (engine === null) {
      return { content: [{ type: "text", text: JSON.stringify({ found: false, reason: "Engine not running" }) }] };
    }
    const s = engine.getState();

    if (args.issueId !== undefined) {
      const issue = s.issuesById.get(args.issueId as IssueId);
      const lc = s.issueLifecycleById.get(args.issueId as IssueId);
      const attemptIds = s.attemptIdsByIssueId.get(args.issueId as IssueId) ?? [];
      const attempts = attemptIds.map((id) => s.attemptsById.get(id));
      return { content: [{ type: "text", text: JSON.stringify({ found: issue !== undefined, issue, lifecycle: lc, attempts }) }] };
    }

    if (args.sessionId !== undefined) {
      const session = s.sessionsById.get(args.sessionId as SessionId);
      return { content: [{ type: "text", text: JSON.stringify({ found: session !== undefined, session }) }] };
    }

    if (args.attemptId !== undefined) {
      const attempt = s.attemptsById.get(args.attemptId as AttemptId);
      return { content: [{ type: "text", text: JSON.stringify({ found: attempt !== undefined, attempt }) }] };
    }

    return { content: [{ type: "text", text: JSON.stringify({ found: false, reason: "No query parameter provided" }) }] };
  }
);

// Start the server with stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
