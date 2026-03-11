import { LinearClient } from "../src/linear/client";

async function main() {
  const apiKey = process.env.LINEAR_API_KEY ?? "";
  const linear = new LinearClient(apiKey);
  
  console.log("=== TEST 1: With state filter ===");
  const withFilter = await linear.getActiveIssues({
    teamIds: ["eb416549-880b-46c9-a19d-ca57eb64695b"],
    states: ["In Progress", "Todo", "Backlog"],
  });
  console.log(`Count: ${withFilter.length}`);
  for (const issue of withFilter) {
    console.log(`  ${issue.key} | ${issue.state.name}`);
  }
  
  console.log("\n=== TEST 2: Without state filter ===");
  const withoutFilter = await linear.getActiveIssues({
    teamIds: ["eb416549-880b-46c9-a19d-ca57eb64695b"],
  });
  console.log(`Count: ${withoutFilter.length}`);
  for (const issue of withoutFilter) {
    console.log(`  ${issue.key} | ${issue.state.name}`);
  }
  
  console.log("\n=== TEST 3: Only In Progress ===");
  const inProgress = await linear.getActiveIssues({
    teamIds: ["eb416549-880b-46c9-a19d-ca57eb64695b"],
    states: ["In Progress"],
  });
  console.log(`Count: ${inProgress.length}`);
  for (const issue of inProgress) {
    console.log(`  ${issue.key} | ${issue.state.name}`);
  }
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
