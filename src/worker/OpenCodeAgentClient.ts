// src/worker/OpenCodeAgentClient.ts — Agent adapter using @opencode-ai/sdk

import type { OpencodeClient } from "@opencode-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// Public interface (implemented by OpencodeSessionClient and test doubles)
// ─────────────────────────────────────────────────────────────────────────────

export interface TurnRequest {
  sessionId: string;
  cwd: string;
  role: "worker";
  input: string;
}

export interface TurnResult {
  status: "ok" | "failed" | "input_required" | "cancelled";
  summary: string;
  raw?: unknown;
  inputRequest?: string;
}

export interface OpenCodeAgentClient {
  runTurn(req: TurnRequest): Promise<TurnResult>;
  cancelSession?(sessionId: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpencodeSessionClient — concrete @opencode-ai/sdk implementation
//
// Session lifecycle:
//   First call for a given sessionId: create a new OpenCode session (session.create),
//   then send the prompt (session.prompt).
//   Subsequent turns for the same sessionId reuse the existing OpenCode session ID.
//
// session.prompt() is synchronous from the caller’s perspective: it POSTs the message
// and waits until the assistant finishes, then returns {info, parts}.
// We extract the last TextPart text as the turn summary.
// ─────────────────────────────────────────────────────────────────────────────

export class OpencodeSessionClient implements OpenCodeAgentClient {
  /** Maps our logical sessionId → OpenCode session UUID */
  private readonly sessionMap = new Map<string, string>();

  constructor(
    private readonly client: OpencodeClient,
    private readonly agentName: string = "worker",
  ) {}

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    // Step 1: look up or create OpenCode session
    let opencodeSessionId = this.sessionMap.get(req.sessionId);

    if (opencodeSessionId === undefined) {
      const createResult = await this.client.session.create({
        body: { title: req.sessionId },
        query: { directory: req.cwd },
      });
      if (createResult.error) {
        return {
          status: "failed",
          summary: `Failed to create session: ${JSON.stringify(createResult.error)}`,
          raw: createResult.error,
        };
      }
      const sessionData = createResult.data;
      if (!sessionData?.id) {
        return { status: "failed", summary: "session.create returned no ID" };
      }
      opencodeSessionId = sessionData.id;
      this.sessionMap.set(req.sessionId, opencodeSessionId);
    }

    // Step 2: send prompt to the session
    // Step 2: send prompt to the session
    const promptResult = await this.client.session.prompt({
      path: { id: opencodeSessionId },
      body: {
        agent: this.agentName,
        parts: [{ type: "text", text: req.input }],
      },
      query: { directory: req.cwd },
    });

    if (promptResult.error) {
      // Check if the error indicates the session was aborted (user cancel)
      const errStr = JSON.stringify(promptResult.error);
      if (errStr.includes("abort") || errStr.includes("cancel")) {
        return { status: "cancelled", summary: "Session aborted", raw: promptResult.error };
      }
      return {
        status: "failed",
        summary: `session.prompt failed: ${errStr}`,
        raw: promptResult.error,
      };
    }

    const data = promptResult.data;
    if (!data) {
      return { status: "failed", summary: "session.prompt returned no data" };
    }

    // Step 3: parse parts to extract summary text
    const { info, parts } = data;

    // Check for assistant-level errors (model errors, quota, etc.)
    if (info?.error) {
      const errType = (info.error as { type?: string }).type ?? "unknown";
      // MessageAbortedError → cancelled; others → failed
      if (errType === "message_aborted") {
        return { status: "cancelled", summary: "Message aborted", raw: info.error };
      }
      return {
        status: "failed",
        summary: `Assistant error (${errType}): ${(info.error as { message?: string }).message ?? errStr(info.error)}`,
        raw: info.error,
      };
    }

    // Extract summary from last text part
    const textParts = (parts ?? []).filter((p): p is { type: "text"; text: string } & typeof p =>

      p.type === "text" && typeof (p as { text?: unknown }).text === "string",
    );
    const lastText = textParts[textParts.length - 1];
    const summary = lastText
      ? (lastText as { text: string }).text.slice(-2000) // trim to last 2000 chars
      : "(no text output)";

    return { status: "ok", summary, raw: data };
  }

  async cancelSession(sessionId: string): Promise<void> {
    const opencodeSessionId = this.sessionMap.get(sessionId);
    if (opencodeSessionId === undefined) return;
    // Best-effort abort; ignore errors
    try {
      await this.client.session.abort({ path: { id: opencodeSessionId } });
    } catch {
      // ignore
    }
    this.sessionMap.delete(sessionId);
  }
}

// Minimal helper to serialise unknown error objects
function errStr(val: unknown): string {
  if (typeof val === "string") return val;
  try { return JSON.stringify(val); } catch { return String(val); }
}
