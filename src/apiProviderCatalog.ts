import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";
import type { SecretStorage } from "vscode";

export type ProfileSecrets = Pick<SecretStorage, "get" | "store" | "delete"> & Partial<Pick<SecretStorage, "keys">>;

export interface ProfileData {
  read(): unknown;
  write(entries: unknown): PromiseLike<void>;
  secrets: ProfileSecrets;
}

export const PROFILE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const LEGACY_KEY_PREFIX = "agentHub.apiProviderKey.v1:";
const validOwner = (value: string) => value === "abliteration" || PROFILE_UUID.test(value);
const queues = new Map<string, Promise<void>>();

async function acquire(db: DatabaseSync): Promise<void> {
  const deadline = Date.now() + 12_000;
  for (;;) {
    try {
      db.exec("BEGIN IMMEDIATE");
      return;
    } catch (err) {
      // SQLite's synchronous busy timeout would also block the VS Code secret RPC
      // that the current lock owner is awaiting in another view of this process.
      if ((err as {errcode?: number}).errcode !== 5 || Date.now() >= deadline) throw err;
      await delay(25 + Math.random() * 50);
    }
  }
}

/** SQLite owns the writer lock across the secret RPC and releases it if the host exits. */
export async function withDiskProfiles<T>(
  directory: string, legacy: () => unknown, secrets: ProfileSecrets, mutation: boolean,
  operation: (data: ProfileData) => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);
  const previous = queues.get(root) ?? Promise.resolve();
  const result = previous.then(() => transact(root, legacy, secrets, mutation, operation));
  const tail = result.then(() => undefined, () => undefined);
  queues.set(root, tail);
  try { return await result; }
  finally { if (queues.get(root) === tail) queues.delete(root); }
}

async function transact<T>(
  root: string, legacy: () => unknown, secrets: ProfileSecrets, mutation: boolean,
  operation: (data: ProfileData) => Promise<T>,
): Promise<T> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(root, "api-providers.sqlite"));
  const namespace = "agentHub.apiProviderKey.v2:" + createHash("sha256").update(root).digest("hex") + ":";
  const slotOwner = (value: unknown): string | undefined => {
    if (typeof value !== "string" || !value.startsWith(namespace)) return undefined;
    const parts = value.slice(namespace.length).split(":");
    if (parts.length === 2 && validOwner(parts[0]) && PROFILE_UUID.test(parts[1])) return parts[0];
  };
  const legacyOwner = (value: unknown): string | undefined => {
    if (typeof value !== "string" || !value.startsWith(LEGACY_KEY_PREFIX)) return undefined;
    const owner = value.slice(LEGACY_KEY_PREFIX.length);
    return validOwner(owner) ? owner : undefined;
  };
  const invalidReference = () => new Error("Некорректная запись хранилища профилей API.");
  const created: string[] = [];
  const retired = new Set<string>();
  try {
    await acquire(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS catalog (id INTEGER PRIMARY KEY CHECK (id=1), metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (logical TEXT PRIMARY KEY, active TEXT);
      CREATE TABLE IF NOT EXISTS retired (name TEXT PRIMARY KEY);
    `);
    if (!db.prepare("SELECT 1 FROM catalog WHERE id=1").get()) {
      db.prepare("INSERT INTO catalog VALUES (1, ?)").run(JSON.stringify(legacy()));
    }

    const credentials = new Map<string, string | null>();
    for (const { logical, active } of db.prepare("SELECT logical, active FROM credentials").all()) {
      const owner = legacyOwner(logical);
      if (!owner || (active !== null && slotOwner(active) !== owner)) throw invalidReference();
      credentials.set(logical as string, active as string | null);
    }
    const activeName = (logical: string) => {
      if (!legacyOwner(logical)) throw invalidReference();
      return credentials.has(logical) ? credentials.get(logical)! : logical;
    };
    const change = (logical: string, next: string | null) => {
      const prior = activeName(logical);
      if (prior) {
        db.prepare("INSERT OR IGNORE INTO retired VALUES (?)").run(prior);
        retired.add(prior);
      }
      db.prepare("INSERT OR REPLACE INTO credentials VALUES (?, ?)").run(logical, next);
      credentials.set(logical, next);
    };
    if (mutation) {
      // Recover keys retired by a committed transaction and staged keys left by a
      // host crash before commit. Limit enumeration to this catalog's namespace.
      const active = new Set(credentials.values());
      for (const { name } of db.prepare("SELECT name FROM retired").all()) {
        if (typeof name !== "string" || active.has(name) ||
            !(slotOwner(name) || (legacyOwner(name) && credentials.has(name)))) throw invalidReference();
        retired.add(name);
      }
      if (secrets.keys) {
        for (const key of await secrets.keys()) if (slotOwner(key) && !active.has(key)) retired.add(key);
      }
    }
    const data: ProfileData = {
      read: () => JSON.parse(String(db.prepare("SELECT metadata FROM catalog WHERE id=1").get()!.metadata)),
      write: async entries => { db.prepare("UPDATE catalog SET metadata=? WHERE id=1").run(JSON.stringify(entries)); },
      secrets: {
        get: async logical => { const name = activeName(logical); return name ? secrets.get(name) : undefined; },
        store: async (logical, value) => {
          const owner = legacyOwner(logical);
          if (!owner) throw invalidReference();
          const name = namespace + owner + ":" + randomUUID();
          created.push(name);
          await secrets.store(name, value);
          change(logical, name);
        },
        delete: async logical => change(logical, null),
      },
    };
    const result = await operation(data);
    db.exec("COMMIT");
    // Published slots are never reused. Removing superseded slots is safe after
    // the commit even if another process has already acquired the next writer lock.
    for (const name of retired) {
      try {
        await secrets.delete(name);
        db.prepare("DELETE FROM retired WHERE name=?").run(name);
      } catch { /* A later mutation retries cleanup from the durable ledger/key list. */ }
    }
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    for (const name of created) {
      try { await secrets.delete(name); } catch { /* The next mutation collects the orphan. */ }
    }
    throw err;
  } finally {
    db.close();
  }
}
