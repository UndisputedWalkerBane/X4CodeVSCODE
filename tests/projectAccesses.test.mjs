import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-access-unit-"));
after(() => rm(temp, { recursive: true, force: true }));
const outfile = join(temp, "accesses.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/projectAccesses.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
const { parseProjectAccessStore, saveProjectAccess, deleteProjectAccess, summarizeProjectAccesses, mergeProjectAccessEnvironment, projectAccessesKey } = await import(pathToFileURL(outfile).href);
const id = "12345678-1234-4234-8234-123456789abc";
const prefix = "AGENT_HUB_ACCESS_12345678123442348234123456789ABC_";
const input = (patch = {}) => ({ name: "  Database 🔐  ", purpose: "  Reports  ", values: { password: "  secret\n'`$🗝  ", url: "https://fixture.invalid" }, ...patch });
const empty = () => parseProjectAccessStore(undefined);
const create = () => saveProjectAccess(empty(), input(), {}, () => id);

test("cards store exact values and expose only status plus deterministic environment names", () => {
  const store = create();
  assert.equal(store.version, 1); assert.equal(store.revision, 1);
  assert.equal(store.entries[0].name, "Database 🔐"); assert.equal(store.entries[0].purpose, "Reports");
  assert.equal(store.entries[0].values.password, input().values.password);
  assert.deepEqual(summarizeProjectAccesses(store), [{ id, name: "Database 🔐", purpose: "Reports", hasValues: { url: true, login: false, password: true, apiKey: false }, envNames: { url: prefix + "URL", login: prefix + "LOGIN", password: prefix + "PASSWORD", apiKey: prefix + "API_KEY" } }]);
  assert.equal(JSON.stringify(summarizeProjectAccesses(store)).includes("secret"), false);
  assert.equal(projectAccessesKey("project-one"), "agentHub.projectAccesses:project-one");
});

test("blank value patches preserve, explicit clears delete, and immutable edits advance revision", () => {
  const original = create();
  const changed = saveProjectAccess(original, input({ id, name: "Renamed", values: { password: "", login: "alice" }, clearFields: ["url"] }), {});
  assert.equal(changed.entries[0].values.password, input().values.password);
  assert.equal(changed.entries[0].values.login, "alice"); assert.equal(changed.entries[0].values.url, undefined);
  assert.equal(changed.revision, 2); assert.equal(original.revision, 1); assert.equal(original.entries[0].name, "Database 🔐");
  assert.throws(() => saveProjectAccess(original, input({ id, values: {}, clearFields: ["url", "password"] }), {}));
  assert.deepEqual(deleteProjectAccess(original, id), { version: 1, revision: 2, entries: [] });
  assert.throws(() => deleteProjectAccess(original, "87654321-1234-4234-8234-123456789abc"));
});

test("all present values merge with legacy env without touching SSH aliases", () => {
  const legacy = { EXISTING: "fixture", SSHPASS: "ssh-original" };
  const merged = mergeProjectAccessEnvironment(legacy, create());
  assert.deepEqual(merged, { ...legacy, [prefix + "URL"]: input().values.url, [prefix + "PASSWORD"]: input().values.password });
  assert.deepEqual(legacy, { EXISTING: "fixture", SSHPASS: "ssh-original" });
  assert.throws(() => mergeProjectAccessEnvironment({ [prefix + "URL"]: "conflict" }, create()));
  assert.throws(() => saveProjectAccess(empty(), input(), { [prefix + "URL"]: "conflict" }, () => id));
});

test("Windows rejects legacy environment collisions regardless of key casing on save", () => {
  const legacy = { [(prefix + "PASSWORD").toLowerCase()]: "legacy-exact-value" };
  assert.throws(() => saveProjectAccess(empty(), input(), legacy, () => id, "win32"));
  assert.deepEqual(legacy, { [(prefix + "PASSWORD").toLowerCase()]: "legacy-exact-value" });
});

test("Windows rejects legacy environment collisions regardless of key casing on merge", () => {
  const legacy = { [(prefix + "PASSWORD").toLowerCase()]: "legacy-exact-value" };
  const store = create();
  assert.throws(() => mergeProjectAccessEnvironment(legacy, store, "win32"));
  assert.equal(store.entries[0].values.password, input().values.password);
});

for (const platform of ["linux", "darwin"]) {
  test(`${platform} preserves case-sensitive environment names and exact card values`, () => {
    const lowerName = (prefix + "PASSWORD").toLowerCase();
    const legacy = { [lowerName]: "legacy-exact-value" };
    const store = saveProjectAccess(empty(), input(), legacy, () => id, platform);
    const merged = mergeProjectAccessEnvironment(legacy, store, platform);
    assert.equal(merged[lowerName], "legacy-exact-value");
    assert.equal(merged[prefix + "PASSWORD"], input().values.password);
    assert.equal(merged[prefix + "URL"], input().values.url);
    assert.throws(() => saveProjectAccess(empty(), input(), { [prefix + "PASSWORD"]: "collision" }, () => id, platform));
    assert.throws(() => mergeProjectAccessEnvironment({ [prefix + "PASSWORD"]: "collision" }, store, platform));
  });
}

test("untrusted input rejects unknown fields, invalid types, malformed ids and bounded payloads", () => {
  const bad = [null, [], {}, input({ name: " " }), input({ name: "x".repeat(121) }), input({ purpose: "x".repeat(1001) }), input({ id: "bad" }), input({ values: null }), input({ values: [] }), input({ values: { password: 12 } }), input({ values: { password: "x".repeat(16385) } }), input({ values: { unknown: "x" } }), input({ clearFields: ["bad"] }), input({ unexpected: true }), input({ values: {} })];
  for (const value of bad) assert.throws(() => saveProjectAccess(empty(), value, {}, () => id), undefined, JSON.stringify(value)?.slice(0, 80));
  assert.throws(() => saveProjectAccess(empty(), input(), {}, () => "bad"));
  assert.throws(() => saveProjectAccess(create(), input(), {}, () => id));
});

test("corrupt stored documents fail closed and cannot erase existing cards", () => {
  assert.deepEqual(empty(), { version: 1, revision: 0, entries: [] });
  assert.deepEqual(parseProjectAccessStore(JSON.stringify(create())), create());
  const bad = ["", "{", "null", "[]", "{}", JSON.stringify({ ...create(), version: 2 }), JSON.stringify({ ...create(), revision: -1 }), JSON.stringify({ ...create(), revision: Number.MAX_SAFE_INTEGER }), JSON.stringify({ ...create(), entries: [...create().entries, ...create().entries] }), JSON.stringify({ ...create(), extra: true }), "x".repeat(1048577)];
  for (const raw of bad) assert.throws(() => parseProjectAccessStore(raw));
});

test("fifty cards are allowed; a fifty-first or oversized serialized store is rejected", () => {
  let store = empty();
  for (let n = 0; n < 50; n++) store = saveProjectAccess(store, input(), {}, () => `12345678-1234-4234-8234-${n.toString(16).padStart(12, "0")}`);
  assert.equal(store.entries.length, 50);
  assert.throws(() => saveProjectAccess(store, input(), {}, () => "12345678-1234-4234-8234-ffffffffffff"));
  let large = empty();
  assert.throws(() => { for (let n = 0; n < 50; n++) large = saveProjectAccess(large, input({ values: { url: "x".repeat(16384), login: "x".repeat(16384), password: "x".repeat(16384), apiKey: "x".repeat(16384) } }), {}, () => `12345678-1234-4234-8234-${n.toString(16).padStart(12, "0")}`); });
});
