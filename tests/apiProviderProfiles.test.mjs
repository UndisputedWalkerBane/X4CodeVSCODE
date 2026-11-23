import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-providers-"));
after(() => rm(temp, { recursive: true, force: true }));
const outfile = join(temp, "profiles.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/apiProviderProfiles.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
const { ApiProviderProfileStore } = await import(pathToFileURL(outfile).href);

const preset = { id: "abliteration", name: "Abliteration.ai", baseUrl: "https://api.abliteration.ai/v1", model: "abliterated-model" };
const custom = { name: "Тест 🔐", baseUrl: "https://service.invalid/v1", model: "org/model:7b" };
function fixture() {
  const records = new Map();
  const keys = new Map();
  const globalState = {
    get: key => structuredClone(records.get(key)),
    update: async (key, value) => { await Promise.resolve(); records.set(key, structuredClone(value)); },
  };
  const secrets = {
    get: async key => keys.get(key),
    store: async (key, value) => { keys.set(key, value); },
    delete: async key => { keys.delete(key); },
  };
  const open = () => new ApiProviderProfileStore(globalState, secrets);
  return { records, keys, globalState, secrets, open, store: open() };
}

test("preset fixes its identity and endpoint while persisting model and optional effort defaults", async () => {
  const { store, records, keys, open } = fixture();
  assert.deepEqual(await store.list(), [{ ...preset, builtIn: true, hasApiKey: false }]);
  await assert.rejects(store.resolve(preset.id));
  for (const patch of [{ name: "Changed" }, { baseUrl: custom.baseUrl }, { effort: "max" }, { effort: [] }]) {
    await assert.rejects(store.save({ ...preset, ...patch, apiKey: "fixture-key" }));
  }
  await assert.rejects(store.remove(preset.id));
  assert.deepEqual(await store.save({ ...preset, apiKey: "fixture-key" }), { ...preset, builtIn: true, hasApiKey: true });
  assert.deepEqual(await store.resolve(preset.id), { ...preset, apiKey: "fixture-key" });
  assert.equal(records.size, 0);
  const customProfile = await store.save(custom);
  const savedKeys = [...keys];
  const defaults = { ...preset, model: "abliterated-model-large-v2", effort: "max" };
  await store.save(defaults);
  assert.deepEqual(await open().catalog(), [defaults, { ...custom, id: customProfile.id }]);
  assert.deepEqual(await open().resolve(preset.id), { ...defaults, apiKey: "fixture-key" });
  assert.deepEqual([...keys], savedKeys);
  await store.save({ id: preset.id, apiKey: "fixture-replacement" });
  assert.deepEqual(await open().resolve(preset.id), { ...defaults, apiKey: "fixture-replacement" });
  await store.save({ ...preset, model: "my-custom-model" });
  assert.deepEqual((await open().catalog())[0], { ...preset, model: "my-custom-model" });
  assert.ok(!JSON.stringify([...records.values()]).includes("fixture-key"));
  await store.clearApiKey(preset.id);
  assert.equal((await store.list())[0].hasApiKey, false);
  await assert.rejects(store.resolve(preset.id));
});

test("multiple profiles persist separately, with keys absent from summaries and metadata", async () => {
  const { store, open, records, keys } = fixture();
  const first = await store.save({ ...custom, name: " Тест 🔐 ", baseUrl: custom.baseUrl + "/", apiKey: "fixture-key-A" });
  const second = await store.save({ ...custom, apiKey: "fixture-key-B" });
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first, { ...custom, id: first.id, builtIn: false, hasApiKey: true });
  assert.deepEqual(await open().list(), [{ ...preset, builtIn: true, hasApiKey: false }, first, second]);
  assert.ok(!JSON.stringify([...records.values()]).includes("fixture-key"));
  assert.deepEqual(await open().resolve(first.id), { ...custom, id: first.id, apiKey: "fixture-key-A" });
  const edited = await store.save({ ...custom, model: "other", id: first.id, effort: "high", apiKey: "" });
  assert.equal(edited.hasApiKey, true);
  assert.equal((await open().catalog())[1].effort, "high");
  await assert.rejects(store.save({ ...custom, id: first.id, effort: "outside-protocol" }));
  assert.equal((await store.resolve(first.id)).apiKey, "fixture-key-A");
  await store.remove(first.id);
  await assert.rejects(store.resolve(first.id));
  assert.equal(keys.size, 1);
  assert.equal((await store.resolve(second.id)).apiKey, "fixture-key-B");
});

