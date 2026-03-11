import { loadWorkflow } from "../src/workflow/loader";
import { join } from "node:path";

async function main() {
  const workflowPath = join(process.cwd(), "../WORKFLOW.md");
  const workflow = await loadWorkflow(workflowPath);
  
  console.log("=== WORKFLOW CONFIGURATION ===\n");
  
  console.log("1. Linear Polling Configuration:");
  console.log(`   Team IDs: ${workflow.frontMatter.linear.teamIds}`);
  console.log(`   States monitored: ${workflow.frontMatter.linear.states}`);
  console.log(`   Poll interval: ${workflow.frontMatter.linear.pollIntervalMs}ms`);
  
  console.log("\n2. Retry Configuration:");
  console.log(`   Max attempts: ${workflow.frontMatter.retry.maxAttempts}`);
  console.log(`   Max backoff: ${workflow.frontMatter.retry.maxRetryBackoffMs}ms`);
  
  console.log("\n3. Workspace Configuration:");
  console.log(`   Max concurrent agents: ${workflow.frontMatter.workspace.maxConcurrentAgents}`);
  
  console.log("\n4. Worker Instructions:");
  console.log(`   ${workflow.instructions.split('\n').slice(0, 5).join('\n   ')}`);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
