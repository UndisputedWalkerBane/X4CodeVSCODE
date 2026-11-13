import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-live-host-"));
const symbol = Symbol.for("agent-hub-live-host-tests");
let current;
globalThis[symbol] = { get current() { return current; } };
after(async () => { delete globalThis[symbol]; await rm(temp, { recursive: true, force: true }); });
afterEach(async () => { await current?.finish?.(); });
const outfile = join(temp, "provider.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/ChatViewProvider.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "isolated-live-host", setup(b) {
    b.onResolve({ filter: /^(vscode|qrcode|node:child_process)$|^\.\/agents\/|^\.\/remoteServer$|^\.\/journal$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      const h = 'globalThis[Symbol.for("agent-hub-live-host-tests")].current';
      if (path === "vscode") return { contents: `export const workspace={workspaceFolders:[],getConfiguration:(section)=>${h}.configuration(section)};export const window={showQuickPick:async(items,options)=>${h}.pick(items,options),showInputBox:async()=>${h}.inputs.shift(),createQuickPick:()=>${h}.quickPick(),showWarningMessage:async()=>undefined,showInformationMessage:async(message)=>${h}.infos.push(message),showErrorMessage:(message)=>${h}.errors.push(message)};export const Uri={file:(fsPath)=>({fsPath})},commands={executeCommand:async()=>{}},ViewColumn={},ConfigurationTarget={Global:1},ProgressLocation={},env={};export class ThemeIcon{};` };
      if (path === "node:child_process") return { contents: 'export const spawn=()=>{throw new Error("unexpected external process")};' };
      if (path === "./journal") return { contents: 'export const readJournalContext=async()=>"";export const buildFinishPrompt=()=>"";' };
      if (path === "./remoteServer") return { contents: 'export class RemoteServer{};export const enableTailscaleFunnel=()=>{};export const generateToken=()=>"";export const lanAddresses=()=>[];export const tailscaleInfo=()=>{};' };
      if (path === "qrcode") return { contents: 'export const toString=()=>"";export default {};' };
      return { contents: 'export class ClaudeBackend{};export class CodexBackend{};export class CodexAppServerBackend{};export class CodexWriterRecoveryBackend{};export const codexDefaultModel=()=>"test-model";export const killAllCodex=()=>{};' };
    });
  } }],
});
const { ChatViewProvider } = await import(pathToFileURL(outfile).href);
// These isolated fixtures exercise POSIX live delivery on all CI operating systems.
// The dedicated Windows case below overrides this to verify its static baseline.
beforeEach((t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  t.after(() => Object.defineProperty(process, "platform", platform));
});
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
async function until(predicate, message) { for (let n = 0; n < 200; n++) { if (predicate()) return; await tick(); } assert.fail(message); }
const cardsKey = key => `agentHub.projectAccesses:${key}`;
const envKey = key => `agentHub.secretEnv:${key}`;
const passwordKey = key => `agentHub.serverPassword:${key}`;

