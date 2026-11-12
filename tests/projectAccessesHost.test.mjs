import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-access-host-"));
const symbol = Symbol.for("agent-hub-access-host-tests");
let current;
globalThis[symbol] = { get current() { return current; } };
after(async () => { delete globalThis[symbol]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "provider.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/ChatViewProvider.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "isolated-access-host", setup(b) {
    b.onResolve({ filter: /^(vscode|qrcode|node:child_process)$|^\.\/agents\/|^\.\/remoteServer$|^\.\/journal$|^\.\/serverConnection$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      const h = 'globalThis[Symbol.for("agent-hub-access-host-tests")].current';
      if (path === "vscode") return { contents: `import {rename} from "node:fs/promises";export const workspace={workspaceFolders:[],getConfiguration:(section)=>${h}.configuration(section),fs:{rename:async(source,destination)=>rename(source.fsPath,destination.fsPath),delete:async(uri)=>${h}.deleted.push(uri.fsPath)}};export const window={showWarningMessage:async()=>${h}.choices.shift(),showInformationMessage:async()=>{},showErrorMessage:(message)=>${h}.errors.push(message)};export const Uri={file:(fsPath)=>({fsPath})},commands={executeCommand:async()=>{}},ViewColumn={},ConfigurationTarget={Global:1},ProgressLocation={},env={};export class ThemeIcon{};` };
      if (path === "node:child_process") return { contents: 'export const spawn=()=>{throw new Error("unexpected external process")};' };
      if (path === "./journal") return { contents: 'export const readJournalContext=async()=>"";export const buildFinishPrompt=()=>"";' };
      if (path === "./serverConnection") return { resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), contents: `export {buildServerEnvironment,formatSshCommand} from ${JSON.stringify(fileURLToPath(new URL("../src/serverConnection.ts", import.meta.url)))};export const testServerConnection=async(connection,password)=>{${h}.serverTests.push({connection,password});return {ok:true,message:"fixture"};};` };
      if (path === "./remoteServer") return { contents: 'export class RemoteServer{};export const enableTailscaleFunnel=()=>{};export const generateToken=()=>"";export const lanAddresses=()=>[];export const tailscaleInfo=()=>{};' };
      if (path === "qrcode") return { contents: 'export const toString=()=>"";export default {};' };
      return { contents: 'export class ClaudeBackend{};export class CodexBackend{};export class CodexAppServerBackend{};export class CodexWriterRecoveryBackend{};export const codexDefaultModel=()=>"test-model";export const killAllCodex=()=>{};' };
    });
  } }],
});
const { ChatViewProvider } = await import(pathToFileURL(outfile).href);
const cardsKey = key => `agentHub.projectAccesses:${key}`;
const id = "12345678-1234-4234-8234-123456789abc";
const rawStore = (revision = 1, name = "Database") => JSON.stringify({ version: 1, revision, entries: [{ id, name, purpose: "Read reports", values: { password: " fixture-secret\n`$'🔑 ", url: "fixture-private-url" } }] });
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
function setup() {
  const projects = ["one", "two"].map(name => ({ id: `project-${name}`, name, path: join(temp, "shared-folder") }));
  const slots = [0, 1].map(n => ({ chatId: `chat-access-${n}`, projectPath: projects[n].id, recordId: `record-${n}`, agent: "codex" }));
  const values = { projects, autoCommit: false, autoPull: false, "codex.model": "test-model" };
  const global = new Map(), workspace = new Map([["agentHub.multiChats", slots]]), secrets = new Map();
  const h = { projects, slots, values, global, workspace, secrets, messages: [], errors: [], deleted: [], choices: [], reads: [], writes: [], serverTests: [], settingsPosts: 0 };
  h.configuration = section => ({ get: (key, fallback) => values[section === "agentHub" ? key : `${section?.replace(/^agentHub\./, "")}.${key}`] ?? fallback, update: async (key, value) => { await h.beforeConfig?.(key, value); values[key] = value; } });
  current = h;
  const state = data => ({ keys: () => [...data.keys()], get: (key, fallback) => data.has(key) ? data.get(key) : fallback, update: async (key, value) => data.set(key, value) });
  const p = Object.create(ChatViewProvider.prototype);
  p.context = { globalState: state(global), workspaceState: state(workspace), secrets: {
    get: async key => { h.reads.push(key); await h.beforeGet?.(key); return secrets.get(key); },
    store: async (key, value) => { await h.beforeStore?.(key, value); secrets.set(key, value); h.writes.push(key); },
    delete: async key => { secrets.delete(key); h.writes.push(key); },
  } };
  p.runs = new Map(); p.pendingPermissions = new Map(); p.deferred = new Map(); p.steers = new Map(); p.steerTexts = new Map(); p.sessionWriters = new Map();
  p.post = message => h.messages.push(message); p.multiPanel = { webview: { postMessage: message => h.messages.push(message) } };
  p.postSettings = async () => { h.settingsPosts++; }; p.postFullState = () => {}; p.rememberVisibleChoice = async () => {};
  p.listClaudeModels = () => []; p.listCodexModels = () => []; p.codexEffortLevels = () => null;
  h.p = p; h.send = (msg, surface = "multi-panel", source = "vscode") => p.onMessage(msg, source, { send: message => h.messages.push(message) }, surface);
  h.request = (patch = {}) => ({ type: "saveProjectAccess", projectPath: projects[0].id, chatId: slots[0].chatId, requestId: "access-save-1", expectedRevision: 0, access: { name: " Database ", purpose: " Read reports ", values: { password: " fixture-secret\n`$'🔑 ", url: "fixture-private-url" } }, ...patch });
  h.responses = () => h.messages.filter(m => m.type === "projectAccesses");
  return h;
}

