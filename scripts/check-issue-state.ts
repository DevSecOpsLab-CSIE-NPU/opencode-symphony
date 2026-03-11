import { LinearClient } from "../src/linear/client";

async function main() {
  const apiKey = process.env.LINEAR_API_KEY ?? "";
  const linear = new LinearClient(apiKey);
  
  // Get all issues and find AUG-10
  const issues = await linear.getActiveIssues({
    teamIds: ["eb416549-880b-46c9-a19d-ca57eb64695b"],
  });
  
  console.log("All issues (no state filter):");
  for (const issue of issues) {
    console.log(`  ${issue.key} | ${issue.state.name} (type: ${issue.state.type}) | ${issue.title}`);
    if (issue.key === "AUG-10") {
      console.log(`    ^^^ THIS IS AUG-10`);
    }
  }
  
  // Also get workflow states
  const states = await linear.getWorkflowStates("eb416549-880b-46c9-a19d-ca57eb64695b");
  console.log("\nWorkflow States for AUG team:");
  for (const s of states) {
    console.log(`  ${s.name} (type: ${s.type})`);
  }
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