test("chat catalogs load without opening credential storage", async () => {
  const { store, secrets } = fixture();
  const profile = await store.save({ ...custom, apiKey: "fixture-key" });
  secrets.get = () => assert.fail("chat hydration must not request stored credentials");
  assert.deepEqual(await store.catalog(), [preset, { ...custom, id: profile.id }]);
});

test("a changed endpoint (even a different path) requires an explicit replacement credential", async () => {
  const { store, records, keys } = fixture();
  const { id } = await store.save({ ...custom, apiKey: "fixture-old" });
  for (const baseUrl of [custom.baseUrl + "/other", "https://other.invalid"]) {
    await assert.rejects(store.save({ ...custom, baseUrl, id, apiKey: "" }));
    assert.equal((await store.resolve(id)).baseUrl, custom.baseUrl);
  }
  const [stateKey, saved] = [...records][0];
  records.set(stateKey, JSON.parse(JSON.stringify(saved).replace(custom.baseUrl, "https://changed.invalid/v1")));
  await assert.rejects(store.resolve(id));
  assert.equal((await store.list())[1].hasApiKey, false);
  records.set(stateKey, saved);
  const changed = await store.save({ ...custom, baseUrl: "https://new.invalid/v2", id, apiKey: "fixture-new" });
  assert.equal((await store.resolve(id)).apiKey, "fixture-new");
  assert.equal(changed.baseUrl, "https://new.invalid/v2");
  assert.ok(!JSON.stringify([...keys.values()]).includes("fixture-old"));
  const local = await store.save({ ...custom, id, baseUrl: "http://localhost:1234/v1", apiKey: "" });
  assert.equal(local.hasApiKey, false);
  assert.equal((await store.resolve(id)).apiKey, undefined);
  assert.equal(keys.size, 0);
});

test("changing a key by itself checks the endpoint observed before the prompt", async () => {
  const { open, secrets } = await desktopFixture();
  const store = open();
  const { id } = await store.save({ ...custom, apiKey: "old-address-key" });
  const newUrl = "https://another.invalid/v2";
  await open().save({ id, baseUrl: newUrl, apiKey: "new-address-key" });
  const activeSlots = await secrets.keys();
  await assert.rejects(store.save({ id, apiKey: "stale-prompt-key" }, custom.baseUrl));
  await assert.rejects(store.save({ id, apiKey: "unbound-prompt-key" }));
  await assert.rejects(store.save({ id, baseUrl: custom.baseUrl, apiKey: "stale-form-key" }, custom.baseUrl));
  await store.save({ id, model: "changed-model", effort: "high" });
  assert.deepEqual(await open().resolve(id), { ...custom, id, model: "changed-model", effort: "high", baseUrl: newUrl, apiKey: "new-address-key" });
  assert.deepEqual(await secrets.keys(), activeSlots);
  await store.save({ id, apiKey: "refreshed-prompt-key" }, newUrl);
  assert.equal((await open().resolve(id)).apiKey, "refreshed-prompt-key");
});