test("CRUD stores all card fields only in SecretStorage and public responses never contain values", async () => {
  const h = setup();
  await h.send({ ...h.request(), type: "getProjectAccesses" });
  assert.deepEqual(h.responses().at(-1)?.entries, []);
  await h.send(h.request());
  const response = h.responses().at(-1); assert.equal(response.revision, 1); assert.equal(response.error, undefined);
  assert.match(response.entries[0].id, /^[a-f0-9-]{36}$/); assert.equal(response.entries[0].name, "Database");
  assert.equal(response.projectPath, h.projects[0].id); assert.equal(response.chatId, h.slots[0].chatId); assert.equal(response.requestId, "access-save-1");
  const stored = JSON.parse(h.secrets.get(cardsKey(h.projects[0].id)));
  assert.equal(stored.entries[0].values.password, h.request().access.values.password);
  assert.equal(JSON.stringify(h.responses()).includes("fixture-secret"), false); assert.equal(JSON.stringify(h.responses()).includes("fixture-private-url"), false);
  assert.equal(JSON.stringify([...h.global, ...h.workspace, h.values]).includes("fixture-secret"), false);
  assert.equal(h.settingsPosts, 0);
  const cardId = response.entries[0].id;
  await h.send(h.request({ expectedRevision: 1, access: { id: cardId, name: "Updated", purpose: "Reports", values: { password: "" }, clearFields: ["url"] } }));
  assert.equal(h.responses().at(-1).revision, 2); assert.equal(h.responses().at(-1).entries[0].hasValues.url, false);
  await h.send({ ...h.request(), type: "deleteProjectAccess", id: cardId, expectedRevision: 2 });
  assert.equal(h.responses().at(-1).revision, 3); assert.deepEqual(h.responses().at(-1).entries, []);
});

test("same-folder profiles stay independent and stale or mismatched sources cannot read or mutate", async () => {
  const h = setup(); await h.send(h.request()); const before = h.secrets.get(cardsKey(h.projects[0].id));
  for (const patch of [{ projectPath: h.projects[1].id }, { chatId: "chat-gone" }, { chatId: undefined }, { expectedRevision: 0 }]) {
    await h.send(h.request(patch)); assert.ok(h.responses().at(-1).error); assert.equal(h.secrets.get(cardsKey(h.projects[0].id)), before);
  }
  assert.equal(h.secrets.has(cardsKey(h.projects[1].id)), false);
  const reads = h.reads.length;
  await h.send(h.request({ projectPath: h.projects[1].id })); assert.equal(h.reads.length, reads);
  await h.send(h.request({ projectPath: h.projects[1].id, chatId: h.slots[1].chatId }));
  assert.equal(h.responses().at(-1).revision, 1); assert.equal(h.secrets.size, 2);
});

