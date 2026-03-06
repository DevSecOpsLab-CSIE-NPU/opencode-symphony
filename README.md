# plugin-symphony

[![CI](https://github.com/DevSecOpsLab-CSIE-NPU/opencode-symphony/actions/workflows/ci.yml/badge.svg)](https://github.com/DevSecOpsLab-CSIE-NPU/opencode-symphony/actions/workflows/ci.yml)

An [OpenCode](https://opencode.ai) plugin that implements the **OpenAI Symphony SPEC** — a three-role LLM collaboration architecture where an **Orchestrator** coordinates **Worker** and **Reviewer** agents to autonomously resolve Linear issues and open pull requests.

---

## Overview

```
Linear Issues
     │
     ▼
┌────────────────────────────────────────┐
│            Orchestrator                │
│  • Polls Linear for issues             │
│  • Manages concurrency & retries       │
│  • Dispatches tasks to Workers         │
│  • Schedules Reviewer after each run   │
└──────────┬──────────────┬─────────────┘
           │              │
           ▼              ▼
     ┌──────────┐   ┌──────────────┐
     │  Worker  │   │   Reviewer   │
     │  Writes  │   │  Reviews &   │
     │   code   │   │   opens PR   │
     └──────────┘   └──────────────┘
```

| Role | Responsibility |
|------|----------------|
| **Orchestrator** | Poll Linear, schedule work, manage concurrency, state machine, retries |
| **Worker** | Explore codebase, implement solution, run tests |
| **Reviewer** | Review diff, enforce quality gates, write PR description, open PR |

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| [Bun](https://bun.sh) | ≥ 1.3.10 | Primary runtime |
| [OpenCode](https://opencode.ai) | latest | Plugin host |
| [GitHub CLI (`gh`)](https://cli.github.com) | latest | Required for opening PRs |
| Linear account | — | Personal API key required |
| Git | ≥ 2.x | For workspace operations |

---

## Installation

### 1. Clone and build

```bash
git clone https://github.com/DevSecOpsLab-CSIE-NPU/opencode-symphony.git
cd opencode-symphony
bun install
bun run build
```

The build output is written to `dist/index.js`.

### 2. Register the plugin in OpenCode

Add the following to your OpenCode config (e.g. `~/.config/opencode/config.json`):

```json
{
  "mcp": {
    "symphony": {
      "command": "bun",
      "args": ["/path/to/opencode-symphony/dist/index.js"],
      "env": {
        "LINEAR_API_KEY": "${LINEAR_API_KEY}",
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

> Replace `/path/to/opencode-symphony` with the absolute path where you cloned the repo.

### 3. Set environment variables

```bash
export LINEAR_API_KEY="lin_api_xxxxxxxxxxxx"
export GITHUB_TOKEN="ghp_xxxxxxxxxxxx"
```

Or add them to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.).

---

## Configuration

Create or edit `WORKFLOW.md` in your project root. The file has two parts:
1. **YAML front matter** (between `---` delimiters) — runtime settings
2. **Liquid template body** — the prompt sent to each Worker agent

### Minimal example

```markdown
---
linear:
  pollIntervalMs: 30000
  teamIds:
    - "YOUR_TEAM_ID"
  states:
    - "In Progress"

workspace:
  root: /tmp/symphony-workspaces
  maxConcurrentAgents: 5

retry:
  maxAttempts: 3
  maxRetryBackoffMs: 300000

timeouts:
  workerRunTimeoutMs: 1800000
  reviewerRunTimeoutMs: 600000
  sessionIdleTimeoutMs: 120000

appServer:
  command: opencode
  args: []
---

You are a skilled software engineer. Your task is to resolve the following Linear issue.

## Issue: {{ issue.identifier }} — {{ issue.title }}

**URL:** {{ issue.url }}

**Description:**
{{ issue.description }}

**This is attempt #{{ attempt }}.**

## Instructions

1. Explore the codebase to understand the context
2. Implement a solution that addresses the issue description
3. Write or update tests as appropriate
4. Ensure all existing tests still pass
5. Leave the code in a clean, reviewable state

Do not ask for clarification. Make your best judgment and proceed.
```

### Front matter reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `linear.pollIntervalMs` | number | `30000` | How often (ms) to poll Linear for new issues |
| `linear.teamIds` | string[] | — | Linear team IDs to watch |
| `linear.states` | string[] | `["In Progress"]` | Issue state names that trigger dispatch |
| `linear.apiUrl` | string | Linear default | Optional custom Linear API endpoint |
| `workspace.root` | string | — | Directory where per-issue workspaces are created |
| `workspace.maxConcurrentAgents` | number | `5` | Maximum Workers running in parallel |
| `retry.maxAttempts` | number | `3` | Max attempts before marking an issue as failed |
| `retry.maxRetryBackoffMs` | number | `300000` | Retry backoff cap (ms); formula: `min(10000 × 2^(attempt−1), cap)` |
| `timeouts.workerRunTimeoutMs` | number | `1800000` | Worker session timeout (30 min) |
| `timeouts.reviewerRunTimeoutMs` | number | `600000` | Reviewer session timeout (10 min) |
| `timeouts.sessionIdleTimeoutMs` | number | `120000` | Session idle timeout (2 min) |
| `appServer.command` | string | `"opencode"` | Command used to spawn the OpenCode agent |
| `appServer.args` | string[] | `[]` | Additional args passed to the agent command |

### Liquid template variables

| Variable | Description |
|----------|-------------|
| `{{ issue.identifier }}` | Linear issue identifier (e.g. `ENG-42`) |
| `{{ issue.title }}` | Issue title |
| `{{ issue.url }}` | URL to the issue in Linear |
| `{{ issue.description }}` | Full issue description body |
| `{{ attempt }}` | Current attempt number (starts at 1) |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_API_KEY` | ✅ Yes | Linear personal API key — get it from [Linear Settings → API](https://linear.app/settings/api) |
| `GITHUB_TOKEN` | ✅ Yes | GitHub personal access token with `repo` scope — used to open pull requests |

---

## Usage

Once the plugin is registered, all tools are available inside an OpenCode session via MCP. Start the Orchestrator with:

```
symphony.start
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `symphony.start` | Start the Orchestrator loop. Begins polling Linear and dispatching issues to Workers. Accepts an optional `workflowPath` argument. |
| `symphony.stop` | Stop the Orchestrator loop and all running Workers. |
| `symphony.status` | Get a lightweight snapshot: running state, concurrency, and issue/session/attempt counts. |
| `symphony.listIssues` | List tracked issues and their lifecycle states. Supports optional `stateKinds` filter and `limit`. |
| `symphony.reloadWorkflow` | Hot-reload `WORKFLOW.md` without restarting the Orchestrator. Changes take effect on the next scheduler tick. |
| `symphony.runOnce` | **Debug**: manually trigger one Orchestrator scheduler tick and inspect the resulting commands. |
| `symphony.retryIssue` | Manually retry a specific issue by ID. Requires `issueId` and `reason`. |
| `symphony.inspect` | **Debug**: inspect the detailed state of an issue, session, or attempt by ID. |

### Issue lifecycle states

```
discovered → queued → running → awaiting_review → reviewing
                                                        │
                                         ┌──────────────┴──────────────┐
                                         ▼                             ▼
                                    succeeded                   needs_changes
                                                                      │
                                                               retry_wait → running (retry)
                                                                      │
                                                               failed (max attempts reached)
```

---

## Development

```bash
# Run unit tests
bun test tests/state.test.ts

# Run all integration tests
bun test tests/integration/

# Type check (no emit)
bun run typecheck

# Build to dist/
bun run build

# Development mode (no build step)
bun run dev
```

### Project structure

```
src/
├── index.ts                    # Plugin entry point — 8 MCP tools
├── messages.ts                 # Cross-module message types
├── orchestrator/
│   ├── types.ts                # Domain types (OrchestratorState, events)
│   ├── state.ts                # Pure reducer: applyEvent()
│   ├── scheduler.ts            # Tick loop + Linear poller
│   └── commands.ts             # Side-effect command executor
├── worker/
│   ├── WorkerRunner.ts         # Turn loop
│   ├── OpenCodeAgentClient.ts  # Agent adapter
│   └── types.ts                # WorkerEvent, WorkerConfig, WorkerResult
├── reviewer/                   # Reviewer logic
├── workspace/
│   └── WorkspaceManager.ts     # Per-issue workspace isolation
├── workflow/
│   ├── loader.ts               # Parse WORKFLOW.md
│   ├── watcher.ts              # Hot-reload file watcher
│   └── LiquidRenderer.ts       # Liquid template rendering
└── linear/
    └── client.ts               # Linear GraphQL client
```

---

## Known Limitations

1. **`OpenCodeAgentClient`** — The agent invocation API in `@opencode-ai/plugin` SDK is a placeholder. Worker/Reviewer dispatch will need updating once the SDK stabilizes.
2. **Reviewer LLM invocation** — Exact mechanism for calling a second LLM as Reviewer (avoiding plugin recursion) is not yet finalized.
3. **Linear state ID mapping** — The mapping between Linear state names and internal state IDs requires manual configuration per team.
4. **Branch/commit strategy** — Worktree-based workspace isolation is designed but not fully verified in production environments.
5. **Auth injection** — The recommended way to inject credentials (environment variables vs. WORKFLOW.md front matter) may change in future versions.

---

## License

MIT
