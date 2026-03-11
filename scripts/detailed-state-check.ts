import { loadWorkflow } from "../src/workflow/loader";
import { LinearClient } from "../src/linear/client";
import { OrchestratorEngine } from "../src/orchestrator/scheduler";
import { WorkspaceManager } from "../src/workspace/WorkspaceManager";
import { OpencodeSessionClient } from "../src/worker/OpenCodeAgentClient";
import { LiquidRenderer } from "../src/workflow/LiquidRenderer";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { join } from "node:path";

async function main() {
  const workflowPath = join(process.cwd(), "../WORKFLOW.md");
  const workflow = await loadWorkflow(workflowPath);
  const wf = workflow.frontMatter;
  
  const apiKey = process.env.LINEAR_API_KEY ?? "";
  const linear = new LinearClient(apiKey);
  
  const workspaceManager = new WorkspaceManager({
    rootDir: wf.workspace.root,
    strategy: "directory_only",
  });
  
  const opencodeBaseURL = process.env.OPENCODE_BASE_URL ?? "http://localhost:4096";
  const opencodeClient = createOpencodeClient({ baseUrl: opencodeBaseURL });
  const agentClient = new OpencodeSessionClient(
    opencodeClient as never,
    "build",
    process.env.OPENCODE_MODEL ?? "gpt-4o-mini",
  );
  
  const liquidRenderer = new LiquidRenderer();
  
  const engine = new OrchestratorEngine({
    workflow,
    linear,
    commandDeps: {
      workspaceManager,
      agentClient,
      liquidRenderer,
    },
  });
  
  // Emit a poll event with current issues
  const issues = await linear.getActiveIssues({
    teamIds: wf.linear.teamIds,
    states: wf.linear.states,
  });
  
  console.log(`\n=== Polled ${issues.length} issues ===\n`);
  for (const issue of issues) {
    console.log(`${issue.key} | ${issue.state.name} | ${issue.title}`);
  }
  
  // Apply the poll event
  const result = engine.emitEvent({
    type: "linear.polled",
    issues,
    polledAt: new Date().toISOString() as any,
  });
  
  const state = engine.getState();
  
  console.log(`\n=== Orchestrator State After Poll ===\n`);
  console.log(`Total issues tracked: ${state.issuesById.size}`);
  console.log(`Running: ${state.runningIssueIds.size}`);
  console.log(`Queued: ${state.queuedIssueIds.size}`);
  console.log(`Retry waiting: ${state.retryByIssueId.size}`);
  console.log(`Sessions: ${state.sessionsById.size}`);
  
  console.log(`\n=== Issue Lifecycles ===\n`);
  for (const [issueId, lifecycle] of state.issueLifecycleById.entries()) {
    const issue = state.issuesById.get(issueId);
    const key = issue?.key ?? "UNKNOWN";
    console.log(`${key}: ${lifecycle.kind}`);
  }
  
  console.log(`\n=== Commands Generated ===\n`);
  console.log(`Commands: ${result.commands.length}`);
  for (const cmd of result.commands) {
    console.log(`  - ${cmd.type}`);
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  console.error(err.stack);
  process.exit(1);
});
