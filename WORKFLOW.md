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
