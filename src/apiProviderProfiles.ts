import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { Memento } from "vscode";
import { apiEffortLevels, isValidApiModelId } from "./apiModelParameters";
import { LEGACY_KEY_PREFIX, PROFILE_UUID, withDiskProfiles, type ProfileData, type ProfileSecrets } from "./apiProviderCatalog";

export interface ApiProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  effort?: string;
}

export interface ApiProviderProfileSummary extends ApiProviderProfile {
  builtIn: boolean;
  hasApiKey: boolean;
}

export type ApiProviderProfileInput = (
  | (Omit<ApiProviderProfile, "id"> & { id?: undefined })
  | (Partial<ApiProviderProfile> & { id: string })
) & { apiKey?: string };
export type ResolvedApiProviderProfile = ApiProviderProfile & { apiKey?: string };

export const ABLITERATION_PROFILE: Readonly<ApiProviderProfile> = Object.freeze({
  id: "abliteration",
  name: "Abliteration.ai",
  baseUrl: "https://api.abliteration.ai/v1",
  model: "abliterated-model",
});

const CATALOG = "agentHub.apiProviderProfiles.v1";
const MAX_PROFILES = 50;
const MAX_KEY = 8192;
const writes = new WeakMap<Memento, Promise<void>>();

class ProfileError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function field(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length > limit || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ProfileError("Укажите корректные название, адрес API и модель.");
  }
  return value.trim();
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || (isIP(hostname) === 4 && hostname.startsWith("127."));
}

export function normalizeApiProviderBaseUrl(value: unknown): string {
  const message = "Укажите базовый HTTPS URL без логина, пароля, параметров и фрагмента. HTTP доступен для localhost.";
  if (typeof value !== "string" || value.length > 2048 || /[\s\x00-\x1f\x7f\\?#]/.test(value)) throw new ProfileError(message);
  const authority = /^https?:\/\/([^/]+)/i.exec(value)?.[1];
  if (!authority || authority.includes("@")) throw new ProfileError(message);
  let url: URL;
  try { url = new URL(value); } catch { throw new ProfileError(message); }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) throw new ProfileError(message);
  const normalized = url.href.replace(/\/+$/, "");
  if (normalized.length > 2048) throw new ProfileError(message);
  return normalized;
}

function metadata(source: Record<string, unknown>, id: string): ApiProviderProfile {
  const name = field(source.name, 120);
  const baseUrl = normalizeApiProviderBaseUrl(source.baseUrl);
  const model = field(source.model, 256);
  if (id === ABLITERATION_PROFILE.id && (name !== ABLITERATION_PROFILE.name || baseUrl !== ABLITERATION_PROFILE.baseUrl)) {
    throw new ProfileError("Название и адрес встроенного профиля менять нельзя.");
  }
  const effort = source.effort;
  if (effort === undefined) return { id, name, baseUrl, model };
  if (typeof effort !== "string" || !effort || !apiEffortLevels(id, model).includes(effort)) {
    throw new ProfileError("Выберите доступный для этой модели уровень effort.");
  }
  return { id, name, baseUrl, model, effort };
}

function validKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_KEY && /^[\x21-\x7e]+$/.test(value);
}

function summary(profile: ApiProviderProfile, hasApiKey: boolean): ApiProviderProfileSummary {
  return { ...profile, builtIn: profile.id === ABLITERATION_PROFILE.id, hasApiKey };
}

function storedEntries(profiles: ApiProviderProfile[]): ApiProviderProfile[] {
  return profiles.filter(profile => profile.id !== ABLITERATION_PROFILE.id ||
    profile.model !== ABLITERATION_PROFILE.model || profile.effort !== undefined);
}

function lookup(profiles: ApiProviderProfile[], id: string): ApiProviderProfile {
  const profile = profiles.find(entry => entry.id === id);
  if (!profile) throw new ProfileError("Профиль API не найден.");
  return profile;
}

function secretName(id: string): string {
  return LEGACY_KEY_PREFIX + id;
}

function readBoundKey(value: string | undefined, baseUrl: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= MAX_KEY * 2 + 4096) {
    const bound: unknown = JSON.parse(value);
    if (record(bound) && typeof bound.baseUrl === "string" && validKey(bound.apiKey)) {
      return bound.baseUrl === baseUrl ? bound.apiKey : undefined;
    }
  }
  throw new ProfileError("Не удалось прочитать ключ API из защищённого хранилища.");
}

/** Desktop hosts use the shared local catalog; in-memory hosts use their Memento. */
export class ApiProviderProfileStore {
  constructor(private readonly state: Memento, private readonly secrets: ProfileSecrets, private readonly directory?: string) {}

  private run<T>(operation: (data: ProfileData) => Promise<T>, mutation = false): Promise<T> {
    const read = () => this.state.get<unknown>(CATALOG);
    const previous = writes.get(this.state) ?? Promise.resolve();
    const result = previous.then(() => this.directory
      ? withDiskProfiles(this.directory, () => storedEntries(this.profiles(read())), this.secrets, mutation, operation)
      : operation({ read, write: entries => this.state.update(CATALOG, entries), secrets: this.secrets })
    ).catch((error: unknown) => {
      if (error instanceof ProfileError) throw error;
      // Storage and JSON parser errors can include the input, including a key.
      throw new ProfileError("Не удалось прочитать или сохранить профиль API. Проверьте хранилище VS Code.");
    });
    writes.set(this.state, result.then(() => undefined, () => undefined));
    return result;
  }