async function setup({ steer = true } = {}) {
  const folder = join(temp, "shared-folder"); await mkdir(folder, { recursive: true });
  const projects = ["one", "two"].map(name => ({ id: `project-${name}`, name, path: folder }));
  const slots = [0, 1, 2].map(n => ({ chatId: `chat-live-test-${n}`, projectPath: projects[n === 1 ? 1 : 0].id, recordId: `record-${n}`, agent: "codex" }));
  const records = slots.map((slot, n) => ({ id: slot.recordId, createdAt: n + 1, agentIds: { claude: null, codex: null }, chatLog: [] }));
  const values = { projects, autoCommit: false, autoPull: false, "codex.model": "test-model" };
  const global = new Map(), workspace = new Map([["agentHub.multiChats", slots]]), secrets = new Map();
  const h = { projects, slots, records, values, secrets, messages: [], infos: [], errors: [], reads: [], writes: [], inputs: [], picks: [], calls: [], notifications: [], active: [] };
  h.configuration = section => ({ get: (key, fallback) => values[section === "agentHub" ? key : `${section?.replace(/^agentHub\./, "")}.${key}`] ?? fallback, update: async (key, value) => { values[key] = value; } });
  h.pick = (items, options) => { const selection = h.picks.shift(); return typeof selection === "function" ? selection(items, options) : selection; };
  h.quickPick = () => {
    let accept, hide, remove;
    const qp = { items: [], selectedItems: [], onDidAccept(fn) { accept = fn; }, onDidHide(fn) { hide = fn; }, onDidTriggerItemButton(fn) { remove = fn; }, hide() {}, dispose() {}, show() {
      queueMicrotask(() => { const selection = h.picks.shift(); if (!selection) hide(); else if (selection.remove) remove({ item: qp.items.find(item => item.name === selection.remove) }); else { qp.selectedItems = [selection.add ? qp.items.at(-1) : qp.items.find(item => item.name === selection.edit)]; accept(); } });
    } }; return qp;
  };
  current = h;
  const state = data => ({ keys: () => [...data.keys()], get: (key, fallback) => data.has(key) ? data.get(key) : fallback, update: async (key, value) => data.set(key, value) });
  const p = Object.create(ChatViewProvider.prototype);
  p.context = { globalState: state(global), workspaceState: state(workspace), secrets: {
    get: async key => { h.reads.push(key); const result = secrets.get(key); await h.beforeGet?.(key); return result; },
    store: async (key, value) => { await h.beforeStore?.(key, value); secrets.set(key, value); h.writes.push(key); },
    delete: async key => { secrets.delete(key); h.writes.push(key); },
  } };
  p.runs = new Map(); p.pendingPermissions = new Map(); p.deferred = new Map(); p.steers = new Map(); p.steerTexts = new Map(); p.sessionWriters = new Map();
  p.post = message => h.messages.push(message); p.multiPanel = { webview: { postMessage: message => h.messages.push(message) } };
  p.postSettings = async () => {}; p.postFullState = () => {}; p.rememberVisibleChoice = async () => {};
  p.getProjectStore = key => ({ sessions: records.filter((_record, n) => slots[n].projectPath === key) });
  p.ensureActiveRecord = async key => records[projects.findIndex(project => project.id === key)];
  p.mutateRecord = async (_key, id, mutate) => { const record = records.find(record => record.id === id); if (record) mutate(record); };
  p.relocateAttachments = async (_cwd, attachments) => attachments; p.autoPull = async () => {};
  p.buildAgentConfig = () => ({ contextWindow: 0 }); p.resolveClaudeCli = () => undefined; p.claudeModelsStale = () => false;
  p.backends = { codex: { async *start(prompt, options) {
    const done = gate(), call = { prompt, options, done }; h.calls.push(call);
    if (steer) options.steer.handler = async (text, mode) => { await h.beforeNotify?.(); h.notifications.push({ text, mode, call }); };
    options.signal.addEventListener("abort", () => done.resolve(), { once: true });
    yield { kind: "session", sessionId: `session-${h.calls.length}` };
    await done.promise; yield { kind: "result", ok: false };
  } } };
  h.p = p;
  h.send = msg => p.onMessage(msg, "vscode", { send: message => h.messages.push(message) }, "multi-panel");
  h.card = (patch = {}) => ({ type: "saveProjectAccess", projectPath: projects[0].id, chatId: slots[0].chatId, requestId: "save-card", expectedRevision: 0, access: { name: "Reporting", purpose: "Read reports", values: { password: "card-secret", url: "private-url" } }, ...patch });
  h.start = async (n = 0) => { const count = h.calls.length; const run = p.runTurn("Check access", "codex", [], slots[n].projectPath, false, undefined, slots[n].chatId); h.active.push(run); await until(() => h.calls.length > count, "backend did not start"); return h.calls.at(-1); };
  h.saveEnv = async (text, index = 0) => { h.picks.push(items => items.filter(item => item.path === projects[index].id)); await p.sendSecretEnvFromMessage(text, projects[index].id, slots[index].chatId); };
  h.finish = async () => { for (const call of h.calls) call.done.resolve(); await Promise.all(h.active); };
  return h;
}

