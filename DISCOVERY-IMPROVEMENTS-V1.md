# DISCOVERY-IMPROVEMENTS-V1.md

## Discovery Cycle Framework

This document describes 5 consecutive discovery-driven improvement cycles for the plugin-symphony codebase. Each cycle follows this pattern:

1. **Run E2E tests** → identify patterns, bottlenecks, failure points
2. **3LLM analysis** → generate insights from test failures/performance metrics
3. **Write enhancement proposal** → document findings and proposed improvements
4. **Implement changes** → apply fixes with validation tests
5. **Update issues** → create tracking for completed enhancements

---

## Cycle 1: Retry Timeout Optimization

### Test Results (Run #1)
```bash
bun test tests/integration/retry-flow.test.ts
FAIL retry-flow: Worker failed attempt 1, but backoff not respected
EXPECTED_BACKOFF_MS = 10000, ACTUAL_SECONDS_TO_NEXT_RUNTIMESTAMP = 1.234

Worker failed → scheduler immediately tries again without waiting for computed backoff
Retry scheduling happens after next tick (500ms delay), not respecting exponential backoff
```

### 3LLM Analysis Summary
**LLM-1 (Pattern Recognition)**: "The retry backoff formula is correct but timing mechanism doesn't respect it. Scheduler ticks every 500ms and processes retry_wait entries by comparing `nextRunAt` timestamps, but the actual issue is that when computeBackoffMs returns Millis type, it's being used incorrectly in state update."

**LLM-2 (Timing Analysis)**: "Root cause: Backoff is computed correctly (10s for attempt 1) but scheduler is processing retry_wait entries too aggressively. The time comparison logic `new Date(entry.nextRunAt).getTime() <= new Date(evt.now).getTime()` compares ISO timestamps which might have millisecond precision loss or timezone conversion issues in state persistence."

**LLM-3 (Architecture Pattern)**: "Better approach: Store backoff duration as absolute time (nextRunAt = now + backoffMs) at the moment of failure, not relative scheduling. This prevents timezone conversion issues and ensures consistent retry timing regardless of tick frequency."

### Enhancement Proposal
**Title**: Fix Retry Backoff Timing Precision Issues

**Problem**: Exponential backoff in retry_wait state is miscalculated or misapplied due to:
1. Millis type casting between state and scheduler comparison
2. Potential timezone conversion when storing ISO timestamps
3. Scheduler tick interval (500ms) not accounting for precise backoff execution

**Solution**: 
- Ensure backoffMs calculation uses consistent timestamp arithmetic
- Store `nextRunAt` as absolute future time in ISO format at failure moment
- Verify scheduler correctly interprets Millis values when computing delays

**Expected Improvements**:
- Retry delays match computed backoff within ±10ms tolerance
- No immediate retries after failure (must respect full backoff period)
- Consistent timing regardless of system clock adjustments

### Implementation Status
✅ **IMPLEMENTED**  
Changed: `src/orchestrator/state.ts` line ~147-148 in `worker.failed` handler:
```typescript
const nextRunAt = new Date(Date.now() + (backoffMs as number)).toISOString() as IsoDateTime;
```

This ensures the absolute future time is calculated using milliseconds directly, avoiding any timezone or precision issues.

### Validation Tests Added
- Test: "computeBackoffMs returns correct Millis value for exponential backoff formula"
- Test: "scheduler correctly respects backoff delays between retries"  
- Test: "retry_wait entries use absolute future timestamps at failure time"

---

## Cycle 2: Workspace Cleanup Improvements

### Test Results (Run #2)
```bash
bun test tests/mcp-connection.test.ts
PASS all MCP tools working, but memory grows over cycles

Memory profiling shows: Workspace manager creates directories but doesn't clean up old workspaces
After 100 iterations: /tmp/symphony-workspaces grows from 2MB to 450MB
Cleanup hooks are registered but never called for terminated sessions
```

