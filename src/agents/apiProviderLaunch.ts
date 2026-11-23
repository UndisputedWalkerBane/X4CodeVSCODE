import { createHash } from "node:crypto";
import { isLoopbackHost, normalizeApiProviderBaseUrl } from "../apiProviderProfiles";
import type { AgentRunConfig } from "./types";

const PROVIDER_KEY_ENV = "AGENT_HUB_RESPONSES_API_KEY";

export function codexLaunch(config: AgentRunConfig, extraEnv?: Record<string, string>) {
  const env = { ...process.env, ...extraEnv };
  const args: string[] = [];
  const thread: { modelProvider?: string; model?: string } = {};
  const provider = config.apiProvider;
  // Some gateways include the submitted bearer token in authentication errors.
  const redact = (text: string) => provider?.apiKey ? text.replaceAll(provider.apiKey, "[скрыто]") : text;
  if (!provider) return { env, args, thread, redact };

  const baseUrl = normalizeApiProviderBaseUrl(provider.baseUrl);
  if (!config.model?.trim() || !provider.id || !provider.name) throw new Error("Не указаны профиль API или модель.");
  if (!provider.apiKey && !isLoopbackHost(new URL(baseUrl).hostname)) throw new Error("Укажите ключ API в настройках профиля.");

  // A changed endpoint gets a distinct native identity; rotating the key preserves history.
  const identity = createHash("sha256").update(JSON.stringify([provider.id, baseUrl])).digest("hex");
  thread.modelProvider = `agent_hub_${identity}`;
  thread.model = config.model;
  const prefix = `model_providers.${thread.modelProvider}`;
  args.push("--strict-config"); // Older CLIs must reject an unsupported shell credential filter.
  const set = (key: string, value: string | boolean) => args.push("-c", `${key}=${JSON.stringify(value)}`);
  set("model_provider", thread.modelProvider);
  set("model", config.model);
  set(`${prefix}.name`, provider.name);
  set(`${prefix}.base_url`, baseUrl);
  set(`${prefix}.wire_api`, "responses");
  set(`${prefix}.supports_websockets`, false);
  set(`${prefix}.requires_openai_auth`, false);
  set("web_search", "disabled");
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === PROVIDER_KEY_ENV) delete env[name];
  }
  if (provider.apiKey) {
    env[PROVIDER_KEY_ENV] = provider.apiKey;
    set(`${prefix}.env_key`, PROVIDER_KEY_ENV);
    set(`shell_environment_policy.filters.${PROVIDER_KEY_ENV}`, "exclude");
    set("features.shell_snapshot", false);
  }
  return { env, args, thread, redact };
}

/** A resume or fork can restore process defaults from persisted history. */
export function verifyCodexProvider(requested: unknown, response: Record<string, unknown>): void {
  if (requested && response.modelProvider !== requested) {
    throw new Error("Codex не подтвердил выбранного API-провайдера. Задание не отправлено.");
  }
}
