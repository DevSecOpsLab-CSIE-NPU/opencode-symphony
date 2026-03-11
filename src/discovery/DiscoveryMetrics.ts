// src/discovery/DiscoveryMetrics.ts - Track and report on discovery improvement cycles

import type { DiscoveryMetrics, WorkflowDefinition } from "../orchestrator/types.js";

/** Statistics per discovered issue */
export interface IssueStats {
  issueKey: string;
  confidence: number;            // Match confidence score (0-1)
  matchedPatterns: string[];     // Patterns that identified this issue
  historicalSimilarity: number;  // Similarity to previously seen issues
  timeToDiscoverMs: number;      // How long until found in current cycle
}

/** Discovery result with full metrics */
export interface DiscoveryRunResult {
  cycleNumber: number;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  
  // Core metrics
  metrics: Required<DiscoveryMetrics>;
  
  // Detailed breakdowns
  issuesDiscovered: IssueStats[];
  patternsApplied: Array<{
    patternName: string;
    hits: number;
    successRate: number;                    // % of hits that were true positives
    falsePositives: number;
  }>;
  
  // State machine stats from the orchestrator
  workerRuns: { total: number; successful: number; failed: number; timedOut: number };
  reviewerReviews: { total: number; approved: number; changesRequested: number };
  completedIssues: string[];              // Issue keys that reached "succeeded" state
  
  // Improvement suggestions from this cycle
  recommendations: string[];
  
  // Convergence status
  convergedStableIssueSet: boolean;
}

/** Discovery cycle runner for systematic improvement testing */
export class DiscoveryMetricsTracker {
  private history: DiscoveryRunResult[] = [];
  private baseline?: DiscoveryRunResult;

  /** Record a discovery run and track metrics over time */
  recordRun(run: DiscoveryRunResult): void {
    this.history.push(run);
    
    // Set baseline after first run (or use provided)
    if (!this.baseline && run.cycleNumber === 1) {
      this.baseline = run;
    }
    
    console.log(`[DiscoveryMetrics] Recorded cycle ${run.cycleNumber}: found ${run.metrics.issuesFound} issues, precision=${run.metrics.precision.toFixed(2)}, recall=${run.metrics.recall.toFixed(2)}`);
  }

  /** Get current metrics averaged over last N runs */
  getRunningAverage(lastN: number = 3): DiscoveryMetrics {
    if (this.history.length === 0) {
      throw new Error("No discovery runs recorded yet");
    }

    const recent = this.history.slice(-lastN);
    return {
      issuesFound: Math.round(reduce(recent, r => r.metrics.issuesFound + r.metrics.issuesFound) / recent.length),
      truePositives: Math.round(reduce(recent, r => r.metrics.truePositives + r.metrics.truePositives) / recent.length),
      falsePositives: Math.round(reduce(recent, r => r.metrics.falsePositives + r.metrics.falsePositives) / recent.length),
      falseNegatives: Math.round(reduce(recent, r => r.metrics.falseNegatives + r.metrics.falseNegatives) / recent.length),
      precision: recent.reduce((sum, r) => sum + r.metrics.precision, 0) / recent.length,
      recall: recent.reduce((sum, r) => sum + r.metrics.recall, 0) / recent.length,
      f1Score: recent.reduce((sum, r) => sum + r.metrics.f1Score, 0) / recent.length,
      convergenceCycles: Math.round(reduce(recent, r => r.metrics.convergenceCycles + r.metrics.convergenceCycles) / recent.length),
      feedbackIncorporationRate: recent.reduce((sum, r) => sum + r.metrics.feedbackIncorporationRate, 0) / recent.length,
      cycleLatencyMs: Math.round(reduce(recent, r => r.metrics.cycleLatencyMs + r.metrics.cycleLatencyMs) / recent.length),
    };
  }

