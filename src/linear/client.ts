import type { LinearIssue, IssueId, IssueKey, IsoDateTime } from "../orchestrator/types.js";

const DEFAULT_API_URL = "https://api.linear.app/graphql";

// Retryable: server-side / transient failures (5xx, rate limit 429)
export class LinearUnavailableError extends Error {
  override readonly name = "LINEAR_UNAVAILABLE" as const;
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

// Fatal: auth failures (401/403), bad GQL variables, schema errors
export class LinearGqlError extends Error {
  override readonly name = "LINEAR_GQL_ERROR" as const;
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

/** @deprecated Use LinearUnavailableError or LinearGqlError instead */
export class LinearError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "LinearError";
  }
}

export class LinearClient {
  private readonly apiUrl: string;

  constructor(
    private readonly apiKey: string,
    apiUrl?: string,
  ) {
    this.apiUrl = apiUrl ?? DEFAULT_API_URL;
  }

  private async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Linear API requires "Bearer <apiKey>" format
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    // 401/403 → fatal auth error
    if (res.status === 401 || res.status === 403) {
      throw new LinearGqlError(`Auth error HTTP ${res.status}: ${res.statusText}`, res.status);
    }

    // 429 rate limit or 5xx server error → retryable
    if (res.status === 429 || res.status >= 500) {
      throw new LinearUnavailableError(`HTTP ${res.status}: ${res.statusText}`, res.status);
    }

    if (!res.ok) {
      throw new LinearGqlError(`HTTP ${res.status}: ${res.statusText}`, res.status);
    }

    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string; extensions?: { type?: string } }> };

    if (json.errors && json.errors.length > 0) {
      const msg = json.errors.map((e) => e.message).join("; ");
      // GQL variable errors / permission errors → fatal
      throw new LinearGqlError(msg);
    }

    if (!json.data) {
      throw new LinearGqlError("Empty response from Linear API");
    }

    return json.data;
  }

  async getActiveIssues(params: { teamIds?: string[]; states?: string[] }): Promise<LinearIssue[]> {
    const { GET_ACTIVE_ISSUES } = await import("./queries.js");
    type Response = { issues: { nodes: RawIssue[] } };
    const data = await this.request<Response>(GET_ACTIVE_ISSUES, {
      teamIds: params.teamIds,
      states: params.states,
    });
    return data.issues.nodes.map(normalizeIssue);
  }

  async getIssue(id: string): Promise<LinearIssue | null> {
    const { GET_ISSUE } = await import("./queries.js");
    type Response = { issue: RawIssue | null };
    const data = await this.request<Response>(GET_ISSUE, { id });
    return data.issue ? normalizeIssue(data.issue) : null;
  }

  async getWorkflowStates(teamId: string): Promise<Array<{ id: string; name: string; type: string }>> {
    const { GET_WORKFLOW_STATES } = await import("./queries.js");
    type Response = { workflowStates: { nodes: Array<{ id: string; name: string; type: string }> } };
    const data = await this.request<Response>(GET_WORKFLOW_STATES, { teamId });
    return data.workflowStates.nodes;
  }

  async updateIssueState(id: string, stateId: string): Promise<void> {
    const { UPDATE_ISSUE_STATE } = await import("./mutations.js");
    type Response = { issueUpdate: { success: boolean } };
    const data = await this.request<Response>(UPDATE_ISSUE_STATE, { id, stateId });
    if (!data.issueUpdate.success) {
      throw new LinearGqlError(`issueUpdate failed for issue ${id}`);
    }
  }

  async addComment(issueId: string, body: string): Promise<{ id: string; url: string }> {
    const { ADD_COMMENT } = await import("./mutations.js");
    type Response = { commentCreate: { success: boolean; comment: { id: string; url: string; body: string } } };
    const data = await this.request<Response>(ADD_COMMENT, { issueId, body });
    if (!data.commentCreate.success) {
      throw new LinearGqlError(`commentCreate failed for issue ${issueId}`);
    }
    return data.commentCreate.comment;
  }

  async linkPRAttachment(issueId: string, title: string, url: string): Promise<{ id: string; url: string }> {
    const { LINK_PR_ATTACHMENT } = await import("./mutations.js");
    type Response = { attachmentCreate: { success: boolean; attachment: { id: string; url: string; title: string } } };
    const data = await this.request<Response>(LINK_PR_ATTACHMENT, { issueId, title, url });
    if (!data.attachmentCreate.success) {
      throw new LinearGqlError(`attachmentCreate failed for issue ${issueId}`);
    }
    return data.attachmentCreate.attachment;
  }
}

interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description?: string;
  state: { id: string; name: string; type?: string };
  priority?: number;
  assignee?: { id: string; name: string } | null;
  labels: { nodes: Array<{ name: string }> };
  updatedAt: string;
  createdAt: string;
}

function normalizeIssue(raw: RawIssue): LinearIssue {
  return {
    id: raw.id as IssueId,
    key: raw.identifier as IssueKey,
    title: raw.title,
    url: raw.url,
    ...(raw.description !== undefined && { description: raw.description }),
    state: (() => {
      const s: LinearIssue["state"] = { id: raw.state.id, name: raw.state.name };
      const t = raw.state.type as "triage" | "backlog" | "started" | "completed" | "canceled" | undefined;
      if (t !== undefined) s.type = t;
      return s;
    })(),
    ...(raw.priority !== undefined && { priority: raw.priority }),
    assignee: raw.assignee ?? null,
    labels: raw.labels.nodes.map((l) => l.name),
    updatedAt: raw.updatedAt as IsoDateTime,
    createdAt: raw.createdAt as IsoDateTime,
  };
}