test("ordinary panels bind to active profile and reject board chat impersonation", async () => {
  const h = setup(); await h.send(h.request({ chatId: undefined }), "view"); assert.equal(h.responses().at(-1).revision, 1);
  await h.send(h.request(), "panel"); assert.ok(h.responses().at(-1).error);
  await h.send(h.request({ chatId: undefined, projectPath: h.projects[1].id }), "panel"); assert.ok(h.responses().at(-1).error);
  assert.equal(h.secrets.has(cardsKey(h.projects[1].id)), false);
});

test("remote clients cannot execute any card operation or receive card summaries", async () => {
  const h = setup(); h.secrets.set(cardsKey(h.projects[0].id), rawStore());
  for (const type of ["getProjectAccesses", "saveProjectAccess", "deleteProjectAccess"]) await h.send({ ...h.request(), type, id }, "view", "remote");
  assert.equal(h.reads.length, 0); assert.equal(h.writes.length, 0); assert.deepEqual(h.responses(), []);
});

test("concurrent writers re-read revisions after the preceding durable write", async () => {
  const h = setup(), entered = gate(), release = gate(); let once = false;
  h.beforeStore = async () => { if (!once) { once = true; entered.resolve(); await release.promise; } };
  const first = h.send(h.request({ requestId: "first" })); await entered.promise;
  const second = h.send(h.request({ requestId: "second" })); await tick(); assert.equal(h.responses().length, 0);
  release.resolve(); await Promise.all([first, second]);
  assert.equal(h.responses().find(m => m.requestId === "first").error, undefined);
  assert.ok(h.responses().find(m => m.requestId === "second").error); assert.equal(h.responses().at(-1).revision, 1); assert.equal(h.writes.length, 1);
});

test("project switch while awaiting reads cancels writes and responses remain addressed to original project", async () => {
  const h = setup(), entered = gate(), release = gate(); let once = false;
  h.beforeGet = async key => { if (key === cardsKey(h.projects[0].id) && !once) { once = true; entered.resolve(); await release.promise; } };
  const pending = h.send(h.request()); await entered.promise;
  await h.p.saveChatSlots([{ ...h.slots[0], projectPath: h.projects[1].id }, h.slots[1]]);
  release.resolve(); await pending;
  assert.deepEqual(h.writes, []); assert.ok(h.responses().at(-1)?.error); assert.equal(h.responses().at(-1).projectPath, h.projects[0].id);
});

test("storage failures and corrupt saved JSON return generic errors and preserve original document", async () => {
  for (const raw of [rawStore(), "{broken", JSON.stringify({ version: 42, entries: [] })]) {
    const h = setup(); h.secrets.set(cardsKey(h.projects[0].id), raw);
    h.beforeStore = async () => { throw new Error("fixture-secret must never appear"); };
    await h.send(h.request({ expectedRevision: 1, access: { id, name: "Change", purpose: "", values: { password: "replacement" } } }));
    assert.ok(h.responses().at(-1).error); assert.equal(h.responses().at(-1).error.includes("fixture-secret"), false);
    assert.equal(h.secrets.get(cardsKey(h.projects[0].id)), raw); assert.equal(h.writes.length, 0);
  }
});

test("malformed envelopes and access patches never coerce or write untrusted content", async () => {
  const h = setup();
  for (const patch of [{ requestId: "" }, { requestId: "x".repeat(161) }, { projectPath: null }, { expectedRevision: "0" }, { expectedRevision: -1 }, { expectedRevision: Number.MAX_SAFE_INTEGER }, { access: null }, { access: { ...h.request().access, values: { password: "\0" } } }]) {
    await h.send(h.request(patch)); assert.ok(h.responses().at(-1)?.error); assert.equal(h.writes.length, 0);
  }
});

test("agent snapshot combines legacy env and named fields while card context and export stay value-free", async () => {
  const h = setup(); h.secrets.set(cardsKey(h.projects[0].id), rawStore()); h.secrets.set(`agentHub.secretEnv:${h.projects[0].id}`, JSON.stringify({ OLD_TOKEN: "legacy-secret" }));
  const snapshot = await h.p.getAgentAccessSnapshot(h.projects[0].id);
  const envName = snapshot.entries[0].envNames.password;
  assert.equal(snapshot.environment[envName], JSON.parse(rawStore()).entries[0].values.password); assert.equal(snapshot.environment.OLD_TOKEN, "legacy-secret");
  const context = await h.p.buildProjectCard(h.projects[0], undefined, snapshot.entries);
  assert.match(context, /Database/); assert.match(context, /Read reports/); assert.ok(context.includes(envName)); assert.equal(context.includes("fixture-secret"), false); assert.equal(context.includes("fixture-private-url"), false);
  assert.equal(JSON.stringify(h.p.collectAllSettings()).includes("Database"), false);
});

