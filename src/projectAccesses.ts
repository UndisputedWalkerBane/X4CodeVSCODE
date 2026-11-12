import { randomUUID } from "node:crypto";
import type { ProjectAccessField, ProjectAccessInput, ProjectAccessSummary } from "./shared/projectAccesses";

const FIELDS: readonly ProjectAccessField[] = ["url", "login", "password", "apiKey"];
const SUFFIX: Record<ProjectAccessField, string> = { url: "URL", login: "LOGIN", password: "PASSWORD", apiKey: "API_KEY" };
const MAX_CARDS = 50;
const MAX_BYTES = 1024 * 1024;
const INVALID = "Некорректные данные доступов проекта. Запись не изменена.";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface StoredProjectAccess {
  id: string;
  name: string;
  purpose: string;
  values: Partial<Record<ProjectAccessField, string>>;
}

/** Host-only representation, including credentials. Never post or persist in configuration. */
export interface ProjectAccessStore {
  version: 1;
  revision: number;
  entries: StoredProjectAccess[];
}

function invalid(): never { throw new Error(INVALID); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !value.includes("\0");
}
function validValues(value: unknown): value is Partial<Record<ProjectAccessField, string>> {
  return object(value) && keys(value, FIELDS) && Object.values(value).every(v => text(v, 16384));
}
function checkSize(store: ProjectAccessStore): ProjectAccessStore {
  if (Buffer.byteLength(JSON.stringify(store), "utf8") > MAX_BYTES) invalid();
  return store;
}
function names(id: string): Record<ProjectAccessField, string> {
  const prefix = `AGENT_HUB_ACCESS_${id.replace(/-/g, "").toUpperCase()}_`;
  return Object.fromEntries(FIELDS.map(field => [field, prefix + SUFFIX[field]])) as Record<ProjectAccessField, string>;
}
function checkCollisions(store: ProjectAccessStore, legacy: Record<string, string>, platform: NodeJS.Platform): void {
  // Windows process environments match names without regard to casing.
  const legacyNames = new Set(Object.keys(legacy).map(name => platform === "win32" ? name.toUpperCase() : name));
  for (const entry of store.entries) {
    if (Object.values(names(entry.id)).some(name => legacyNames.has(name))) invalid();
  }
}

export function projectAccessesKey(logicalKey: string): string {
  return `agentHub.projectAccesses:${logicalKey}`;
}

/** A malformed document is an error, never an empty replacement store. */
export function parseProjectAccessStore(raw: string | undefined): ProjectAccessStore {
  if (raw === undefined) return { version: 1, revision: 0, entries: [] };
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_BYTES) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { invalid(); }
  if (!object(parsed) || !keys(parsed, ["version", "revision", "entries"]) || parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.revision) || (parsed.revision as number) < 0 || (parsed.revision as number) >= Number.MAX_SAFE_INTEGER ||
      !Array.isArray(parsed.entries) || parsed.entries.length > MAX_CARDS) invalid();
  const ids = new Set<string>();
  for (const entry of parsed.entries) {
    if (!object(entry) || !keys(entry, ["id", "name", "purpose", "values"]) || typeof entry.id !== "string" || !ID.test(entry.id) ||
        ids.has(entry.id) || !text(entry.name, 120) || !entry.name.trim() || !text(entry.purpose, 1000) || !validValues(entry.values) ||
        !Object.values(entry.values).some(value => value.length > 0) || Object.values(entry.values).some(value => !value.length)) invalid();
    ids.add(entry.id);
  }
  return parsed as unknown as ProjectAccessStore;
}

export function summarizeProjectAccesses(store: ProjectAccessStore): ProjectAccessSummary[] {
  return store.entries.map(entry => ({ id: entry.id, name: entry.name, purpose: entry.purpose,
    hasValues: Object.fromEntries(FIELDS.map(field => [field, Boolean(entry.values[field])])) as Record<ProjectAccessField, boolean>,
    envNames: names(entry.id) }));
}

/** Returns a new document only. The caller must compare revisions and persist durably. */
export function saveProjectAccess(store: ProjectAccessStore, input: ProjectAccessInput, legacy: Record<string, string>, createId: () => string = randomUUID, platform: NodeJS.Platform = process.platform): ProjectAccessStore {
  if (!object(input) || !keys(input, ["id", "name", "purpose", "values", "clearFields"]) ||
      !text(input.name, 120) || !input.name.trim() || !text(input.purpose, 1000) ||
      (input.id !== undefined && (typeof input.id !== "string" || !ID.test(input.id))) ||
      (input.values !== undefined && !validValues(input.values)) ||
      (input.clearFields !== undefined && (!Array.isArray(input.clearFields) || input.clearFields.length > FIELDS.length ||
        input.clearFields.some(field => !FIELDS.includes(field)))) || store.revision >= Number.MAX_SAFE_INTEGER - 1) invalid();
  const current = input.id === undefined ? undefined : store.entries.find(entry => entry.id === input.id);
  if ((input.id !== undefined && !current) || (!current && store.entries.length >= MAX_CARDS)) invalid();
  const id = current?.id ?? createId();
  if (typeof id !== "string" || !ID.test(id) || (!current && store.entries.some(entry => entry.id === id))) invalid();
  const values = { ...current?.values };
  for (const field of input.clearFields ?? []) delete values[field];
  for (const field of FIELDS) {
    const value = input.values?.[field];
    if (value !== undefined && value !== "") {
      if (input.clearFields?.includes(field)) invalid();
      values[field] = value;
    }
  }
  if (!Object.values(values).length) invalid();
  const next: StoredProjectAccess = { id, name: input.name.trim(), purpose: input.purpose.trim(), values };
  const updated: ProjectAccessStore = { version: 1, revision: store.revision + 1,
    entries: current ? store.entries.map(entry => entry.id === id ? next : entry) : [...store.entries, next] };
  checkCollisions(updated, legacy, platform);
  return checkSize(updated);
}

export function deleteProjectAccess(store: ProjectAccessStore, id: string): ProjectAccessStore {
  if (typeof id !== "string" || !ID.test(id) || !store.entries.some(entry => entry.id === id) || store.revision >= Number.MAX_SAFE_INTEGER - 1) invalid();
  return { version: 1, revision: store.revision + 1, entries: store.entries.filter(entry => entry.id !== id) };
}

/** Existing environment is unchanged. Card values can never override legacy keys. */
export function mergeProjectAccessEnvironment(legacy: Record<string, string>, store: ProjectAccessStore, platform: NodeJS.Platform = process.platform): Record<string, string> {
  checkCollisions(store, legacy, platform);
  const result = { ...legacy };
  for (const entry of store.entries) {
    const envNames = names(entry.id);
    for (const field of FIELDS) {
      if (entry.values[field] !== undefined) result[envNames[field]] = entry.values[field]!;
    }
  }
  return result;
}
