import { loadWorkflow } from "../src/workflow/loader";
import { OrchestratorEngine } from "../src/orchestrator/scheduler";
import { LinearClient } from "../src/linear/client";
import { WorkspaceManager } from "../src/workspace/WorkspaceManager";
import { LiquidRenderer } from "../src/workflow/LiquidRenderer";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { OpencodeSessionClient } from "../src/worker/OpenCodeAgentClient";

async function main() {
  const workflow = await loadWorkflow("../WORKFLOW.md");
  const wf = workflow.frontMatter;
  const linear = new LinearClient(process.env.LINEAR_API_KEY ?? "", wf.linear.apiUrl);
  const workspaceManager = new WorkspaceManager({ rootDir: wf.workspace.root, strategy: "directory_only" });
  const liquidRenderer = new LiquidRenderer();

  const opencodeBaseURL = process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";
  const opencodeClient = createOpencodeClient({ baseUrl: opencodeBaseURL });
  const agentClient = new OpencodeSessionClient(
    opencodeClient as never,
    "build",
    process.env["OPENCODE_MODEL"] ?? "gpt-4o-mini",
  );

  console.log("[oneshot] connecting to OpenCode at", opencodeBaseURL);

  const engine = new OrchestratorEngine({
    workflow,
    linear,
    commandDeps: {
      workspaceManager,
      agentClient,
      liquidRenderer,
    },
  });

  const polledAt = new Date().toISOString();
  const issues = await linear.getActiveIssues({
    ...(wf.linear.teamIds ? { teamIds: wf.linear.teamIds } : {}),
    ...(wf.linear.states ? { states: wf.linear.states } : {}),
  });
  console.log("[oneshot] issues", issues.length);
  for (const i of issues) {
    console.log(`[oneshot] ${i.key} | ${i.state.name} | ${i.title}`);
  }

  engine.emitEvent({ type: "linear.polled", issues, polledAt });

  const tickCommands = engine.runOnce();
  console.log("[oneshot] initial runOnce produced", tickCommands.length, "commands");

  const state = engine.getState();
  console.log("[oneshot] initial state - running issues", state.runningIssueIds.size);

  // Continuously tick scheduler until all work completes
  if (tickCommands.length > 0) {
    console.log("[oneshot] engine started — workers dispatched, running scheduler ticks...");
    await new Promise<void>((resolve) => {
      let lastLogTime = Date.now();
      let tickCount = 0;
      const maxTicks = 300; // 5 minutes worth of ticks
      
      const tickInterval = setInterval(() => {
        tickCount++;
        const s = engine.getState();
        
        // Emit scheduler.tick to advance queued issues
        engine.emitEvent({ type: "scheduler.tick", now: new Date().toISOString() });
        const newCommands = engine.runOnce();
        
        if (newCommands.length > 0) {
          console.log(`[oneshot] tick #${tickCount}: ${newCommands.length} new commands`);
        }
        
        const now = Date.now();
        if (now - lastLogTime >= 10000) {
          console.log(`[oneshot] status (tick ${tickCount}): running=${s.runningIssueIds.size}, queued=${s.queuedIssueIds.size}, retryWait=${s.retryByIssueId.size}`);
          lastLogTime = now;
        }
        
        // Check completion: no running, queued, or retrying
        const allDone = 
          s.runningIssueIds.size === 0 && 
          s.queuedIssueIds.size === 0 &&
          s.retryByIssueId.size === 0;
        
        if (allDone || tickCount >= maxTicks) {
          if (tickCount >= maxTicks) {
            console.log(`[oneshot] reached max ticks (${maxTicks}), stopping`);
          }
          clearInterval(tickInterval);
          resolve();
        }
      }, 1000); // Tick every 1 second
    });
    
    const finalState = engine.getState();
    console.log("[oneshot] final state:");
    console.log("  Total issues:", finalState.issueLifecycleById.size);
    console.log("  Running:", finalState.runningIssueIds.size);
    console.log("  Queued:", finalState.queuedIssueIds.size);
    console.log("  RetryWait:", finalState.retryByIssueId.size);
    console.log();
    console.log("[oneshot] issueLifecycles by kind:");
    const lifecyclesByKind = new Map<string, string[]>();
    for (const [id, lc] of finalState.issueLifecycleById) {
      const issue = finalState.issuesById.get(id);
      const key = issue?.key ?? id;
      const kindStr = lc.kind;
      if (!lifecyclesByKind.has(kindStr)) lifecyclesByKind.set(kindStr, []);
      lifecyclesByKind.get(kindStr)!.push(key);
    }
    for (const [kind, keys] of lifecyclesByKind) {
      console.log(`  ${kind}: ${keys.join(", ")}`);
    }
    console.log();
    console.log("[oneshot] detailed lifecycle info:");
    for (const [id, lc] of finalState.issueLifecycleById) {
      const issue = finalState.issuesById.get(id);
      const key = issue?.key ?? id;
      console.log(`  ${key}: kind=${lc.kind}, lifecycle=${JSON.stringify(lc)}`);
      const sessionId = finalState.sessionIdByIssueId.get(id);
      if (sessionId) {
        const session = finalState.sessionsById.get(sessionId);
        console.log(`    sessionId=${sessionId}, status=${session?.status}, workerDone=${session?.workerDone}`);
        if (session?.lastWorkerResult) {
          console.log(`    workerResult: ${JSON.stringify(session.lastWorkerResult).substring(0, 300)}`);
        }
      }
    }
  }
}

main().catch((err) => {
  console.error("[oneshot] error", err);
  process.exit(1);
});