  /** Compare current metrics to baseline */
  compareAgainstBaseline(): ImprovementReport {
    if (!this.baseline || this.history.length < 2) {
      throw new Error("Need at least 2 runs to compare against baseline");
    }

    const current = this.getRunningAverage();
    
    return {
      weeksTracked: this._weeksSinceBaseline(),
      deltas: computeDeltas(current, this.baseline.metrics),
      summary: generateSummary(current, this.baseline.metrics, this.history),
      recommendations: extractRecommendations(this.history),
    };
  }

  /** Check if issue set has stabilized (converged) */
  checkConvergence(windowSize: number = 3): boolean {
    if (this.history.length < windowSize) return false;

    const recent = this.history.slice(-windowSize);
    const prevIssueSets = recent.slice(0, -1).map(r => new Set(r.issuesDiscovered.map(i => i.issueKey)));
    const currentSet = recent[recent.length - 1].issuesDiscovered.map(i => i.issueKey);

    // Converged if all previous cycle sets equal current set
    return prevIssueSets.every(prevSet => {
      const prevIssues = new Set(prevSet);
      return currentSet.every(issueKey => prevIssues.has(issueKey)) &&
             prevSet.every(issueKey => currentSet.includes(issueKey));
    });
  }

  /** Get trend analysis for specific metrics */
  getTrend(metric: keyof DiscoveryMetrics): TrendAnalysis {
    if (this.history.length < 2) {
      return { stable, direction: "flat", variance: 0 };
    }

    const values = this.history.map(r => r.metrics[metric]);
    
    // Analyze trend using simple linear regression
    const slope = calculateSlope(values);
    const variance = calculateVariance(values);
    
    let direction: "increasing" | "decreasing" | "stable";
    if (slope > 0.05) direction = "increasing";
    else if (slope < -0.05) direction = "decreasing";
    else direction = "stable";

    return {
      metric,
      trendDirection: direction,
      slope,
      variance,
      firstValue: values[0],
      lastValue: values[values.length - 1],
      percentageChange: ((values[values.length - 1] - values[0]) / values[0]) * 100,
    };
  }

  /** Generate improvement report for PR submission */
  generateImprovementReport(options?: { includeRecommendations?: boolean }): ImprovementReport {
    const current = this.getRunningAverage();
    const baseline = this.baseline?.metrics;

    if (!baseline) {
      throw new Error("No baseline established");
    }

    return {
      weeksTracked: this._weeksSinceBaseline(),
      deltas: computeDeltas(current, baseline),
      summary: generateSummary(current, baseline, this.history),
      recommendations: options?.includeRecommendations ? extractRecommendations(this.history) : [],
    };
  }

  private _weeksSinceBaseline(): number {
    if (!this.baseline) return 0;
    const start = new Date(this.baseline.startTime);
    const now = new Date();
    return Math.floor((now.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000));
  }
}

/** Compute improvement deltas between two metric sets */
function computeDeltas(current: DiscoveryMetrics, baseline: DiscoveryMetrics): ImprovementDeltas {
  return {
    convergenceCyclesDiff: current.convergenceCycles - baseline.convergenceCycles,
    feedbackIncorporationRateDelta: current.feedbackIncorporationRate - baseline.feedbackIncorporationRate,
    cycleLatencyMsDiff: current.cycleLatencyMs - baseline.cycleLatencyMs,
    precisionDelta: Number((current.precision - baseline.precision).toFixed(3)),
    recallDelta: Number((current.recall - baseline.recall).toFixed(3)),
    f1Delta: Number((current.f1Score - baseline.f1Score).toFixed(3)),
    issuesFoundDiff: current.issuesFound - baseline.issuesFound,
    truePositivesDiff: current.truePositives - baseline.truePositives,
    falsePositivesDiff: current.falsePositives - baseline.falsePositives,
    falseNegativesDiff: current.falseNegatives - baseline.falseNegatives,
  };
}

