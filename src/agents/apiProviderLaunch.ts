import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTextOnlyApiModel } from "../apiModelParameters";
import { createHash } from "node:crypto";
import { isLoopbackHost, normalizeApiProviderBaseUrl } from "../apiProviderProfiles";
import type { AgentRunConfig, StartOptions } from "./types";

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

export type CodexInferenceLaunch = ReturnType<typeof codexLaunch> & { catalogPath?: string };
type CatalogModel = { slug: string; input_modalities?: string[] };
type Catalog = { models: CatalogModel[] };

function parseCatalog(raw: string): Catalog {
  const catalog: Catalog = JSON.parse(raw);
  if (!Array.isArray(catalog?.models) || catalog.models.some(m => typeof m?.slug !== "string" || !m.slug)) {
    throw new Error("Недопустимый каталог моделей Codex.");
  }
  return catalog;
}

function overlayCatalog(active: Catalog, bundled: Catalog): Catalog {
  const models = [...active.models];
  const longestFirst = [...active.models].sort((a, b) => b.slug.length - a.slug.length);
  for (const fallback of bundled.models) {
    // Codex resolves a slug via the longest native prefix. Derive every descriptor
    // from the original catalog so a text-only parent cannot change Flash's inputs.
    const source = longestFirst.find(model => fallback.slug.startsWith(model.slug));
    const model = { ...(source ?? fallback), slug: fallback.slug };
    if (isTextOnlyApiModel("abliteration", model.slug)) model.input_modalities = ["text"];
    const index = models.findIndex(m => m.slug === model.slug);
    if (index < 0) models.push(model);
    else models[index] = model;
  }
  return { ...active, models };
}

async function readEffectiveCatalog(launch: CodexInferenceLaunch, opts: StartOptions): Promise<string | undefined> {
  const { execFile } = await import("node:child_process");
  // debug models accepts provider -c arguments but does not support --strict-config.
  const args = ["debug", "models", ...launch.args.filter(arg => arg !== "--strict-config")];
  return new Promise((resolve, reject) => {
    execFile("codex", args, {
      cwd: opts.cwd, env: launch.env, signal: opts.signal, encoding: "utf8", windowsHide: true,
      timeout: 10_000, maxBuffer: 16 * 1024 * 1024, killSignal: "SIGKILL",
    }, (error, stdout, stderr) => {
      if (!error) resolve(stdout);
      else if (error.code === 2 && /^error: unrecognized subcommand '(?:debug|models)'(?:\r?\n|$)/.test(stderr)) resolve(undefined);
      else reject(new Error("Не удалось прочитать действующий каталог моделей Codex."));
    });
  });
}

/** One inference run owns its catalog across startup recovery and exec fallback. */
export async function* withCodexInferenceLaunch<T>(
  opts: StartOptions, run: (launch: CodexInferenceLaunch) => AsyncIterable<T>, preparedCatalog?: string,
): AsyncGenerator<T> {
  if (opts.signal.aborted) return;
  const launch: CodexInferenceLaunch = codexLaunch(opts.config, opts.extraEnv);
  if (!isTextOnlyApiModel(opts.config.apiProvider?.id, opts.config.model)) {
    yield* run(launch);
    return;
  }
  let directory: string | undefined;
  try {
    let path = preparedCatalog;
    if (!path) {
      try {
        const raw = await readEffectiveCatalog(launch, opts);
        const bundled = parseCatalog(await readFile(join(__dirname, "abliteration-models.json"), "utf8"));
        const catalog = raw === undefined ? bundled : overlayCatalog(parseCatalog(raw), bundled);
        if (opts.signal.aborted) return;
        directory = await mkdtemp(join(tmpdir(), "agent-hub-models-"));
        path = join(directory, "models.json");
        await writeFile(path, JSON.stringify(catalog), { flag: "wx", mode: 0o600 });
      } catch {
        if (opts.signal.aborted) return;
        // Probe errors and JSON diagnostics can contain private configuration and instructions.
        throw new Error("Не удалось подготовить действующий каталог моделей Codex. Проверьте конфигурацию Codex.");
      }
    }
    if (opts.signal.aborted) return;
    launch.catalogPath = path;
    launch.args.push("-c", `model_catalog_json=${JSON.stringify(path)}`);
    yield* run(launch);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

/** A resume or fork can restore process defaults from persisted history. */
export function verifyCodexProvider(requested: unknown, response: Record<string, unknown>): void {
  if (requested && response.modelProvider !== requested) {
    throw new Error("Codex не подтвердил выбранного API-провайдера. Задание не отправлено.");
  }
}
