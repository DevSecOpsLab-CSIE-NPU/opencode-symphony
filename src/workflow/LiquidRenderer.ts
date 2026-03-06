import { Liquid } from "liquidjs";
import type { LinearIssue } from "../orchestrator/types.js";

/**
 * GOTCHA: liquidjs with `strictVariables: true` will throw on `{% if optional_var %}`
 * if the variable is missing from the context. Use `{% if optional_var != undefined %}`
 * pattern or ensure defaults are provided for all variables referenced in the template.
 *
 * Only `issue` (LinearIssue) and `attempt` (number) are allowed as top-level variables.
 */
export class WorkflowTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WORKFLOW_TEMPLATE_ERROR";
  }
}

export class LiquidRenderer {
  private readonly engine: Liquid;

  constructor() {
    this.engine = new Liquid({
      strictVariables: true,
      strictFilters: true,
    });
  }

  async renderWorkflow(
    workflowMarkdownBody: string,
    vars: { issue: LinearIssue; attempt: number },
  ): Promise<string> {
    try {
      return await this.engine.parseAndRender(workflowMarkdownBody, {
        issue: vars.issue,
        attempt: vars.attempt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new WorkflowTemplateError(`Liquid render failed: ${msg}`);
    }
  }
}
