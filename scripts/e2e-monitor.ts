#!/usr/bin/env bun
/**
 * E2E Monitor - Start orchestrator and monitor workers
 * Logs state changes as issues transition through the queue → running → done
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
  console.log("=== SYMPHONY E2E MONITOR ===\n");

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
    tickIntervalMs: 500, // Tick every 500ms to see state changes
  });

  console.log("[E2E] Starting orchestrator...");
  console.log(`[E2E] Max concurrent workers: ${wf.workspace.maxConcurrentAgents}`);
  console.log(`[E2E] Poll interval: ${wf.linear.pollIntervalMs}ms`);
  console.log(`[E2E] Tick interval: 500ms`);
  console.log("[E2E] Monitored states:", wf.linear.states);
  console.log("\n---\n");

  // Start the orchestrator
  engine.start();

  // Monitor state every 2 seconds
  let lastRunning = 0;
  let lastQueued = 0;
  const stateMonitor = setInterval(() => {
    const state = engine.getState();
    const running = state.runningIssueIds.size;
    const queued = state.queuedIssueIds.size;

    // Only log if state changed
    if (running !== lastRunning || queued !== lastQueued) {
      const now = new Date().toLocaleTimeString();
      console.log(`[${now}] Running: ${running}, Queued: ${queued}`);

      // Log which issues are running
      if (running > 0) {
        for (const issueId of state.runningIssueIds) {
          const issue = state.issuesById.get(issueId);
          console.log(`         → ${issue?.key} (sessionId: ${state.sessionIdByIssueId.get(issueId) ?? "N/A"})`);
        }
      }

      lastRunning = running;
      lastQueued = queued;
    }
  }, 2000);

  // Run for 2 minutes then shutdown
  const timeout = setTimeout(() => {
    console.log("\n[E2E] Timeout reached (2 minutes). Shutting down...");
    engine.stop();
    clearInterval(stateMonitor);
    clearTimeout(timeout);
    process.exit(0);
  }, 2 * 60 * 1000);

  // Graceful shutdown on Ctrl+C
  process.on("SIGINT", () => {
    console.log("\n[E2E] Interrupt received. Shutting down...");
    engine.stop();
    clearInterval(stateMonitor);
    clearTimeout(timeout);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[E2E] Fatal error:", err);
  process.exit(1);
});