test("running host receives legacy additions, rotations and deletion without secret-bearing prompts or chat entries", async () => {
  const h = await setup(), call = await h.start();
  assert.ok(call.options.liveAccess, "a running backend needs a live access channel");
  await h.saveEnv("API_TOKEN=first-secret\nSSHPASS=legacy-password");
  assert.equal(call.options.liveAccess.current.API_TOKEN, "first-secret"); assert.equal(call.options.liveAccess.current.SSHPASS, "legacy-password");
  h.picks.push({ edit: "API_TOKEN" }, undefined); h.inputs.push("rotated-secret"); await h.p.manageSecretEnv(h.slots[0].chatId);
  assert.equal(call.options.liveAccess.current.API_TOKEN, "rotated-secret");
  h.picks.push({ remove: "API_TOKEN" }, undefined); await h.p.manageSecretEnv(h.slots[0].chatId);
  assert.equal(Object.hasOwn(call.options.liveAccess.current, "API_TOKEN"), false);
  await new Promise(r => setTimeout(r, 40));
  assert.ok(h.notifications.length > 0); assert.ok(h.notifications.every(notification => notification.mode === "next"));
  const publicText = JSON.stringify({ prompt: call.prompt, messages: h.messages, notifications: h.notifications.map(({ text, mode }) => ({ text, mode })), records: h.records });
  for (const value of ["first-secret", "rotated-secret", "legacy-password"]) assert.equal(publicText.includes(value), false);
  assert.equal(h.messages.some(message => message.type === "userMessage"), false); assert.deepEqual(h.records[0].chatLog, []);
  assert.match(call.prompt, /AGENT_HUB_LIVE_CONTEXT/);
  await h.finish();
});

test("named-card fields update and clear the complete running snapshot and metadata", async () => {
  const h = await setup(), call = await h.start();
  await h.send(h.card());
  const response = h.messages.filter(message => message.type === "projectAccesses").at(-1), entry = response.entries[0];
  assert.equal(call.options.liveAccess?.current[entry.envNames.password], "card-secret");
  assert.match(call.options.liveAccess.publicContext, /Reporting/); assert.match(call.options.liveAccess.publicContext, /Read reports/);
  await h.send(h.card({ expectedRevision: 1, access: { id: entry.id, name: "Reports", purpose: "", values: { password: "rotated-card" }, clearFields: ["url"] } }));
  assert.equal(call.options.liveAccess.current[entry.envNames.password], "rotated-card"); assert.equal(Object.hasOwn(call.options.liveAccess.current, entry.envNames.url), false);
  await h.send({ ...h.card(), type: "deleteProjectAccess", id: entry.id, expectedRevision: 2 });
  assert.equal(Object.hasOwn(call.options.liveAccess.current, entry.envNames.password), false); assert.equal(call.options.liveAccess.publicContext.includes("Reporting"), false);
  assert.equal(JSON.stringify(h.messages).includes("card-secret"), false); assert.equal(JSON.stringify(h.messages).includes("private-url"), false);
  await h.finish();
});

test("logical profiles sharing one folder isolate updates while all chats in one profile refresh", async () => {
  const h = await setup(), first = await h.start(0), sibling = await h.start(1), sameProfile = await h.start(2);
  await h.saveEnv("PROJECT_TOKEN=profile-one");
  assert.equal(first.options.liveAccess?.current.PROJECT_TOKEN, "profile-one"); assert.equal(sameProfile.options.liveAccess?.current.PROJECT_TOKEN, "profile-one");
  assert.equal(sibling.options.liveAccess?.current.PROJECT_TOKEN, undefined);
  await h.saveEnv("PROJECT_TOKEN=profile-two", 1);
  assert.equal(sibling.options.liveAccess.current.PROJECT_TOKEN, "profile-two"); assert.equal(first.options.liveAccess.current.PROJECT_TOKEN, "profile-one");
  await h.finish();
});

