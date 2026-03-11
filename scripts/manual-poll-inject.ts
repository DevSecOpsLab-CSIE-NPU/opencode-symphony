import { loadWorkflow } from "../src/workflow/loader";
import { OrchestratorEngine } from "../src/orchestrator/scheduler";
import { LinearClient } from "../src/linear/client";
import { WorkspaceManager } from "../src/workspace/WorkspaceManager";
import { LiquidRenderer } from "../src/workflow/LiquidRenderer";

async function main() {
  const workflow = await loadWorkflow("../WORKFLOW.md");
  const wf = workflow.frontMatter;

  const linear = new LinearClient(process.env.LINEAR_API_KEY ?? "", wf.linear.apiUrl);
  const workspaceManager = new WorkspaceManager({ rootDir: wf.workspace.root, strategy: "directory_only" });
  const liquidRenderer = new LiquidRenderer();

  const engine = new OrchestratorEngine({
    workflow,
    linear,
    commandDeps: {
      workspaceManager,
      agentClient: {
        startSession: async () => ({ sessionId: "manual-session" }),
        sendMessage: async () => ({ role: "assistant", content: "manual poll" }),
        closeSession: async () => {},
      } as never,
      liquidRenderer,
    },
  });

  const polledAt = new Date().toISOString();
  const issues = await linear.getActiveIssues({
    ...(wf.linear.teamIds ? { teamIds: wf.linear.teamIds } : {}),
    ...(wf.linear.states ? { states: wf.linear.states } : {}),
  });
  console.log("[manual-poll] issues", issues.length);
  for (const i of issues) {
    console.log(`[manual-poll] ${i.key} | ${i.state.name} | ${i.title}`);
  }

  const { commands } = engine.emitEvent({ type: "linear.polled", issues, polledAt });
  console.log("[manual-poll] commands from linear.polled", commands);

  const state = engine.getState();
  console.log("[manual-poll] state issuesById size", state.issuesById.size);
  console.log("[manual-poll] queuedIssueIds size", state.queuedIssueIds.size);
  console.log("[manual-poll] runningIssueIds size", state.runningIssueIds.size);

  const tickCommands = engine.runOnce();
  console.log("[manual-poll] commands from runOnce", tickCommands);
  const state2 = engine.getState();
  console.log("[manual-poll] after tick queuedIssueIds size", state2.queuedIssueIds.size);
  console.log("[manual-poll] after tick runningIssueIds size", state2.runningIssueIds.size);
}

main().catch((err) => {
  console.error("[manual-poll] error", err);
  process.exit(1);
});