/** Generate human-readable improvement summary */
function generateSummary(
  current: DiscoveryMetrics, 
  baseline: DiscoveryMetrics, 
  history: DiscoveryRunResult[]
): string {
  const improvements = [];
  
  if ((current.precision - baseline.precision) > 0.01) {
    improvements.push(`Precision improved from ${baseline.precision.toFixed(2)} to ${current.precision.toFixed(2)}`);
  }
  
  if ((current.recall - baseline.recall) > 0.01) {
    improvements.push(`Recall improved from ${baseline.recall.toFixed(2)} to ${current.recall.toFixed(2)}`);
  }
  
  if (current.cycleLatencyMs < baseline.cycleLatencyMs) {
    const improvement = Math.round((1 - current.cycleLatencyMs / baseline.cycleLatencyMs) * 100);
    improvements.push(`Cycle latency decreased by ${improvement}%`);
  }

  const converged = checkConvergence(history, 3);
  if (converged) {
    improved.add("Issue set has stabilized");
  }

  return `Discovery cycle improvement summary (${history.length} cycles tracked):\n${improvements.join("\n")}`;
}

/** Extract actionable recommendations from discovery history */
function extractRecommendations(history: DiscoveryRunResult[]): string[] {
  const recs: string[] = [];
  
  // Check for patterns with low success rates
  for (const run of history) {
    for (const pattern of run.patternsApplied) {
      if (pattern.successRate < 0.5 && pattern.hits > 10) {
        recs.push(`Pattern "${pattern.patternName}" has only ${pattern.successRate.toFixed(2)} success rate - consider deprecating or re-tuning`);
      }
    }
  }

  // Check for latency patterns
  if (history.length >= 3) {
    const latencies = history.slice(-3).map(r => r.durationMs);
    if (latencies[2] > latencies[0] * 1.5) {
      recs.push(`Latency increased by ${Math.round((latencies[2] - latencies[0]) / latencies[0] * 100)}% over last 3 cycles - investigate performance regression`);
    }
  }

  return recs;
}

/** Helper: sum of array values */
function reduce<T>(arr: T[], fn: (acc: number, item: T) => number): number {
  return arr.reduce((sum, item) => sum + fn(sum, item), 0);
}

/** Helper: check convergence */
function checkConvergence(history: DiscoveryRunResult[], windowSize: number = 3): boolean {
  if (history.length < windowSize) return false;

  const recent = history.slice(-windowSize);
  const issueSets = recent.map(r => new Set(r.issuesDiscovered.map(i => i.issueKey)));
  
  // Converged if all sets match
  const firstSet = issueSets[0];
  return issueSets.every(set => {
    return set.size === firstSet.size && [...set].every(item => firstSet.has(item));
  });
}

/** Trend analysis result */
interface TrendAnalysis {
  metric: string;
  trendDirection: "increasing" | "decreasing" | "stable";
  slope: number;
  variance: number;
  firstValue: number;
  lastValue: number;
  percentageChange: number;
}

/** Improvement report for PR submission */
interface ImprovementReport {
  weeksTracked: number;
  deltas: ImprovementDeltas;
  summary: string;
  recommendations: string[];
}

/** Improvement deltas structure with diff calculations */
interface ImprovementDeltas {
  convergenceCyclesDiff: number;
  feedbackIncorporationRateDelta: number;
  cycleLatencyMsDiff: number;
  precisionDelta: number;
  recallDelta: number;
  f1Delta: number;
  issuesFoundDiff: number;
  truePositivesDiff: number;
  falsePositivesDiff: number;
  falseNegativesDiff: number;
}

/** Statistical helpers */
function calculateSlope(values: number[]): number {
  if (values.length < 2) return 0;
  
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  const n = values.length;
  
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  
  return (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
}

function calculateVariance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  return squaredDiffs.reduce((a, b) => a + b, 0) / squaredDiffs.length;
}

export const trendDirection = {
  flat: "stable" as const,
};