test("unauthenticated local endpoints work; http, fragments, credentials, and unbounded inputs are validated", async () => {
  const { store } = fixture();
  for (const baseUrl of ["http://127.0.0.1:1234/v1", "http://127.1.2.3/test", "http://[::1]:8000", "http://localhost:11434/v1", "https://localhost/v1"]) {
    const { id, hasApiKey } = await store.save({ ...custom, baseUrl });
    assert.equal(hasApiKey, false);
    assert.deepEqual(await store.resolve(id), { ...custom, id, baseUrl });
  }
  for (const baseUrl of ["http://192.168.0.1", "http://127.example.org", "http://localhost.example.org", "file:///tmp", "/v1", "https:///example.org", "https://a.invalid?#", "https://a.invalid?", "https://a.invalid#", "https://user:pass@a.invalid", "https://@a.invalid", "https://a.invalid/\npath", "https://a.invalid\\other", "https://a.invalid/" + "x".repeat(2048)]) {
    await assert.rejects(store.save({ ...custom, baseUrl }), undefined, baseUrl);
  }
  for (const patch of [{ model: "" }, { name: " " }, { model: [] }, { name: "x".repeat(200) }, { model: "x".repeat(10000) }, { apiKey: "x".repeat(20000) }, { apiKey: "line\r\nother" }, { id: "forged" }, { name: "a\nb" }]) {
    await assert.rejects(store.save({ ...custom, ...patch }));
  }
  for (const invalid of [null, undefined, [], {}]) await assert.rejects(store.save(invalid));
  for (const operation of ["remove", "resolve", "clearApiKey"]) await assert.rejects(store[operation]("missing"));
});

test("queued mutations preserve every profile and recover after validation and storage failures", async () => {
  const { store, open, globalState, secrets, keys } = fixture();
  const other = open();
  const [a, b] = await Promise.all([store.save({ ...custom, apiKey: "fixture-original" }), other.save({ ...custom, name: "B" })]);
  assert.deepEqual((await store.list()).map(p => p.id), [preset.id, a.id, b.id]);
  const update = globalState.update;
  globalState.update = async () => { throw Error("unavailable"); };
  await assert.rejects(store.save({ ...custom, id: a.id, baseUrl: "https://new.invalid", apiKey: "fixture-replacement" }));
  await assert.rejects(store.remove(a.id));
  assert.equal((await store.resolve(a.id)).apiKey, "fixture-original");
  await assert.rejects(store.save({ ...custom, apiKey: "fixture-new" }));
  assert.equal(keys.size, 1);
  globalState.update = update;
  const set = secrets.store;
  secrets.store = async () => { throw Error("unavailable"); };
  await assert.rejects(store.save({ ...custom, id: a.id, baseUrl: "https://new.invalid", apiKey: "fixture-replacement" }));
  assert.equal((await store.resolve(a.id)).apiKey, "fixture-original");
  secrets.store = set;
  await store.remove(a.id);
  assert.deepEqual((await store.list()).map(p => p.id), [preset.id, b.id]);
});

test("invalid, duplicated or oversized persisted metadata fails closed without altering profiles", async () => {
  const { store, records } = fixture();
  const profile = await store.save(custom);
  const [storageKey, initial] = [...records][0];
  const raw = JSON.stringify(initial);
  for (const damaged of [null, {}, [preset, preset], [{ ...preset, effort: "max" }],
    JSON.parse(raw.replace(profile.id, preset.id)), JSON.parse(raw.replace(custom.baseUrl, "http://remote.invalid"))]) {
    records.set(storageKey, damaged);
    await assert.rejects(store.list());
    await assert.rejects(store.save(custom));
    assert.deepEqual(records.get(storageKey), damaged);
  }
  records.set(storageKey, initial);
  for (let i = 1; i < 50; i++) await store.save(custom);
  await store.save({ id: preset.id, model: preset.model, effort: "high" });
  await assert.rejects(store.save(custom));
  assert.equal((await store.list()).length, 51);
});

