import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { formatSshCommand, type ServerConnection } from "./serverConnection";
import type { ProjectAccessConnectionField, ProjectAccessConnectionInput, ProjectAccessField, ProjectAccessInput, ProjectAccessProtocol, ProjectAccessSummary } from "./shared/projectAccesses";

const FIELDS: readonly ProjectAccessField[] = ["url", "login", "password", "apiKey"];
const CONNECTION_FIELDS: readonly ProjectAccessConnectionField[] = ["url", "login", "password"];
const SUFFIX: Record<ProjectAccessField, string> = { url: "URL", login: "LOGIN", password: "PASSWORD", apiKey: "API_KEY" };
const MAX_CARDS = 50;
const MAX_BYTES = 1024 * 1024;
const INVALID = "Некорректные данные доступов проекта. Запись не изменена.";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface StoredProjectAccess {
  id: string;
  name: string;
  purpose: string;
  protocol?: ProjectAccessProtocol;
  port?: number;
  repository?: string;
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
function validProtocol(value: unknown): value is ProjectAccessProtocol {
  return value === "ssh" || value === "sftp" || value === "ftp";
}
function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Public repository references cannot carry URL credentials, fragments or tokens in a query. */
function repositoryReference(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!text(value, 2048) || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  const repository = value.trim();
  if (!repository) return undefined;
  if (/[\s?#\\]/.test(repository)) invalid();
  let decoded: string;
  try { decoded = decodeURIComponent(repository); } catch { invalid(); }
  if (/[\u0000-\u0020\u007f]/.test(decoded) || /(?:github_pat_|gh[pousr]_|glpat-|xox[baprs]-|AKIA[0-9A-Z]{16})/i.test(decoded)) invalid();
  if (/^git@[a-zA-Z0-9][a-zA-Z0-9._-]*:[^?#\\\s]+$/.test(repository)) return repository;
  let url: URL;
  try { url = new URL(repository); } catch { invalid(); }
  const authority = /^[a-z]+:\/\/([^/]+)/i.exec(repository)?.[1];
  if (!url.hostname || url.password || url.search || url.hash || url.pathname.length <= 1 ||
      (url.protocol === "https:" ? !authority || authority.includes("@") : url.protocol !== "ssh:" || !authority?.startsWith("git@") || url.username !== "git")) invalid();
  return repository;
}

function metadata(value: { protocol?: unknown; port?: unknown; repository?: unknown }) {
  if ((value.protocol !== undefined && !validProtocol(value.protocol)) || (value.port !== undefined && !validPort(value.port))) invalid();
  const repository = repositoryReference(value.repository);
  return { ...(value.protocol === undefined ? {} : { protocol: value.protocol as ProjectAccessProtocol }),
    ...(value.port === undefined ? {} : { port: value.port as number }), ...(repository === undefined ? {} : { repository }) };
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
    if (!object(entry) || !keys(entry, ["id", "name", "purpose", "values", "protocol", "port", "repository"]) || typeof entry.id !== "string" || !ID.test(entry.id) ||
        ids.has(entry.id) || !text(entry.name, 120) || !entry.name.trim() || !text(entry.purpose, 1000) || !validValues(entry.values) ||
        !Object.values(entry.values).some(value => value.length > 0) || Object.values(entry.values).some(value => !value.length)) invalid();
    ids.add(entry.id);
    metadata(entry);
  }
  return parsed as unknown as ProjectAccessStore;
}

export function summarizeProjectAccesses(store: ProjectAccessStore): ProjectAccessSummary[] {
  return store.entries.map(entry => ({ id: entry.id, name: entry.name, purpose: entry.purpose,
    ...metadata(entry),
    hasValues: Object.fromEntries(FIELDS.map(field => [field, Boolean(entry.values[field])])) as Record<ProjectAccessField, boolean>,
    envNames: names(entry.id) }));
}

/** Returns a new document only. The caller must compare revisions and persist durably. */
export function saveProjectAccess(store: ProjectAccessStore, input: ProjectAccessInput, legacy: Record<string, string>, createId: () => string = randomUUID, platform: NodeJS.Platform = process.platform): ProjectAccessStore {
  if (!object(input) || !keys(input, ["id", "name", "purpose", "values", "clearFields", "protocol", "port", "repository"]) ||
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
  const next: StoredProjectAccess = { id, name: input.name.trim(), purpose: input.purpose.trim(), values, ...metadata(input) };
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

/** Resolve a check draft without persisting it or consulting primary-server/legacy credentials. */
export function resolveProjectAccessConnection(store: ProjectAccessStore, input: ProjectAccessConnectionInput): { connection: ServerConnection; password: string } {
  if (!object(input) || !keys(input, ["id", "protocol", "port", "values", "clearFields"]) || !validProtocol(input.protocol) ||
      (input.id !== undefined && (typeof input.id !== "string" || !ID.test(input.id))) ||
      (input.port !== undefined && !validPort(input.port)) ||
      (input.values !== undefined && (!validValues(input.values) || !keys(input.values, CONNECTION_FIELDS))) ||
      (input.clearFields !== undefined && (!Array.isArray(input.clearFields) || input.clearFields.length > CONNECTION_FIELDS.length || input.clearFields.some(field => !CONNECTION_FIELDS.includes(field))))) invalid();
  const current = input.id === undefined ? undefined : store.entries.find(entry => entry.id === input.id);
  if (input.id !== undefined && !current) invalid();
  const values: Partial<Record<ProjectAccessConnectionField, string>> = {};
  for (const field of CONNECTION_FIELDS) {
    if (!input.clearFields?.includes(field) && current?.values[field] !== undefined) values[field] = current.values[field];
    const patch = input.values?.[field];
    if (patch !== undefined && patch !== "") {
      if (input.clearFields?.includes(field)) invalid();
      values[field] = patch;
    }
  }
  if (!values.url || !values.login || /[\s\u0000-\u001f\u007f]/.test(values.url)) invalid();
  let authority = values.url;
  if (authority.includes("://")) {
    const match = /^(ssh|sftp|ftp):\/\/([^/?#]+)\/?$/.exec(authority);
    if (!match || match[1] !== input.protocol) invalid();
    authority = match[2];
  }
  let host = authority, addressPort: number | undefined;
  if (authority.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(authority);
    if (!match || isIP(match[1]) !== 6) invalid();
    host = match[1]; addressPort = match[2] === undefined ? undefined : Number(match[2]);
  } else if (isIP(authority) !== 6 && authority.includes(":")) {
    const match = /^([^:]+):([0-9]+)$/.exec(authority);
    if (!match) invalid();
    host = match[1]; addressPort = Number(match[2]);
  }
  if ((addressPort !== undefined && !validPort(addressPort)) ||
      (addressPort !== undefined && input.port !== undefined && addressPort !== input.port)) invalid();
  const port = input.port ?? addressPort;
  const connection: ServerConnection = { host, user: values.login, protocol: input.protocol, ...(port === undefined ? {} : { port }) };
  // Reuse the existing helper's host/user/option validation for all three protocols.
  try { formatSshCommand({ ...connection, protocol: "ssh" }, "key"); } catch { invalid(); }
  return { connection, password: values.password ?? "" };
}