test("a save during startup cannot be lost behind an older asynchronous credential read", async () => {
  const h = await setup(), entered = gate(), release = gate(); let once = false;
  h.secrets.set(envKey(h.projects[0].id), JSON.stringify({ TOKEN: "old-token" }));
  h.beforeGet = async key => { if (!once && key === envKey(h.projects[0].id)) { once = true; entered.resolve(); await release.promise; } };
  const run = h.p.runTurn("Check", "codex", [], h.projects[0].id, false, undefined, h.slots[0].chatId); h.active.push(run); await entered.promise;
  const save = h.saveEnv("TOKEN=new-token"); await tick(); release.resolve(); await save;
  await until(() => h.calls.length === 1, "backend did not start after delayed snapshot");
  assert.equal(h.calls[0].options.liveAccess?.current.TOKEN, "new-token");
  await h.finish();
});

test("rapid durable writes preserve every variable and the newest rotation", async () => {
  const h = await setup(), call = await h.start(), entered = gate(), release = gate(); let once = false;
  h.beforeStore = async key => { if (!once && key === envKey(h.projects[0].id)) { once = true; entered.resolve(); await release.promise; } };
  const first = h.saveEnv("FIRST=first-value\nTOKEN=old-token"); await entered.promise;
  const second = h.saveEnv("SECOND=second-value\nTOKEN=new-token"); await tick(); release.resolve(); await Promise.all([first, second]);
  assert.deepEqual(JSON.parse(h.secrets.get(envKey(h.projects[0].id))), { FIRST: "first-value", TOKEN: "new-token", SECOND: "second-value" });
  assert.equal(call.options.liveAccess?.current.FIRST, "first-value"); assert.equal(call.options.liveAccess?.current.SECOND, "second-value"); assert.equal(call.options.liveAccess?.current.TOKEN, "new-token");
  await h.finish();
});

test("primary password changes and explicit removal replace all password aliases", async () => {
  const h = await setup(), call = await h.start(); await h.saveEnv("SSHPASS=legacy-password");
  for (const password of ["primary-password", ""]) {
    h.picks.push(items => items[0]); h.inputs.push(password); await h.p.setServerPassword();
    for (const alias of ["SSHPASS", "LFTP_PASSWORD", "AGENT_HUB_SERVER_PASSWORD"]) assert.equal(call.options.liveAccess?.current[alias], password);
  }
  assert.equal(JSON.stringify(h.messages).includes("primary-password"), false);
  await h.finish();
});

test("storage and delivery failures are distinguished, redacted, and do not poison later updates", async () => {
  const h = await setup(), call = await h.start();
  h.beforeStore = async () => { throw new Error("private-store-error"); };
  await h.send(h.card());
  assert.equal(h.secrets.has(cardsKey(h.projects[0].id)), false); assert.equal(call.options.liveAccess?.current && Object.keys(call.options.liveAccess.current).some(name => name.startsWith("AGENT_HUB_ACCESS_")), false);
  h.beforeStore = undefined;
  const unsubscribe = call.options.liveAccess.subscribe(() => { throw new Error("private-delivery-error"); });
  await h.send(h.card());
  const response = h.messages.filter(message => message.type === "projectAccesses").at(-1);
  assert.equal(response.revision, 1); assert.match(response.error, /сохранены/i); assert.equal(JSON.parse(h.secrets.get(cardsKey(h.projects[0].id))).revision, 1);
  unsubscribe(); await h.saveEnv("RECOVERED=good-value"); assert.equal(call.options.liveAccess.current.RECOVERED, "good-value");
  assert.equal(/private-store-error|private-delivery-error/.test(JSON.stringify(h.messages)), false);
  await h.finish();
});

