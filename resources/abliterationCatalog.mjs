import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const catalogInputs = ["../src/abliterationModels.json", "codex/prompt.md"]
  .map(path => fileURLToPath(new URL(path, import.meta.url)));

// Codex requires complete entries. Match its generic third-party model metadata and
// instructions so a change in accepted inputs does not select another agent preset.
// https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/models-manager/src/model_info.rs
export async function renderAbliterationCatalog() {
  const [models, instructions] = await Promise.all([
    readFile(catalogInputs[0], "utf8").then(JSON.parse),
    readFile(catalogInputs[1], "utf8"),
  ]);
  const entries = models.map(({ id, images }) => ({
    slug: id,
    display_name: id,
    input_modalities: images ? ["text", "image"] : ["text"],
    base_instructions: instructions,
    supported_reasoning_levels: [],
    default_reasoning_summary: "auto",
    shell_type: "unified_exec",
    visibility: "none",
    priority: 99,
    supported_in_api: true,
    include_apps_usage_instructions: false,
    support_verbosity: false,
    web_search_tool_type: "text",
    truncation_policy: { mode: "bytes", limit: 10000 },
    context_window: 272000,
    max_context_window: 272000,
    experimental_supported_tools: [],
  }));
  return JSON.stringify({ models: entries });
}