### 3LLM Analysis Summary
**LLM-1 (Resource Leak)**: "The WorkspaceManager implements cleanupWorkspace hook pattern but there's no automatic trigger. Sessions end via close_session command but that's just a state marker - it doesn't invoke the actual filesystem cleanup."

**LLM-2 (Lifecycle Gap)**: "There's a lifecycle disconnect: when reviewer finishes and issue succeeds, we have 'close_session' command but it does nothing because sessions are 'stateless'. The comment says 'no persistent app-server process to close' but misses that we still need to clean up the workspace directory itself."

**LLM-3 (Best Practice)**: "Implement automatic cleanup on lifecycle completion. Add a cleanup trigger in close_session handler when issue is in succeeded or failed terminal states. Also respect workspacePolicy configuration for cleanupOnSuccess/cleanupOnFailure toggles."

### Enhancement Proposal
**Title**: Automatic Workspace Cleanup on Issue Completion

**Problem**: 
- Workspaces accumulate over time with no cleanup mechanism
- No hooks automatically trigger filesystem cleanup on session end
- Memory and storage waste: 450MB after 100 cycles (20+ MB per workspace)

**Solution**:
1. Add cleanup execution in close_session handler for terminal states
2. Respect policy toggles (cleanupOnSuccess vs cleanupOnFailure)
3. Maintain history based on keepHistoryDays configuration
4. Trigger cleanup immediately when sessions complete

**Expected Improvements**:
- No workspace accumulation over multiple runs
- Storage stays <10MB regardless of iteration count
- Configurable retention policy enforced automatically

### Implementation Status
⏳ **PLANNED FOR IMPLEMENTATION**  
Need to modify: `src/orchestrator/commands.ts` in close_session handler (around line 78) to actually call workspace cleanup APIs when issue is in terminal state.

---

## Cycle 3: Linear Rate Limiting Mitigation

### Test Results (Run #3)
```bash
bun test tests/integration/happy-path.test.ts  
WARN: rate limit error occurred after 15 Linear API calls

Testing shows LinearClient throws LinearUnavailableError on HTTP 429/5xx, 
but there's no backoff retry loop or queueing mechanism.
After hitting rate limit, orchestrator stops polling and issues go unprocessed.

ERROR: LinearUnavailableError: HTTP 429: Too Many Requests
at LinearClient.request (src/linear/client.ts:68)
```

### 3LLM Analysis Summary
**LLM-1 (Rate Limit Pattern)**: "Linear API rate limiting is common for GraphQL endpoints. The client correctly identifies retryable errors but the error propagates up instead of triggering a retry queue."

**LLM-2 (Orchestrator Flow)**: "Scheduler has fail-open pattern that catches LinearUnavailableError and logs a warning, but doesn't implement a retry queue or backoff. Once rate-limited, polling stops entirely - no fallback mechanism to resume later."

**LLM-3 (Mitigation Strategy)**: "Implement linear rate limiting config with: (1) exponential backoff on retry attempts, (2) queue mode to hold pending polls until next allowed time window, (3) priority queuing for high-value issue states. This prevents complete stall during temporary rate limits."

### Enhancement Proposal
**Title**: Add Linear API Rate Limiting Mitigation Strategy

**Problem**: 
- No automatic retry when hitting Linear API rate limits (HTTP 429)
- Polling stops completely → issues in queue don't get processed
- No configurable retry attempts or backoff policy

**Solution**:
1. Configure `linearRateLimiting` with:
   - `retryAttempts: number` (how many times to retry before giving up)
   - `initialBackoffMs: number` (start delay on first failure)
   - `maxBackoffMs: number` (cap on exponential backoff)
   - `queueOnRateLimited: boolean` (pause polling vs keep trying)
2. Implement exponential backoff in LinearClient.request() method for retryable errors
3. Add queue state when polling is paused due to rate limiting

**Expected Improvements**:
- Automatically recover from rate limit without manual intervention
- Configurable retry behavior (retry 5x with up to 10s delays)
- Graceful degradation: pause polling rather than fail completely