test("corrupt card storage cannot prevent opening ordinary project settings", async () => {
  const h = setup(); h.secrets.set(cardsKey(h.projects[0].id), "{broken");
  const settings = await h.p.buildSettingsSnapshot();
  assert.equal(settings.project.id, h.projects[0].id); assert.deepEqual(settings.secretEnvNames, []);
  assert.equal(h.reads.includes(cardsKey(h.projects[0].id)), false);
});

for (const agent of ["claude", "codex"]) {
  for (const resumed of [false, true]) {
    test(`${agent} ${resumed ? "resumed" : "fresh"} runs launch with named card values and public context only`, async () => {
      const h = setup(); await mkdir(h.projects[0].path, { recursive: true });
      h.secrets.set(cardsKey(h.projects[0].id), rawStore());
      h.secrets.set(`agentHub.secretEnv:${h.projects[0].id}`, JSON.stringify({ LEGACY_TOKEN: "legacy-value" }));
      h.secrets.set(`agentHub.serverPassword:${h.projects[0].id}`, "primary-ssh");
      const record = { id: "record-run", createdAt: 1, agentIds: { claude: null, codex: null }, chatLog: [] };
      if (resumed) record.agentIds[agent] = "fixture-resume";
      h.p.ensureActiveRecord = async () => record; h.p.mutateRecord = async (_key, _id, mutate) => mutate(record);
      h.p.relocateAttachments = async (_cwd, attachments) => attachments; h.p.autoPull = async () => {};
      h.p.buildAgentConfig = () => ({ contextWindow: 0 }); h.p.resolveClaudeCli = () => undefined; h.p.claudeModelsStale = () => false;
      let call;
      h.p.backends = { [agent]: { async *start(prompt, options) { call = { prompt, options }; yield { kind: "result", ok: false }; } } };
      await h.p.runTurn("Check saved access", agent, [], h.projects[0].id);
      const name = `AGENT_HUB_ACCESS_${id.replaceAll("-", "").toUpperCase()}_PASSWORD`;
      assert.equal(call.options.extraEnv[name], JSON.parse(rawStore()).entries[0].values.password);
      assert.equal(call.options.extraEnv.LEGACY_TOKEN, "legacy-value"); assert.equal(call.options.extraEnv.SSHPASS, "primary-ssh");
      assert.equal(call.options.resumeSessionId, resumed ? "fixture-resume" : undefined);
      assert.ok(call.prompt.includes(name)); assert.ok(call.prompt.includes("Database")); assert.ok(call.prompt.includes("Read reports"));
      for (const raw of ["fixture-secret", "fixture-private-url", "legacy-value", "primary-ssh"]) {
        assert.equal(call.prompt.includes(raw), false); assert.equal(JSON.stringify(h.messages).includes(raw), false); assert.equal(JSON.stringify(record).includes(raw), false);
      }
      assert.equal(h.reads.filter(key => key === cardsKey(h.projects[0].id)).length, 1);
    });
  }
}

test("concurrent card replacement cannot change context mapping after the run snapshot was captured", async () => {
  const h = setup(); await mkdir(h.projects[0].path, { recursive: true });
  h.secrets.set(cardsKey(h.projects[0].id), rawStore());
  const record = { id: "snapshot-record", createdAt: 1, agentIds: { claude: null, codex: "resume" }, chatLog: [] };
  h.p.ensureActiveRecord = async () => record; h.p.mutateRecord = async (_key, _id, mutate) => mutate(record);
  h.p.relocateAttachments = async (_cwd, attachments) => attachments; h.p.autoPull = async () => {}; h.p.buildAgentConfig = () => ({ contextWindow: 0 });
  const buildCard = h.p.buildProjectCard.bind(h.p);
  const replacementId = "87654321-1234-4234-8234-123456789abc";
  h.p.buildProjectCard = async (...args) => { h.secrets.set(cardsKey(h.projects[0].id), rawStore().replace(id, replacementId).replace("Database", "Replacement")); return buildCard(...args); };
  let call; h.p.backends = { codex: { async *start(prompt, options) { call = { prompt, options }; yield { kind: "result", ok: false }; } } };
  await h.p.runTurn("Check", "codex", [], h.projects[0].id);
  assert.ok(call.prompt.includes("Database")); assert.equal(call.prompt.includes("Replacement"), false);
  const names = Object.keys(call.options.extraEnv).filter(name => name.startsWith("AGENT_HUB_ACCESS_"));
  assert.ok(names.length); for (const name of names) assert.ok(call.prompt.includes(name));
});