  private profiles(entries: unknown): ApiProviderProfile[] {
    if (entries === undefined) return [{ ...ABLITERATION_PROFILE }];
    const message = "Повреждён список профилей API.";
    if (!Array.isArray(entries) || entries.length > MAX_PROFILES + 1) throw new ProfileError(message);
    const ids = new Set<string>();
    const custom: ApiProviderProfile[] = [];
    let preset: ApiProviderProfile = { ...ABLITERATION_PROFILE };
    for (const entry of entries) {
      if (!record(entry) || Object.keys(entry).some(key => !["id", "name", "baseUrl", "model", "effort"].includes(key)) ||
          typeof entry.id !== "string" || (entry.id !== preset.id && !PROFILE_UUID.test(entry.id)) || ids.has(entry.id)) throw new ProfileError(message);
      ids.add(entry.id);
      const profile = metadata(entry, entry.id);
      if (profile.id === preset.id) preset = profile;
      else custom.push(profile);
    }
    if (custom.length > MAX_PROFILES) throw new ProfileError(message);
    return [preset, ...custom];
  }

  /** Opening or restoring a chat only needs public metadata. */
  catalog(): Promise<ApiProviderProfile[]> {
    return this.run(async data => this.profiles(data.read()));
  }

  list(): Promise<ApiProviderProfileSummary[]> {
    return this.run(async data => Promise.all(this.profiles(data.read()).map(async profile =>
      summary(profile, !!readBoundKey(await data.secrets.get(secretName(profile.id)), profile.baseUrl)))));
  }

  resolve(id: string): Promise<ResolvedApiProviderProfile> {
    return this.run(async data => {
      const profile = lookup(this.profiles(data.read()), id);
      const apiKey = readBoundKey(await data.secrets.get(secretName(id)), profile.baseUrl);
      if (apiKey) return { ...profile, apiKey };
      if (!isLoopbackHost(new URL(profile.baseUrl).hostname)) throw new ProfileError("Укажите ключ API в настройках профиля.");
      return { ...profile };
    });
  }

  save(input: ApiProviderProfileInput, expectedBaseUrl?: string): Promise<ApiProviderProfileSummary> {
    return this.run(async data => {
      if (!record(input)) throw new ProfileError("Некорректный профиль API.");
      const profiles = this.profiles(data.read());
      const current = input.id === undefined ? undefined : lookup(profiles, input.id);
      // A key-only edit of a mutable endpoint must identify the address shown in its dialog.
      const requiresExpectedUrl = !!current && current.id !== ABLITERATION_PROFILE.id && !!input.apiKey && input.baseUrl === undefined;
      if ((expectedBaseUrl !== undefined || requiresExpectedUrl) && expectedBaseUrl !== current?.baseUrl) {
        throw new ProfileError("Откройте профиль снова и проверьте текущий адрес API перед сохранением.");
      }
      if (!current && profiles.length >= MAX_PROFILES + 1) throw new ProfileError("Достигнут лимит профилей API.");
      if (input.model !== undefined && input.model !== current?.model && !isValidApiModelId(input.model)) {
        throw new ProfileError("Укажите корректный идентификатор модели.");
      }
      // Model and effort form a pair. A credential-only edit retains both current defaults.
      const fields = input.model === undefined ? { ...current, ...input } : { ...current, ...input, effort: input.effort };
      const next = metadata(fields, current?.id ?? randomUUID());
      const sameMetadata = !!current && current.name === next.name && current.model === next.model &&
        current.baseUrl === next.baseUrl && current.effort === next.effort;
      const replacement = input.apiKey === "" ? undefined : input.apiKey;
      if (replacement !== undefined && !validKey(replacement)) throw new ProfileError("Некорректный ключ API.");
      const addressChanged = !!current && current.baseUrl !== next.baseUrl;
      if (addressChanged && !replacement && !isLoopbackHost(new URL(next.baseUrl).hostname)) {
        throw new ProfileError("При изменении адреса API укажите ключ для нового адреса.");
      }
      const key = secretName(next.id);
      const original = await data.secrets.get(key);
      const apiKey = replacement ?? (addressChanged ? undefined : readBoundKey(original, next.baseUrl));
      const discardPreviousKey = addressChanged && !replacement && original !== undefined;
      if (replacement) await data.secrets.store(key, JSON.stringify({ baseUrl: next.baseUrl, apiKey: replacement }));
      else if (discardPreviousKey) await data.secrets.delete(key);
      if (!sameMetadata) {
        const entries = current ? profiles.map(profile => profile.id === current.id ? next : profile) : [...profiles, next];
        await this.persist(data, entries, key, original, !!replacement || discardPreviousKey);
      }
      return summary(next, !!apiKey);
    }, true);
  }

  remove(id: string): Promise<void> {
    return this.run(async data => {
      const profiles = this.profiles(data.read());
      const profile = lookup(profiles, id);
      if (profile.id === ABLITERATION_PROFILE.id) throw new ProfileError("Встроенный профиль удалить нельзя.");
      const key = secretName(id);
      const original = await data.secrets.get(key);
      if (original !== undefined) await data.secrets.delete(key);
      await this.persist(data, profiles.filter(entry => entry.id !== id), key, original, original !== undefined);
    }, true);
  }

  clearApiKey(id: string): Promise<void> {
    return this.run(async data => {
      lookup(this.profiles(data.read()), id);
      await data.secrets.delete(secretName(id));
    }, true);
  }

  /** Roll back the credential if the second write (catalog metadata) fails. */
  private async persist(data: ProfileData, entries: ApiProviderProfile[], key: string, original: string | undefined, changed: boolean): Promise<void> {
    try {
      await data.write(storedEntries(entries));
    } catch (error) {
      if (changed) {
        if (original === undefined) await data.secrets.delete(key);
        else await data.secrets.store(key, original);
      }
      throw error;
    }
  }
}