test("native settings change defaults without prompting for or exposing the preset key", async t => {
  const managerFile = join(temp, "settings.mjs");
  const symbol = Symbol.for("agent-hub-test.api-provider-settings");
  const prompts = [];
  const answers = ["fixture-manager-key", undefined];
  const picks = [];
  globalThis[symbol] = {
    showQuickPick: async items => {
      const select = picks.shift();
      if (select === null) return undefined;
      if (select === undefined) return items[0];
      const item = items.find(select);
      assert.ok(item, "requested option is visible");
      return item;
    },
    showInputBox: async options => { prompts.push(options); return answers.shift(); },
    showInformationMessage: async () => {},
  };
  t.after(() => { delete globalThis[symbol]; });
  await build({
    entryPoints: [fileURLToPath(new URL("../src/apiProviderSettings.ts", import.meta.url))],
    outfile: managerFile, bundle: true, platform: "node", format: "esm",
    plugins: [{ name: "native-inputs", setup(plugin) {
      plugin.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }));
      plugin.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: 'export const window = globalThis[Symbol.for("agent-hub-test.api-provider-settings")];',
      }));
    } }],
  });
  const { manageApiProviderSettings } = await import(pathToFileURL(managerFile).href);
  const { store } = fixture();
  const presetPick = item => item.profile?.id === preset.id;
  const editKey = item => item.action === "key";
  const defaults = item => item.action === "defaults";
  const model = item => item.value === "abliterated-model-large-v2";
  const effort = item => item.value === "max";
  picks.push(presetPick, editKey);
  await manageApiProviderSettings(store);
  picks.push(presetPick, editKey);
  await manageApiProviderSettings(store);
  picks.push(presetPick, defaults, model, null);
  await manageApiProviderSettings(store);
  assert.deepEqual(await store.resolve(preset.id), { ...preset, apiKey: "fixture-manager-key" });
  picks.push(presetPick, defaults, model, effort);
  await manageApiProviderSettings(store);
  assert.deepEqual(await store.resolve(preset.id), { ...preset, model: "abliterated-model-large-v2", effort: "max", apiKey: "fixture-manager-key" });
  picks.push(presetPick, defaults, model, item => item.value === "");
  await manageApiProviderSettings(store);
  assert.deepEqual(await store.resolve(preset.id), { ...preset, model: "abliterated-model-large-v2", apiKey: "fixture-manager-key" });
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every(p => p.password === true && p.value === undefined));
  assert.ok(!JSON.stringify(prompts).includes("fixture-manager-key"));
  picks.push(presetPick, defaults, item => item.value === "", item => item.value === "");
  answers.push("org/custom:7b");
  await manageApiProviderSettings(store);
  assert.equal((await store.resolve(preset.id)).model, "org/custom:7b");
  assert.equal(prompts.at(-1).validateInput("model\nother")?.length > 0, true);

  const { id } = await store.save({ ...custom, apiKey: "current-key" });
  picks.push(item => item.profile?.id === id, item => item.action === "edit");
  globalThis[symbol].showInputBox = async options => {
    if (!options.password) return options.value;
    await store.save({ id, baseUrl: "https://another.invalid/v1", apiKey: "other-address-key" });
    return "stale-dialog-key";
  };
  await assert.rejects(manageApiProviderSettings(store));
  assert.equal((await store.resolve(id)).baseUrl, "https://another.invalid/v1");
  assert.equal((await store.resolve(id)).apiKey, "other-address-key");
  picks.push(item => item.profile?.id === id, defaults, item => item.value === "high");
  globalThis[symbol].showInputBox = async () => {
    await store.save({ id, baseUrl: "https://third.invalid/v1", apiKey: "third-address-key" });
    return "stale-model";
  };
  await assert.rejects(manageApiProviderSettings(store));
  assert.equal((await store.resolve(id)).model, custom.model);
});

function diskSecrets(directory, afterStore = async () => {}) {
  const file = key => join(directory, Buffer.from(key).toString("base64url"));
  return {
    keys: async () => (await readdir(directory)).map(name => Buffer.from(name, "base64url").toString()),
    get: async key => {
      try { return await readFile(file(key), "utf8"); }
      catch (err) { if (err.code !== "ENOENT") throw err; }
    },
    store: async (key, value) => {
      await writeFile(file(key), value);
      await afterStore();
    },
    delete: key => rm(file(key), { force: true }),
  };
}

const workerFile = join(temp, "profile-worker.mjs");
await writeFile(workerFile, `
  import { once } from "node:events";
  import { readFile, readdir, rm, writeFile } from "node:fs/promises";
  import { join } from "node:path";
  import { ApiProviderProfileStore } from ${JSON.stringify(pathToFileURL(outfile).href)};
  ${diskSecrets.toString()}
  const { root, vault, input, hold } = JSON.parse(process.argv[2]);
  const store = new ApiProviderProfileStore({ get: () => [] }, diskSecrets(vault, async () => {
    if (!hold) return;
    const resume = once(process, "message");
    process.send("staged");
    await resume;
  }), root);
  process.send("started");
  try { process.send(await store.save(input)); }
  catch (err) { process.exitCode = 1; console.error(err); }
  process.disconnect();
`);