test("abort and completion release exact channel instances and transports without steer never create turns", async () => {
  const h = await setup({ steer: false }), old = await h.start();
  h.p.runs.get(h.slots[0].chatId).abort(); await h.active[0];
  const revision = old.options.liveAccess?.revision, replacement = await h.start(); await h.saveEnv("AFTER_ABORT=fresh-value");
  assert.equal(replacement.options.liveAccess?.current.AFTER_ABORT, "fresh-value"); assert.equal(old.options.liveAccess?.revision, revision);
  assert.equal(h.calls.length, 2); assert.equal(h.notifications.length, 0); assert.equal(h.p.deferred.size, 0);
  await h.finish(); const finishedRevision = replacement.options.liveAccess.revision;
  await h.saveEnv("AFTER_END=last-value"); assert.equal(replacement.options.liveAccess.revision, finishedRevision);
});

test("aborting during startup never launches a backend after the secret read completes", async () => {
  const h = await setup(), entered = gate(), release = gate(); let once = false;
  h.beforeGet = async key => { if (!once && key === envKey(h.projects[0].id)) { once = true; entered.resolve(); await release.promise; } };
  const run = h.p.runTurn("Check", "codex", [], h.projects[0].id, false, undefined, h.slots[0].chatId); h.active.push(run); await entered.promise;
  h.p.runs.get(h.slots[0].chatId).abort(); release.resolve();
  await until(() => h.calls.length > 0 || !h.p.runs.has(h.slots[0].chatId), "startup abort did not settle");
  assert.equal(h.calls.length, 0); await run;
});

test("startup read failures emit a redacted error and release the run for retry", async () => {
  const h = await setup();
  h.beforeGet = async () => { throw new Error("private-startup-error"); };
  await assert.doesNotReject(() => h.p.runTurn("Check", "codex", [], h.projects[0].id, false, undefined, h.slots[0].chatId));
  assert.ok(h.messages.some(message => message.type === "error")); assert.equal(JSON.stringify(h.messages).includes("private-startup-error"), false);
  h.beforeGet = undefined; await h.start(); await h.finish();
});

test("a backend that has ended stops receiving credentials while its final log is saving", async () => {
  const h = await setup(), call = await h.start(), entered = gate(), release = gate();
  await tick();
  const mutate = h.p.mutateRecord.bind(h.p);
  h.p.mutateRecord = async (...args) => { await mutate(...args); entered.resolve(); await release.promise; };
  call.done.resolve(); await entered.promise;
  try {
    const revision = call.options.liveAccess.revision;
    await h.saveEnv("AFTER_BACKEND_END=final-secret"); assert.equal(call.options.liveAccess.revision, revision);
  } finally { release.resolve(); }
  await h.finish();
});

test("reserved legacy names reject an entire bulk import before storage and leave active and future runs usable", async () => {
  for (const name of ["BASH_ENV", "ZDOTDIR", "AGENT_HUB_LIVE_CONTEXT", "bash_env", "zdotdir", "agent_hub_live_custom", "UID", "SHELLOPTS", "status", "GID"]) {
    const h = await setup(), call = await h.start(), revision = call.options.liveAccess.revision;
    const stored = JSON.stringify({ KEEP: "existing-secret" }); h.secrets.set(envKey(h.projects[0].id), stored);
    h.picks.push(items => [items[0]]);
    await h.p.sendSecretEnvFromMessage(`SAFE_TOKEN=harmless-secret\n${name}=reserved-secret`, h.projects[0].id, h.slots[0].chatId);
    assert.equal(h.secrets.get(envKey(h.projects[0].id)), stored, `${name} must not persist or partially import`);
    assert.deepEqual(h.writes, []); assert.equal(call.options.liveAccess.revision, revision);
    const errors = h.messages.filter(message => message.type === "error");
    assert.equal(errors.length, 1); assert.match(errors[0].message, /BASH_ENV.*ZDOTDIR.*AGENT_HUB_LIVE_\*/);
    assert.equal(h.messages.some(message => message.type === "draftHandled"), false);
    assert.equal(/existing-secret|harmless-secret|reserved-secret/.test(JSON.stringify(h.messages)), false);
    await h.finish(); await h.start(); await h.finish();
  }
});