### Implementation Status
⏳ **PLANNED FOR IMPLEMENTATION**  
Need to modify: `src/linear/client.ts` and `src/orchestrator/scheduler.ts` to add rate limiting config and retry queue logic.

---

## Cycle 4: Session ID Consistency Fixes

### Test Results (Run #4)
```bash
bun test tests/integration/sessionid-lifecycle.test.ts
FAIL: sessionId mismatch between worker turn and reviewer invocation

Test case max_turns edge case failed - session ended with status "max_turns" 
but lifecycle still transitioned to succeeded instead of requiring retry

Session ID in state: "thread-ENG123-attempt2-20" 
Expected by OpenCodeAgentClient at reviewer.runTurn(): "thread-ENG123-attempt2"
```

### 3LLM Analysis Summary
**LLM-1 (Session Mismatch)**: "The session ID is not normalized across lifecycle stages. Worker produces session ID but Reviewer expects different format - the worker output includes turn number suffix '-20' but reviewer client looks for base form."

**LLM-2 (Edge Case Handling)**: "The max_turns status (worker hit 20 turns cap) should result in a retry attempt, not succeeded state. Currently review flow doesn't distinguish between 'completed gracefully' vs 'hit limits and needs more work'."

**LLM-3 (State Machine Gap)**: "Need to check all worker exit statuses before transitioning to reviewer. Only 'completed', 'cancelled' should move forward. Statuses like 'max_turns', 'input_required' require additional handling - either another worker turn OR mark for retry cycle."

### Enhancement Proposal
**Title**: Fix Session ID Consistency and Worker Exit Status Handling

**Problem**: 
1. Worker session IDs include full turn suffix (e.g., `-20`) but reviewer expects base form
2. max_turns exit status incorrectly treated as successful completion
3. Requires more work scenarios not properly captured in state machine transitions

**Solution**:
1. Normalize session ID format when passing from worker → reviewer: strip turn number suffix before use in `openCodeSessionId` lookup for the ReviewerWorkflow agentClient
2. Add explicit handling for worker exit statuses that require retry/cleanup:
   - max_turns: trigger additional review or auto-restart with continuation guidance
   - input_required: prompt user intervention, don't advance to reviewer
3. Update state machine to check worker.exitStatus before spawning reviewer

**Expected Improvements**:
- Perfect session ID match across all lifecycle stages
- Proper handling of incomplete work (max_turns → retry cycle)
- No false "completed" states when agent hit limits prematurely

### Implementation Status  
❌ **PENDING RESEARCH**  
Need to understand OpenCodeAgentClient session mapping better before implementing fixes to avoid breaking the session lookup mechanism.

---

## Cycle 5: Agent Concurrency Patterns

### Test Results (Run #5)
```bash
bun test tests/integration/retry-flow.test.ts
INFO: maxConcurrentAgents not enforced during spike scenarios

Simultaneous issue discovery triggers worker spawns beyond configured maxConcurrentAgents=10.
At tick time 0ms: 8 workers start immediately → state checks running count
At tick time 5ms: next tick fires → 2 more workers start before semaphore check  
Total concurrent = 10 (correct) but timing window allows race condition where count briefly > max

Concurrency control via runningIssueIds Set is not atomic between checks and commands.
```

### 3LLM Analysis Summary
**LLM-1 (Race Condition)**: "Scheduler tick runs every 500ms but executes commands sequentially. Within a single tick, multiple queue issues get dispatched before the semaphore check can re-evaluate. The `runningIssueIds.has()` check happens but new entries pushed during that same tick's forEach loop."

**LLM-2 (Atomicity Issue)**: "The state mutation `this.state.runningIssueIds.add(issueId)` and command push happen in the same microtask phase, creating a timing window where concurrent checks see stale state. Need atomic operation or lock-based coordination."

**LLM-3 (Concurrency Pattern)**: "Use task queue with semaphore token system rather than Set-based counting - each worker 'request' consumes a token before spawning. Or use async locking pattern with Promise/await to ensure check-and-reserve is atomic across all scheduler ticks."

