import { LinearClient } from "../src/linear/client";

async function main() {
  const apiKey = process.env.LINEAR_API_KEY ?? "";
  const linear = new LinearClient(apiKey);
  
  // Get all issues without state filter to see all
  const issues = await linear.getActiveIssues({
    teamIds: ["eb416549-880b-46c9-a19d-ca57eb64695b"],
  });
  
  // Find AUG-13
  const aug13 = issues.find(i => i.key === "AUG-13");
  if (aug13) {
    console.log("AUG-13 Details:");
    console.log(`  Key: ${aug13.key}`);
    console.log(`  Title: ${aug13.title}`);
    console.log(`  Description: ${aug13.description}`);
    console.log(`  State Name: ${aug13.state.name}`);
    console.log(`  State Type: ${aug13.state.type}`);
    console.log(`  URL: ${aug13.url}`);
    console.log(`  Priority: ${aug13.priority}`);
    console.log(`  Assignee: ${aug13.assignee?.name ?? "Unassigned"}`);
  } else {
    console.log("AUG-13 not found");
  }
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
