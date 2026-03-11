import { LinearClient } from "../src/linear/client";
import { loadWorkflow } from "../src/workflow/loader";

async function main() {
  const workflow = await loadWorkflow("../WORKFLOW.md");
  const wf = workflow.frontMatter;
  const apiKey = process.env.LINEAR_API_KEY ?? "";
  const linear = new LinearClient(apiKey, wf.linear.apiUrl);
  const issues = await linear.getActiveIssues({
    ...(wf.linear.teamIds && wf.linear.teamIds.length > 0 ? { teamIds: wf.linear.teamIds } : {}),
    ...(wf.linear.states ? { states: wf.linear.states } : {}),
  });
  console.log("issues count", issues.length);
  for (const i of issues) {
    console.log(`${i.key} | ${i.state.name} | ${i.title}`);
  }
}

main().catch((err) => {
  console.error("debug script error", err);
  process.exit(1);
});