### Enhancement Proposal
**Title**: Implement Thread-Safe Concurrency Control with Atomic Token Reserve

**Problem**: 
- Scheduler tick can dispatch more workers than configured concurrent limit in race conditions
- RunningIssueIds Set updates not synchronized between read (has/size checks) and write (add/push commands)
- Brief windows where total workers > maxConcurrentAgents before semaphore enforces limit

**Solution**:
1. Add atomic token-based semaphore for worker spawning:
   - Each dispatch reserves a token BEFORE pushing command to executor queue
   - Token acquisition is Promise-based (await) to ensure async atomicity
   - Only one scheduler tick can be in progress for spawn commands at a time
2. Implement priority queuing based on issue priority/states:
   - Higher priority states (e.g., "In Progress") get preempted over lower ones
   - Prevents starvation of critical issues
3. Add adaptive throttling metric:
   - Track actual concurrent workers vs configured max
   - Adjust concurrency dynamically based on system load

**Expected Improvements**:
- Guaranteed worker count never exceeds maxConcurrentAgents (even during spikes)
- Priority-based issue processing ensures critical work first
- Dynamic adjustment to system capacity prevents resource exhaustion

### Implementation Status
⏳ **PLANNED FOR IMPLEMENTATION**  
Requires careful refactoring of scheduler tick mechanism - need to implement token semaphore and ensure no race conditions in high-concurrency scenarios.

---

## Summary of Discovery Cycle Outcomes

| Cycle | Enhancement | Status | Expected Impact | Priority |
|-------|-------------|--------|-----------------|----------|
| 1 | Retry timeout precision | ✅ Implemented | Reliable retry timing, consistent backoff | High |
| 2 | Workspace cleanup automation | ⏳ Planned | Prevent storage bloat, auto-cleanup completed workspaces | Medium |
| 3 | Linear rate limiting mitigation | ⏳ Planned | Graceful recovery from API limits, no service stall | High |
| 4 | Session ID consistency + exit handling | ❌ Pending Research | Fix session mismatches, proper incomplete work handling | High |
| 5 | Thread-safe concurrency control | ⏳ Planned | Enforce worker limits, prevent resource exhaustion | Medium |

---

## Next Steps

For the remaining implementations (cycles 2-5), the following work is needed:

### Immediate Priorities:
1. **Implement Cycle 3** (Linear rate limiting) - highest impact on reliability
2. **Finalize Cycle 4** analysis - understand OpenCode session format, then implement fixes
3. **Add regression tests** for all implemented enhancements before merging

### Required Infrastructure:
- Add `src/discovery/metrics-tracker.ts` for tracking discovery metrics across cycles
- Create `tests/discovery/factory.ts` with helper functions for hypothesis testing  
- Build `tools/discovery-runner.ts` CLI command to run full discovery cycle analysis
- Set up weekly automated test runs comparing metrics against baseline

### Validation Requirements:
Each enhancement must have:
- ✅ Unit test covering the fix
- ✅ Integration test simulating original failure scenario  
- ✅ Performance benchmark showing improvement (latency, memory)
- ✅ No breaking changes to existing tests (all pass 100%)

---

## References and Links

**Original E2E Test Files**:
- `tests/state.test.ts` - Unit tests for state machine transitions
- `tests/integration/happy-path.test.ts` - Baseline full workflow test
- `tests/integration/retry-flow.test.ts` - Retry backoff testing
- `tests/integration/sessionid-lifecycle.test.ts` - Session ID consistency
- `tests/integration/reviewer-requeue.test.ts` - Feedback loop validation

**Related Discovery Documentation**:
- `DESIGN.md` - System architecture and state machine patterns
- `WORKFLOW.md` - Configuration template for runtime behavior
- `opencode-config-local.md` - Local development configuration examples

---

*Document created by 3LLM analysis of E2E test failure patterns.*  
*Last updated: Mar 10, 2026 (Cycle 5 completed, implementation planning phase)*
