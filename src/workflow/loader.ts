import type { WorkflowDefinition, WorkflowFrontMatter, WorkspaceRoot, Millis, IsoDateTime } from "../orchestrator/types.js";

let _revisionCounter = 0;

export class WorkflowValidationError extends Error {
  constructor(field: string) {
    super(`Missing required WORKFLOW.md field: ${field}`);
    this.name = "WorkflowValidationError";
  }
}

function splitFrontMatter(raw: string): { yaml: string; body: string } {
  const FM_DELIMITER = "---";
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== FM_DELIMITER) {
    return { yaml: "", body: raw };
  }
  const endIdx = lines.slice(1).findIndex((l) => l.trim() === FM_DELIMITER);
  if (endIdx === -1) {
    return { yaml: "", body: raw };
  }
  const yamlLines = lines.slice(1, endIdx + 1);
  const bodyLines = lines.slice(endIdx + 2);
  return { yaml: yamlLines.join("\n"), body: bodyLines.join("\n") };
}

function validateFrontMatter(raw: unknown): WorkflowFrontMatter {
  if (typeof raw !== "object" || raw === null) {
    throw new WorkflowValidationError("(root)");
  }
  const r = raw as Record<string, unknown>;

  if (!r["linear"] || typeof r["linear"] !== "object") throw new WorkflowValidationError("linear");
  const linear = r["linear"] as Record<string, unknown>;
  if (typeof linear["pollIntervalMs"] !== "number") throw new WorkflowValidationError("linear.pollIntervalMs");

  if (!r["workspace"] || typeof r["workspace"] !== "object") throw new WorkflowValidationError("workspace");
  const workspace = r["workspace"] as Record<string, unknown>;
  if (typeof workspace["root"] !== "string") throw new WorkflowValidationError("workspace.root");
  if (typeof workspace["maxConcurrentAgents"] !== "number") throw new WorkflowValidationError("workspace.maxConcurrentAgents");

  if (!r["retry"] || typeof r["retry"] !== "object") throw new WorkflowValidationError("retry");
  const retry = r["retry"] as Record<string, unknown>;
  if (typeof retry["maxAttempts"] !== "number") throw new WorkflowValidationError("retry.maxAttempts");
  if (typeof retry["maxRetryBackoffMs"] !== "number") throw new WorkflowValidationError("retry.maxRetryBackoffMs");

  if (!r["timeouts"] || typeof r["timeouts"] !== "object") throw new WorkflowValidationError("timeouts");
  const timeouts = r["timeouts"] as Record<string, unknown>;
  if (typeof timeouts["workerRunTimeoutMs"] !== "number") throw new WorkflowValidationError("timeouts.workerRunTimeoutMs");
  if (typeof timeouts["reviewerRunTimeoutMs"] !== "number") throw new WorkflowValidationError("timeouts.reviewerRunTimeoutMs");
  if (typeof timeouts["sessionIdleTimeoutMs"] !== "number") throw new WorkflowValidationError("timeouts.sessionIdleTimeoutMs");

  if (!r["appServer"] || typeof r["appServer"] !== "object") throw new WorkflowValidationError("appServer");
  const appServer = r["appServer"] as Record<string, unknown>;
  if (typeof appServer["command"] !== "string") throw new WorkflowValidationError("appServer.command");

  const linearConfig: WorkflowFrontMatter["linear"] = {
    pollIntervalMs: linear["pollIntervalMs"] as number,
  };
  if (typeof linear["apiUrl"] === "string") linearConfig.apiUrl = linear["apiUrl"];
  if (Array.isArray(linear["teamIds"])) linearConfig.teamIds = linear["teamIds"] as string[];
  if (Array.isArray(linear["states"])) linearConfig.states = linear["states"] as string[];
  if (Array.isArray(linear["labels"])) linearConfig.labels = linear["labels"] as string[];

  const appServerConfig: WorkflowFrontMatter["appServer"] = {
    command: appServer["command"] as string,
  };
  if (Array.isArray(appServer["args"])) appServerConfig.args = appServer["args"] as string[];
  if (typeof appServer["env"] === "object" && appServer["env"] !== null) {
    appServerConfig.env = appServer["env"] as Record<string, string>;
  }

  return {
    linear: linearConfig,
    workspace: {
      root: workspace["root"] as WorkspaceRoot,
      maxConcurrentAgents: workspace["maxConcurrentAgents"] as number,
    },
    retry: {
      maxAttempts: retry["maxAttempts"] as number,
      maxRetryBackoffMs: retry["maxRetryBackoffMs"] as Millis,
    },
    timeouts: {
      workerRunTimeoutMs: timeouts["workerRunTimeoutMs"] as Millis,
      reviewerRunTimeoutMs: timeouts["reviewerRunTimeoutMs"] as Millis,
      sessionIdleTimeoutMs: timeouts["sessionIdleTimeoutMs"] as Millis,
    },
    appServer: appServerConfig,
  };
}

export async function loadWorkflow(filePath: string): Promise<WorkflowDefinition> {
  const raw = await Bun.file(filePath).text();
  const { yaml, body } = splitFrontMatter(raw);

  const { parse } = await import("yaml");
  const parsed = parse(yaml);
  const frontMatter = validateFrontMatter(parsed);

  return {
    path: filePath,
    revision: ++_revisionCounter,
    loadedAt: new Date().toISOString() as IsoDateTime,
    frontMatter,
    liquidTemplate: body,
  };
}
