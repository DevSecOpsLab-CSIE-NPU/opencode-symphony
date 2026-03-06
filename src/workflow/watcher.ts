import { watch } from "node:fs";
import type { WorkflowDefinition } from "../orchestrator/types.js";
import { loadWorkflow } from "./loader.js";

export function watchWorkflow(
  filePath: string,
  onReload: (def: WorkflowDefinition) => void,
): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(filePath, () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      try {
        const def = await loadWorkflow(filePath);
        onReload(def);
      } catch (err) {
        console.warn("[watchWorkflow] reload failed, keeping last-good config:", err);
      }
    }, 200);
  });

  return () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    watcher.close();
  };
}