test("native legacy additions reject reserved names before persistence while existing reserved names remain removable", async () => {
  for (const name of ["BASH_ENV", "ZDOTDIR", "AGENT_HUB_LIVE_CONTEXT", "bash_env", "agent_hub_live_custom", "UID", "SHELLOPTS", "status", "GID"]) {
    const h = await setup();
    h.picks.push({ add: true }, undefined); h.inputs.push(name, "reserved-secret");
    await h.p.manageSecretEnv(h.slots[0].chatId);
    assert.deepEqual(h.writes, [], `${name} must not persist from the native picker`);
    assert.equal(h.errors.length, 1); assert.match(h.errors[0], /BASH_ENV.*ZDOTDIR.*AGENT_HUB_LIVE_\*/);
    assert.equal(JSON.stringify(h.errors).includes("reserved-secret"), false);
    h.secrets.set(envKey(h.projects[0].id), JSON.stringify({ [name]: "old-reserved-secret", KEEP: "ordinary-secret" }));
    h.picks.push({ remove: name }, undefined); await h.p.manageSecretEnv(h.slots[0].chatId);
    assert.deepEqual(JSON.parse(h.secrets.get(envKey(h.projects[0].id))), { KEEP: "ordinary-secret" });
    await h.start(); await h.finish();
  }
});

test("legacy values rejected by the live channel never persist through either input path", async () => {
  const h = await setup(), stored = JSON.stringify({ KEEP: "existing-secret" }); h.secrets.set(envKey(h.projects[0].id), stored);
  h.picks.push(items => [items[0]]);
  await h.p.sendSecretEnvFromMessage("TOKEN=private\0secret", h.projects[0].id, h.slots[0].chatId);
  assert.equal(h.secrets.get(envKey(h.projects[0].id)), stored); assert.deepEqual(h.writes, []);
  h.picks.length = 0; h.picks.push({ add: true }, undefined); h.inputs.push("TOKEN", "private\0secret");
  await h.p.manageSecretEnv(h.slots[0].chatId);
  assert.equal(h.secrets.get(envKey(h.projects[0].id)), stored); assert.deepEqual(h.writes, []);
  assert.equal(/private|existing-secret/.test(JSON.stringify([...h.messages, ...h.errors])), false);
});

test("Windows Codex keeps its startup snapshot and notice without live manifests or update steering", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  let h;
  try {
    h = await setup(); h.secrets.set(envKey(h.projects[0].id), JSON.stringify({ TOKEN: "startup-secret" }));
    const start = h.p.backends.codex.start;
    h.p.backends.codex.start = async function* (prompt, options) {
      if (options.liveAccess) yield { kind: "notice", text: "Windows: fixture startup snapshot notice" };
      yield* start(prompt, options);
    };
    const call = await h.start(), revision = call.options.liveAccess.revision;
    assert.equal(call.prompt.includes("AGENT_HUB_LIVE_CONTEXT"), false);
    assert.equal(h.messages.filter(message => message.type === "info" && message.text === "Windows: fixture startup snapshot notice").length, 1);
    await h.saveEnv("TOKEN=next-run-secret");
    assert.equal(JSON.parse(h.secrets.get(envKey(h.projects[0].id))).TOKEN, "next-run-secret");
    assert.equal(call.options.liveAccess.revision, revision); assert.equal(call.options.liveAccess.current.TOKEN, "startup-secret");
    assert.equal(call.options.extraEnv.TOKEN, "startup-secret");
    await new Promise(r => setTimeout(r, 40)); assert.equal(h.notifications.length, 0);
    await h.finish(); const next = await h.start(); assert.equal(next.options.extraEnv.TOKEN, "next-run-secret");
  } finally { await h?.finish(); Object.defineProperty(process, "platform", platform); }
});