test("a switch during store awaits writes only the captured key and acknowledges its original address", async () => {
  const h = setup();
  h.beforeStore = async () => h.p.saveChatSlots([{ ...h.slots[0], projectPath: h.projects[1].id }, h.slots[1]]);
  await h.send(h.request());
  assert.equal(h.secrets.has(cardsKey(h.projects[0].id)), true); assert.equal(h.secrets.has(cardsKey(h.projects[1].id)), false);
  assert.equal(h.responses().at(-1).projectPath, h.projects[0].id); assert.ok(h.responses().at(-1).error);
});

test("duplicate profiles copy the exact new secret document; failure cleans the orphan copy", async () => {
  await mkdir(join(temp, "shared-folder"), { recursive: true });
  for (const fail of [false, true]) {
    const h = setup(); h.secrets.set(cardsKey(h.projects[0].id), rawStore()); h.choices.push("Создать копию");
    if (fail) h.beforeConfig = async key => { if (key === "projects") throw new Error("failure"); };
    await h.p.duplicateProject(h.projects[0].id, false);
    if (fail) assert.deepEqual([...h.secrets.keys()], [cardsKey(h.projects[0].id)]);
    else { const copy = h.values.projects.find(p => !h.projects.includes(p)); assert.ok(copy); assert.equal(h.secrets.get(cardsKey(copy.id)), rawStore()); }
  }
});

test("duplicate card-storage failure keeps secret exception contents out of user errors", async () => {
  const h = setup(); await mkdir(h.projects[0].path, { recursive: true });
  h.secrets.set(cardsKey(h.projects[0].id), rawStore()); h.choices.push("Создать копию");
  h.beforeStore = async key => { if (key.startsWith("agentHub.projectAccesses:")) throw new Error("fixture-secret from storage exception"); };
  await h.p.duplicateProject(h.projects[0].id, false);
  assert.ok(h.errors.length); assert.equal(JSON.stringify(h.errors).includes("fixture-secret"), false);
  assert.deepEqual([...h.secrets.keys()], [cardsKey(h.projects[0].id)]);
});

test("remove from list keeps card document; delete with folder removes only that logical key", async () => {
  for (const choice of ["Убрать из списка", "Удалить вместе с папкой"]) {
    const h = setup(); h.values.projects = [h.projects[0]]; h.secrets.set(cardsKey(h.projects[0].id), rawStore()); h.secrets.set(cardsKey(h.projects[1].id), rawStore(2));
    h.choices.push(choice, "Да, удалить папку");
    await h.p.deleteProject(h.projects[0].id);
    assert.equal(h.secrets.has(cardsKey(h.projects[0].id)), choice === "Убрать из списка"); assert.equal(h.secrets.get(cardsKey(h.projects[1].id)), rawStore(2));
  }
});

test("archive and restore preserve all profile card documents under their logical keys", async () => {
  const h = setup(), folder = join(temp, "archive-work", "active"); await mkdir(folder, { recursive: true });
  for (const project of h.projects) project.path = folder;
  h.secrets.set(cardsKey(h.projects[0].id), rawStore()); h.secrets.set(cardsKey(h.projects[1].id), rawStore(2, "Sibling"));
  const before = [...h.secrets];
  h.choices.push("Архивировать"); await h.p.archiveProject(h.projects[0].id);
  assert.equal(h.p.getArchivedProjects().length, 2, JSON.stringify(h.errors)); assert.deepEqual([...h.secrets], before);
  h.choices.push("Восстановить"); await h.p.restoreProject(h.projects[0].id);
  assert.equal(h.p.getArchivedProjects().length, 0); assert.deepEqual([...h.secrets], before); assert.equal(h.errors.length, 0);
});
