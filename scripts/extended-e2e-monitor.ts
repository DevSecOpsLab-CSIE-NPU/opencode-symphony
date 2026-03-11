#!/usr/bin/env bun
/**
 * Extended E2E Monitor - Run for 10 minutes to watch full workflow
 */

import { loadWorkflow } from "../src/workflow/loader";
import { LinearClient } from "../src/linear/client";
import { OrchestratorEngine } from "../src/orchestrator/scheduler";
import { WorkspaceManager } from "../src/workspace/WorkspaceManager";
import { OpencodeSessionClient } from "../src/worker/OpenCodeAgentClient";
import { LiquidRenderer } from "../src/workflow/LiquidRenderer";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { join } from "node:path";

async function main() {
  console.log("=== SYMPHONY EXTENDED E2E MONITOR (10 minutes) ===\n");

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
    tickIntervalMs: 500,
  });

  console.log("[Extended] Starting orchestrator...");
  console.log(`[Extended] Max concurrent: ${wf.workspace.maxConcurrentAgents}`);
  console.log(`[Extended] Poll interval: ${wf.linear.pollIntervalMs}ms`);
  console.log("[Extended] Monitoring for 10 minutes...\n");

  engine.start();

  let lastRunning = 0;
  let lastQueued = 0;
  let lastCompleted = 0;
  const startTime = Date.now();

  const monitor = setInterval(() => {
    const state = engine.getState();
    const running = state.runningIssueIds.size;
    const queued = state.queuedIssueIds.size;
    
    // Count succeeded + failed
    const completed = Array.from(state.issueLifecycleById.values()).filter(
      lc => lc.kind === "succeeded" || lc.kind === "failed"
    ).length;

    const now = new Date().toLocaleTimeString();
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Log state changes
    if (running !== lastRunning || queued !== lastQueued || completed !== lastCompleted) {
      console.log(`[${now}] (${elapsed}s) Running: ${running}, Queued: ${queued}, Completed: ${completed}`);

      // Show which issues are running
      if (running > 0) {
        for (const issueId of state.runningIssueIds) {
          const issue = state.issuesById.get(issueId);
          const lc = state.issueLifecycleById.get(issueId);
          console.log(`         → ${issue?.key} (${lc?.kind || "unknown"})`);
        }
      }

      // Show completed issues
      if (completed > 0) {
        const completedIssues = Array.from(state.issueLifecycleById.entries())
          .filter(([_, lc]) => lc.kind === "succeeded" || lc.kind === "failed")
          .map(([id, lc]) => {
            const issue = state.issuesById.get(id);
            return `${issue?.key}(${lc.kind})`;
          });
        console.log(`         Completed: ${completedIssues.join(", ")}`);
      }

      lastRunning = running;
      lastQueued = queued;
      lastCompleted = completed;
    }
  }, 5000);

  // Stop after 10 minutes
  const timeout = setTimeout(() => {
    console.log("\n[Extended] 10 minutes reached. Shutting down...");
    engine.stop();
    clearInterval(monitor);
    clearTimeout(timeout);
    process.exit(0);
  }, 10 * 60 * 1000);

  process.on("SIGINT", () => {
    console.log("\n[Extended] Interrupted. Shutting down...");
    engine.stop();
    clearInterval(monitor);
    clearTimeout(timeout);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[Extended] Fatal:", err);
  process.exit(1);
});