function worker(t, root, vault, input, hold = false) {
  const child = fork(workerFile, [JSON.stringify({ root, vault, input, hold })], {
    stdio: ["ignore", "ignore", "inherit", "ipc"], execArgv: [],
  });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  const started = once(child, "message").then(([message]) => assert.equal(message, "started"));
  let staged;
  let result;
  child.on("message", message => {
    if (message === "staged") staged();
    if (typeof message === "object") result(message);
  });
  return { child, exited, started, staged: new Promise(resolve => { staged = resolve; }),
    result: new Promise(resolve => { result = resolve; }) };
}

async function desktopFixture() {
  const root = await mkdtemp(join(temp, "global-storage-"));
  const vault = join(root, "fake-secret-storage");
  await mkdir(vault);
  const secrets = diskSecrets(vault);
  const open = (state = { get: () => undefined }) => new ApiProviderProfileStore(state, secrets, root);
  return { root, vault, secrets, open };
}

test("independent extension hosts retain concurrent writes and subsequent independent reads", { timeout: 10_000 }, async t => {
  const { root, vault, open } = await desktopFixture();
  const a = worker(t, root, vault, { ...custom, name: "first", apiKey: "cross-window-first" }, true);
  await a.staged;
  const b = worker(t, root, vault, { ...custom, name: "second", apiKey: "cross-window-second" });
  await b.started;
  a.child.send("release");
  const [first, second] = await Promise.all([a.result, b.result]);
  const left = open();
  const right = open();
  assert.deepEqual((await right.catalog()).map(p => p.id), [preset.id, first.id, second.id]);
  await Promise.all([left.save({ ...custom, id: first.id, name: "edited" }), right.remove(second.id)]);
  assert.deepEqual((await left.catalog()).map(p => p.name), [preset.name, "edited"]);
  assert.equal((await right.resolve(first.id)).apiKey, "cross-window-first");
  await assert.rejects(left.resolve(second.id));
  assert.ok(!(await readFile(join(root, "api-providers.sqlite"))).includes("cross-window-first"));
});

test("a killed host releases its writer lock, preserves the previous bound key, and leaves a collectible staged credential", { timeout:10_000 }, async t => {
  const { root, vault, open, secrets } = await desktopFixture();
  const store = open();
  const first = await store.save({ ...custom, apiKey: "original-credential" });
  const interrupted = worker(t, root, vault, { ...custom, id: first.id,
    baseUrl: "https://another.invalid/v2", apiKey: "unpublished-credential" }, true);
  await interrupted.staged;
  interrupted.child.kill("SIGKILL");
  await interrupted.exited;
  assert.equal((await secrets.keys()).length, 2);
  assert.deepEqual(await open().resolve(first.id), { ...custom, id: first.id, apiKey: "original-credential" });
  await store.save({ ...custom, id: first.id, name: "after crash" });
  assert.equal((await secrets.keys()).length, 1);
  const updated = await open().save({ ...custom, id: first.id, baseUrl: "https://another.invalid/v2", apiKey: "new-credential" });
  assert.equal((await store.resolve(updated.id)).apiKey, "new-credential");
  assert.equal((await secrets.keys()).length, 1);
});

