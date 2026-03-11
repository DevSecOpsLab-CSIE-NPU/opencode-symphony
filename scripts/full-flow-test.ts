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
  
  // Step 1: Emit poll event
  const issues = await linear.getActiveIssues({
    teamIds: wf.linear.teamIds,
    states: wf.linear.states,
  });
  
  console.log(`\n=== STEP 1: POLL (${issues.length} issues) ===\n`);
  const pollResult = engine.emitEvent({
    type: "linear.polled",
    issues,
    polledAt: new Date().toISOString() as any,
  });
  
  let state = engine.getState();
  console.log(`Queued: ${state.queuedIssueIds.size}`);
  console.log(`Poll commands: ${pollResult.commands.length}`);
  
  // Step 2: Emit scheduler tick to dispatch
  console.log(`\n=== STEP 2: TICK (dispatch) ===\n`);
  const tickResult = engine.emitEvent({
    type: "scheduler.tick",
    now: new Date().toISOString() as any,
  });
  
  state = engine.getState();
  console.log(`Running: ${state.runningIssueIds.size}`);
  console.log(`Queued: ${state.queuedIssueIds.size}`);
  console.log(`Tick commands: ${tickResult.commands.length}`);
  for (const cmd of tickResult.commands) {
    console.log(`  - ${cmd.type}`);
    if (cmd.type === "spawn_and_run_worker") {
      const issue = state.issuesById.get(cmd.issueId);
      console.log(`    → ${issue?.key}`);
    }
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
