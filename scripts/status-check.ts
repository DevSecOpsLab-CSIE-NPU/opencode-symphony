import { loadWorkflow } from "../src/workflow/loader";
import { LinearClient } from "../src/linear/client";
import { OrchestratorEngine } from "../src/orchestrator/scheduler";
import { WorkspaceManager } from "../src/workspace/WorkspaceManager";
import { OpencodeSessionClient } from "../src/worker/OpenCodeAgentClient";
import { LiquidRenderer } from "../src/workflow/LiquidRenderer";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { join } from "node:path";

async function main() {
  try {
    const workflowPath = join(process.cwd(), "../WORKFLOW.md");
    const workflow = await loadWorkflow(workflowPath);
    const wf = workflow.frontMatter;
    
    const apiKey = process.env.LINEAR_API_KEY ?? "";
    const linear = new LinearClient(apiKey);
    
    // Get current issues from Linear
    const issues = await linear.getActiveIssues({
      teamIds: wf.linear.teamIds,
      states: wf.linear.states,
    });
    
    console.log("=== CURRENT STATUS ===\n");
    
    // 1. Linear Status
    console.log("1. LINEAR (Issues Found):");
    console.log(`   Total: ${issues.length}`);
    for (const issue of issues) {
      console.log(`   - ${issue.key} | ${issue.state.name}`);
    }
    
    // 2. Orchestrator Status
    console.log("\n2. ORCHESTRATOR (Empty - Not running):");
    console.log("   Run 'symphony.start' to begin processing");
    
    // 3. Configuration
    console.log("\n3. CONFIGURATION:");
    console.log(`   Max Concurrent Workers: ${wf.workspace.maxConcurrentAgents}`);
    console.log(`   Monitored States: ${wf.linear.states.join(", ")}`);
    console.log(`   Poll Interval: ${wf.linear.pollIntervalMs}ms`);
    
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