test("desktop migration reads legacy metadata once and chat hydration never opens the secret store", async () => {
  const { root, open, secrets } = await desktopFixture();
  const legacy = { ...custom, model: "Legacy name with spaces", id: "02468ace-0101-4210-8221-012345679abc" };
  const state = { get: () => [legacy] };
  const forbidden = () => assert.fail("catalog must only read public metadata");
  const reader = new ApiProviderProfileStore(state, { get:forbidden, keys:forbidden, store:forbidden, delete:forbidden }, root);
  assert.deepEqual(await reader.catalog(), [preset, legacy]);
  await secrets.store("agentHub.apiProviderKey.v1:" + legacy.id, JSON.stringify({ baseUrl:custom.baseUrl, apiKey:"legacy-fixture" }));
  await secrets.store("agentHub.apiProviderKey.v1:" + preset.id, JSON.stringify({ baseUrl:preset.baseUrl, apiKey:"preset-legacy-fixture" }));
  state.get = forbidden;
  assert.equal((await open(state).resolve(legacy.id)).apiKey, "legacy-fixture");
  const keysBefore = await secrets.keys();
  await open(state).save({ id: preset.id, model: preset.model, effort: "high" });
  assert.deepEqual(await reader.catalog(), [{ ...preset, effort: "high" }, legacy]);
  assert.deepEqual(await open(state).resolve(preset.id), { ...preset, effort: "high", apiKey: "preset-legacy-fixture" });
  assert.deepEqual(await secrets.keys(), keysBefore);
  await open(state).remove(legacy.id);
  assert.deepEqual(await reader.catalog(), [{ ...preset, effort: "high" }]);
  await open(state).clearApiKey(preset.id);
  assert.deepEqual(await secrets.keys(), []);
});

test("corrupt disk references cannot read or remove unrelated SecretStorage entries", async () => {
  const { root, secrets, open } = await desktopFixture();
  const profile = await open().save({ ...custom, apiKey: "own-fake-key" });
  const unrelated = "agentHub.projectSecret:fictional-project";
  await secrets.store(unrelated, "unrelated-fixture-key");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(root, "api-providers.sqlite"));
  try {
    db.prepare("INSERT INTO retired VALUES (?)").run(unrelated);
    await assert.rejects(open().clearApiKey(profile.id));
    assert.equal(await secrets.get(unrelated), "unrelated-fixture-key");
    db.prepare("DELETE FROM retired WHERE name=?").run(unrelated);
    db.prepare("UPDATE credentials SET active=?").run(unrelated);
    let accessed = false;
    const reader = new ApiProviderProfileStore({ get: () => [] }, {
      ...secrets, get: async key => { accessed = true; return secrets.get(key); },
    }, root);
    await assert.rejects(reader.resolve(profile.id));
    assert.equal(accessed, false);
  } finally { db.close(); }
});

test("two profiles on the same endpoint cannot borrow or retire each other's live key", async () => {
  const { root, open } = await desktopFixture();
  const store = open();
  const a = await store.save({ ...custom, apiKey: "owner-a-fake" });
  const b = await store.save({ ...custom, apiKey: "owner-b-fake" });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(root, "api-providers.sqlite"));
  try {
    const aLogical = "agentHub.apiProviderKey.v1:" + a.id;
    const bLogical = "agentHub.apiProviderKey.v1:" + b.id;
    const lookup = db.prepare("SELECT active FROM credentials WHERE logical=?");
    const aKey = lookup.get(aLogical).active;
    const bKey = lookup.get(bLogical).active;
    const redirect = db.prepare("UPDATE credentials SET active=? WHERE logical=?");
    redirect.run(bKey, aLogical);
    await assert.rejects(store.resolve(a.id));
    redirect.run(aKey, aLogical);
    db.prepare("INSERT INTO retired VALUES (?)").run(bKey);
    await assert.rejects(store.remove(a.id));
    assert.equal((await store.resolve(b.id)).apiKey, "owner-b-fake");
    assert.equal((await store.resolve(a.id)).apiKey, "owner-a-fake");
  } finally { db.close(); }
});

test("transient SecretStorage failures roll back desktop metadata and release the transaction", async () => {
  const { root, secrets, open } = await desktopFixture();
  const { id } = await open().save({ ...custom, apiKey: "original-safe" });
  const unavailable = new ApiProviderProfileStore({get: () => []}, {
    ...secrets,
    store: async (name, value) => {
      await secrets.store(name, value);
      throw Error("interrupted secret RPC");
    },
  }, root);
  await assert.rejects(unavailable.save({ ...custom, id, baseUrl: "https://another.invalid", apiKey: "never-committed" }));
  assert.deepEqual(await open().resolve(id), { ...custom, id, apiKey: "original-safe" });
  assert.equal((await secrets.keys()).length, 1);
});
