import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { promises as fsPromises } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-message-edit-host-"));
const stubKey = Symbol.for("agent-hub-message-edit-host-tests");
let current;
globalThis[stubKey] = { get current() { return current; } };
after(async () => { delete globalThis[stubKey]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "provider.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/ChatViewProvider.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "isolated-task-host", setup(b) {
    b.onResolve({ filter: /^(vscode|qrcode|node:child_process)$|^\.\/agents\/|^\.\/remoteServer$|^\.\/journal$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      const h = 'globalThis[Symbol.for("agent-hub-message-edit-host-tests")].current';
      if (path === "vscode") return { contents: `export const workspace={workspaceFolders:[],getConfiguration:(section)=>${h}.configuration(section)};export const window={showInformationMessage:async()=>{},showOpenDialog:async()=>${h}.pickOpenDialog?.(),showErrorMessage:(message)=>${h}.errors.push(message)};export const Uri={},commands={executeCommand:async()=>{}},ViewColumn={},ConfigurationTarget={Global:1},ProgressLocation={},env={};export class ThemeIcon{};` };
      if (path === "node:child_process") return { contents: 'export const spawn=()=>{throw new Error("unexpected external process")};' };
      if (path === "./journal") return { contents: 'export const readJournalContext=async()=>"";export const buildFinishPrompt=()=>"";' };
      if (path === "./remoteServer") return { contents: 'export class RemoteServer{};export const enableTailscaleFunnel=()=>{};export const generateToken=()=>"";export const lanAddresses=()=>[];export const tailscaleInfo=()=>{};' };
      if (path === "qrcode") return { contents: 'export const toString=()=>"";export default {};' };
      return { contents: 'export class ClaudeBackend{};export class CodexBackend{};export class CodexAppServerBackend{};export class CodexWriterRecoveryBackend{};export const codexDefaultModel=()=>"test-model";export const killAllCodex=()=>{};' };
    });
  } }],
});
const { ChatViewProvider } = await import(pathToFileURL(outfile).href);
const STORE = "agentHub.sessionStore", CHATS = "agentHub.multiChats";
const fields = (overrides = {}) => ({ outcome: "Сохранить задачу 📌", scope: "Один чат", doneWhen: "После перезапуска", requiredChecks: "node --test", candidate: "", completed: "", blockers: "", nextStep: "Проверить", evidence: "", ...overrides });
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const jsonClone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function setup({ global = new Map(), workspace = new Map() } = {}) {
  const projects = ["one", "two"].map(name => ({ id: `project-${name}`, path: join(temp, "shared-folder"), name }));
  const records = [1, 2].map(n => ({ id: `record-${n}`, title: "Новая сессия", createdAt: n, updatedAt: n, agentIds: { claude: null, codex: null }, items: [] }));
  if (!global.has(STORE)) global.set(STORE, { [projects[0].id]: { activeId: records[0].id, sessions: records }, [projects[1].id]: { activeId: "other-record", sessions: [{ ...structuredClone(records[0]), id: "other-record" }] } });
  const slots = records.map((rec, i) => ({ chatId: `chat-task-slot-${i}`, projectPath: projects[0].id, recordId: rec.id, agent: "claude" }));
  if (!workspace.has(CHATS)) workspace.set(CHATS, slots);
  const values = { projects, autoCommit: false, autoPull: false, "codex.model": "test-model" };
  const durableGlobal = new Map([...global].map(([key, value]) => [key, jsonClone(value)]));
  const h = { global, durableGlobal, workspace, projects, slots, values, messages: [], errors: [], writes: [], attempts: [], beforeUpdate: undefined };
  h.configuration = section => ({ get: (name, fallback) => values[section === "agentHub" ? name : `${section?.replace(/^agentHub\./, "")}.${name}`] ?? fallback, update: async () => {} });
  current = h;
  // VS Code JSON-clones into its live cache synchronously, then awaits persistence.
  // A rejected update therefore leaves a different cached object unless the caller restores it.
  const memento = data => ({ keys: () => [...data.keys()], get: (key, fallback) => data.has(key) ? data.get(key) : fallback,
    update: async (key, value) => { const cached = jsonClone(value); data.set(key, cached); h.attempts.push({ key, value: jsonClone(cached) });
      await h.beforeUpdate?.(key, cached); h.writes.push(key); if (data === global) durableGlobal.set(key, jsonClone(cached)); } });
  const p = Object.create(ChatViewProvider.prototype);
  p.context = { globalState: memento(global), workspaceState: memento(workspace), secrets: { get: async () => undefined } };
  p.runs = new Map(); p.pendingPermissions = new Map(); p.deferred = new Map(); p.steers = new Map(); p.steerTexts = new Map(); p.sessionWriters = new Map();
  p.post = message => h.messages.push(message);
  p.multiPanel = { webview: { postMessage: message => h.messages.push(message) } };
  p.postSafety = () => {}; p.postSlashCommands = () => {}; p.postSettings = async () => {};
  p.listClaudeModels = () => []; p.listCodexModels = () => []; p.codexEffortLevels = () => null;
  h.p = p;
  h.send = (message, surface = "multi-panel") => p.onMessage(message, "vscode", undefined, surface);
  h.record = (id = "record-1", key = projects[0].id) => p.getProjectStore(key).sessions.find(entry => entry.id === id);
  h.request = (overrides = {}) => ({ type: "saveTaskState", chatId: slots[0].chatId, requestId: "task-save-1", identity: { projectKey: projects[0].id, recordId: "record-1", createdAt: 1 }, revision: h.record()?.task?.revision ?? 0, fields: fields(), ...overrides });
  h.taskMessages = () => h.messages.filter(m => m.type === "taskState");
  return h;
}

async function editSetup() {
  const h = setup(); const key = h.projects[0].id;
  await mkdir(h.projects[0].path, { recursive: true });
  const file = join(h.projects[0].path, "kept.txt"); await writeFile(file, "project unchanged");
  const message = (messageId, text, logCut, turnId) => ({ messageId, agent: "codex", kind: "prompt", text, attachmentFiles: [], logCut, anchor: { provider: "codex", sessionId: "native-source", turnId } });
  const first = message("first-message", "Earlier prompt", 0, "turn-first"), selected = message("selected-message", "Original selected", 2, "turn-selected");
  Object.assign(h.record(), { title: "Original history", preferredAgent: "codex", agentIds: { codex: "native-source", claude: "future-claude" },
    items: [{ id: 1, role: "user", text: first.text, sentMessage: first }, { id: 2, role: "assistant", text: "Earlier reply" }, { id: 3, role: "user", text: selected.text, sentMessage: selected }, { id: 4, role: "assistant", text: "Discarded future" }],
    sentMessages: { [first.messageId]: first, [selected.messageId]: selected },
    chatLog: [{ agent: "codex", role: "user", text: first.text }, { agent: "codex", role: "assistant", text: "Earlier reply" }, { agent: "codex", role: "user", text: selected.text }, { agent: "claude", role: "assistant", text: "Discarded future" }],
    chatSeen: { codex: 4, claude: 4 }, context: { codex: { used: 99, max: 100 }, claude: { used: 80, max: 100 } }, models: { codex: "future-model", claude: "future-model" },
    modelOverrides: { codex: "chosen-model", claude: "future-model" }, effortOverrides: { codex: "high", claude: "max" }, lastPrompts: { codex: "future secret", claude: "future secret" } });
  h.p.relocateAttachments = async (_cwd, attachments) => attachments; h.p.autoPull = async () => {}; h.p.buildProjectCard = async () => "";
  h.calls = []; h.prepares = [];
  h.p.backends = { codex: { prepareEdit: async opts => { h.prepares.push(opts); return { resumeSessionId: "native-prefix", remappedAnchors: { "turn-first": { provider: "codex", sessionId: "native-prefix", turnId: "fork-first" } } }; },
    async *start(prompt, opts) { h.calls.push({ prompt, opts }); yield { kind: "nativePrompt", messageId: opts.messageId, anchor: { provider: "codex", sessionId: "native-prefix", turnId: "replacement-turn" } }; yield { kind: "assistantText", text: "Replacement reply" }; } },
    claude: { async *start(prompt, opts) { h.calls.push({ prompt, opts }); yield { kind: "assistantText", text: "Other reply" }; } } };
  h.edit = (overrides = {}) => ({ type: "editMessage", requestId: "edit-submit-1", chatId: h.slots[0].chatId, path: key, recordId: "record-1", messageId: selected.messageId, text: "Replacement 📌", attachments: [], ...overrides });
  h.prepare = (overrides = {}) => ({ ...h.edit(overrides), type: "prepareMessageEdit", requestId: "edit-prepare-1" });
  h.acks = () => h.messages.filter(m => m.type === "editMessageResult"); h.prepared = () => h.messages.filter(m => m.type === "messageEditPrepared");
  h.file = file; return h;
}

test("prepare uses host-owned text and attachments and never forks the provider", async () => {
  const h = await editSetup(); await h.send(h.prepare({ text: "Untrusted", anchor: { turnId: "fake" }, cut: 0 }));
  assert.equal(h.prepared().at(-1)?.text, "Original selected"); assert.equal(h.prepared().at(-1)?.agent, "codex"); assert.deepEqual(h.prepares, []);
});

test("native prepare failure preserves original history and does not run a replacement", async () => {
  const h = await editSetup(); const before = structuredClone(h.record());
  h.p.backends.codex.prepareEdit = async () => { throw new Error("native prefix unavailable"); };
  await h.send(h.edit()); assert.equal(h.acks().at(-1)?.ok, false); assert.match(h.acks().at(-1)?.error ?? "", /native prefix unavailable/);
  assert.deepEqual(h.record(), before); assert.equal(h.p.findChatSlot(h.slots[0].chatId).recordId, "record-1"); assert.deepEqual(h.calls, []);
});

test("successful edit retains source history and commits provider prefix before replacement", async () => {
  const h = await editSetup(); const source = structuredClone(h.record()); await h.send(h.edit());
  const ack = h.acks().at(-1); assert.equal(ack?.ok, true); assert.notEqual(ack.recordId, "record-1"); assert.deepEqual(h.record(), source);
  assert.equal(h.p.findChatSlot(h.slots[0].chatId).recordId, ack.recordId);
  const branch = h.record(ack.recordId); assert.equal(branch.items.some(item => item.text === "Original selected" || item.text === "Discarded future"), false);
  assert.deepEqual(branch.chatLog.slice(0, 2), source.chatLog.slice(0, 2)); assert.equal(branch.agentIds.codex, "native-prefix"); assert.equal(branch.agentIds.claude, null);
  assert.deepEqual(branch.context ?? {}, {}); assert.equal(branch.models?.claude, undefined); assert.equal(branch.modelOverrides.claude, undefined); assert.equal(branch.effortOverrides.claude, undefined);
  assert.equal(branch.sentMessages["selected-message"], undefined); assert.equal(branch.sentMessages["first-message"].anchor.turnId, "fork-first");
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].opts.resumeSessionId, "native-prefix"); assert.equal(h.calls[0].opts.config.model, "chosen-model"); assert.equal(h.calls[0].opts.config.effort, "high");
  assert.ok(h.calls[0].opts.messageId && h.calls[0].opts.messageId !== "selected-message"); assert.equal(h.calls[0].prompt.includes("Discarded future"), false);
  assert.equal(await readFile(h.file, "utf8"), "project unchanged");
  const hydration = h.messages.findIndex(m => m.type === "transcript" && m.recordId === ack.recordId); const acknowledged = h.messages.findIndex(m => m === ack); assert.ok(hydration >= 0 && hydration < acknowledged);
});

test("new session during native preparation proceeds independently and invalidates edit", async () => {
  const h = await editSetup(), entered = gate(), release = gate();
  h.p.backends.codex.prepareEdit = async () => { entered.resolve(); await release.promise; return { resumeSessionId: "stale-prefix" }; };
  const editing = h.send(h.edit()); await entered.promise;
  await h.send({ type: "newSession", chatId: h.slots[0].chatId }); const fresh = h.p.findChatSlot(h.slots[0].chatId).recordId;
  assert.notEqual(fresh, "record-1"); release.resolve(); await editing;
  assert.equal(h.acks().at(-1)?.ok, false); assert.equal(h.p.findChatSlot(h.slots[0].chatId).recordId, fresh); assert.deepEqual(h.calls, []);
});

test("duplicate and competing edit requests reserve the source writer while unrelated chats work", async () => {
  const h = await editSetup(), entered = gate(), release = gate(); let count = 0;
  h.p.backends.codex.prepareEdit = async () => { count++; entered.resolve(); await release.promise; return { resumeSessionId: "prefix" }; };
  const editing = h.send(h.edit()); await entered.promise;
  await h.send(h.edit()); await h.send(h.edit({ requestId: "other-edit" }));
  await h.p.runTurn("Unrelated chat", "claude", [], h.projects[0].id, true, undefined, h.slots[1].chatId);
  assert.equal(count, 1); assert.equal(h.calls.length, 1); release.resolve(); await editing;
  assert.equal(h.acks().filter(m => m.ok).length, 1);
});

test("stale ordinary and board transcript saves cannot restore edited-away future", async () => {
  const h = await editSetup(); await h.send(h.edit({ chatId: undefined }), "view"); const ack = h.acks().at(-1); assert.equal(ack?.ok, true);
  const before = structuredClone(h.record(ack.recordId));
  await h.send({ type: "saveTranscript", path: h.projects[0].id, recordId: "record-1", items: [{ role: "user", text: "Stale future" }] }, "view");
  await h.send({ type: "saveTranscript", path: h.projects[0].id, items: [{ role: "user", text: "Unscoped future" }] }, "panel");
  assert.deepEqual(h.record(ack.recordId), before);
});

test("missing legacy files are reported and absent canonical files reject submission", async () => {
  const h = await editSetup(); h.record().sentMessages["selected-message"].attachmentFiles = [{ name: "missing.png", path: join(temp, "missing.png") }];
  await h.send(h.prepare()); assert.deepEqual(h.prepared().at(-1)?.missingAttachments, ["missing.png"]);
  await h.send(h.edit({ attachments: [{ name: "missing.png", path: join(temp, "missing.png") }] })); assert.equal(h.acks().at(-1)?.ok, false); assert.deepEqual(h.prepares, []);
});

test("edit preparation excludes missing paths while retaining an available attachment with the same name", async () => {
  const h = await editSetup();
  const available = { name: "shared.png", path: h.file };
  const missing = { name: "shared.png", path: join(temp, "gone", "shared.png") };
  h.record().sentMessages["selected-message"].attachmentFiles = [missing, available];
  await h.send(h.prepare());
  const prepared = h.prepared().at(-1);
  assert.deepEqual(prepared.attachments, [available]);
  assert.deepEqual(prepared.missingAttachments, [missing.name]);
  // Removing the missing chip and selecting its replacement must submit only real paths.
  const replacement = { name: "replacement.txt", path: h.file };
  await h.send(h.edit({ attachments: [...prepared.attachments, replacement] }));
  assert.equal(h.acks().at(-1)?.ok, true);
  assert.deepEqual(h.calls[0].opts.attachments.map(file => file.path), [available.path, replacement.path]);
});

test("fresh other-provider session receives all retained prefix including its own earlier turns", async () => {
  const h = await editSetup(); h.record().chatLog[0].agent = "claude"; h.record().chatLog[1].agent = "claude";
  await h.send(h.edit()); const id = h.acks().at(-1).recordId; h.calls.length = 0;
  await h.p.runTurn("Continue", "claude", [], h.projects[0].id, true, undefined, h.slots[0].chatId);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].prompt.includes("Earlier prompt"), true); assert.equal(h.calls[0].prompt.includes("Earlier reply"), true); assert.equal(h.calls[0].prompt.includes("Discarded future"), false);
});

for (const savedSnapshot of [true, false]) {
  test(`editing a turn reinjects retained other-provider context from ${savedSnapshot ? "its saved pre-turn boundary" : "legacy history without a boundary"}`, async () => {
    const h = await editSetup();
    const selected = h.record().sentMessages["selected-message"];
    selected.logCut = 4;
    if (savedSnapshot) selected.seenBefore = 2;
    h.record().items.splice(2, 0, { id: "claude-user", role: "user", text: "B1" }, { id: "claude-reply", role: "assistant", text: "Claude retained decision" });
    h.record().chatLog.splice(2, 0, { agent: "claude", role: "user", text: "B1" }, { agent: "claude", role: "assistant", text: "Claude retained decision" });
    h.record().chatSeen = { codex: 6, claude: 4 };
    await h.send(h.edit());
    assert.equal(h.acks().at(-1)?.ok, true);
    assert.equal(h.calls[0].opts.resumeSessionId, "native-prefix");
    assert.match(h.calls[0].prompt, /Claude retained decision/);
    assert.equal(h.calls[0].prompt.includes("Original selected"), false);
    assert.equal(h.calls[0].prompt.includes("Discarded future"), false);
  });
}

test("ordinary turns save the pre-turn seen boundary actually used to build input before later state changes", async () => {
  const h = await editSetup();
  Object.assign(h.record(), { items: [], sentMessages: {}, chatLog: [], chatSeen: {}, agentIds: { codex: "native-source", claude: "native-claude" } });
  for (const agent of ["codex", "claude"]) h.p.backends[agent].start = async function* (prompt, opts) {
    h.calls.push({ prompt, opts, agent });
    const anchor = agent === "codex" ? { provider: agent, sessionId: opts.resumeSessionId, turnId: `turn-${opts.messageId}` }
      : { provider: agent, sessionId: opts.resumeSessionId, userMessageUuid: opts.messageId, transcriptPath: h.file };
    yield { kind: "nativePrompt", messageId: opts.messageId, anchor };
    yield { kind: "assistantText", text: agent === "claude" ? "Claude retained decision" : "Codex reply" };
  };
  await h.p.runTurn("A1", "codex", [], h.projects[0].id, true, undefined, h.slots[0].chatId);
  await h.p.runTurn("B1", "claude", [], h.projects[0].id, true, undefined, h.slots[0].chatId);
  let changedSeen = false;
  h.p.buildProjectCard = async () => {
    if (!changedSeen) {
      changedSeen = true;
      await h.p.mutateRecord(h.projects[0].id, "record-1", record => { record.chatSeen.codex = record.chatLog.length; });
    }
    return "";
  };
  await h.p.runTurn("A2", "codex", [], h.projects[0].id, true, undefined, h.slots[0].chatId);
  assert.match(h.calls[2].prompt, /Claude retained decision/);
  const selected = Object.values(h.record().sentMessages).find(message => message.text === "A2");
  assert.equal(selected.seenBefore, 2);
  assert.equal(selected.logCut, 4);
  assert.equal(h.record().chatSeen.codex, 6);
  await h.send(h.edit({ messageId: selected.messageId, text: "Edited A2" }));
  assert.equal(h.acks().at(-1)?.ok, true);
  assert.match(h.calls[3].prompt, /Claude retained decision/);
});

for (const kind of ["store", "binding"]) {
  test(`${kind} persistence failure keeps original binding and permits retry with a new request`, async () => {
    const h = await editSetup(); const before = structuredClone(h.record()); let failed = false;
    if (kind === "store") h.beforeUpdate = async key => { if (key === STORE && !failed) { failed = true; throw new Error("storage offline"); } };
    else { const update = h.p.context.workspaceState.update; h.p.context.workspaceState.update = async (key, value) => { if (key === CHATS && !failed) { failed = true; throw new Error("binding offline"); } return update(key, value); }; }
    await h.send(h.edit()); assert.equal(h.acks().at(-1)?.ok, false); assert.deepEqual(h.record(), before); assert.equal(h.p.findChatSlot(h.slots[0].chatId).recordId, "record-1"); assert.deepEqual(h.calls, []);
    h.beforeUpdate = undefined; await h.send(h.edit({ requestId: "retry-edit" })); assert.equal(h.acks().at(-1)?.ok, true);
  });
}

test("Stop aborts native preparation and a stale provider result cannot commit", async () => {
  const h = await editSetup(), entered = gate(), release = gate(); let signal;
  h.p.backends.codex.prepareEdit = async opts => { signal = opts.signal; entered.resolve(); await release.promise; return { resumeSessionId: "stale" }; };
  const editing = h.send(h.edit()); await entered.promise; await h.send({ type: "stop", path: h.projects[0].id, chatId: h.slots[0].chatId });
  assert.equal(signal.aborted, true); release.resolve(); await editing; assert.equal(h.acks().at(-1)?.ok, false); assert.equal(h.p.findChatSlot(h.slots[0].chatId).recordId, "record-1"); assert.deepEqual(h.calls, []);
});

for (const shutdown of ["abortAll", "dispose"]) {
  test(`${shutdown} aborts deferred Claude preparation without releasing its writer before cleanup`, async () => {
    const h = await editSetup(), entered = gate(), release = gate();
    const selected = h.record().sentMessages["selected-message"];
    selected.agent = "claude";
    selected.anchor = { provider: "claude", sessionId: "future-claude", userMessageUuid: "native-selected", transcriptPath: h.file };
    const source = structuredClone(h.record());
    let signal;
    h.p.backends.claude.prepareEdit = async opts => {
      signal = opts.signal; entered.resolve(); await release.promise;
      return { resumeSessionId: "late-claude-fork" };
    };
    const editing = h.send(h.edit()); await entered.promise;
    h.p[shutdown]();
    const abortedAtShutdown = signal.aborted;
    const writerHeldAtShutdown = [...h.p.sessionWriters.values()].some(controller => controller.signal === signal);
    release.resolve(); await editing;
    assert.equal(abortedAtShutdown, true);
    assert.equal(writerHeldAtShutdown, true);
    assert.equal(h.acks().some(message => message.ok), false);
    assert.equal(h.p.findChatSlot(h.slots[0].chatId).recordId, "record-1");
    assert.deepEqual(h.record(), source);
    assert.deepEqual(h.calls, []);
    assert.equal(h.p.sessionWriters.size, 0);
    assert.equal(h.p.messageEditPreparations.size, 0);
  });
}

for (const persistence of ["store", "binding", "hydration"]) {
  test(`shutdown during edit ${persistence} persistence cannot launch replacement inference`, async () => {
    const h = await editSetup(), entered = gate(), release = gate();
    const source = structuredClone(h.record());
    const hydrate = h.p.postMultiState.bind(h.p);
    h.p.postMultiState = async (...args) => {
      await hydrate(...args);
      if (persistence === "hydration" && h.p.findChatSlot(h.slots[0].chatId).recordId !== "record-1") { entered.resolve(); await release.promise; }
    };
    h.beforeUpdate = async (key, value) => {
      const committingBranch = persistence === "store"
        ? key === STORE && value[h.projects[0].id]?.sessions.length > 2
        : key === CHATS && value.some(slot => slot.chatId === h.slots[0].chatId && slot.recordId !== "record-1");
      if (committingBranch) { entered.resolve(); await release.promise; }
    };
    const editing = h.send(h.edit()); await entered.promise;
    h.p.abortAll(); release.resolve(); await editing;
    assert.deepEqual(h.calls, []);
    assert.equal(h.acks().some(message => message.ok), false);
    assert.equal(h.p.findChatSlot(h.slots[0].chatId).recordId, "record-1");
    assert.equal(h.p.getProjectStore(h.projects[0].id).activeId, "record-1");
    assert.deepEqual(h.p.getProjectStore(h.projects[0].id).sessions.map(record => record.id), ["record-1", "record-2"]);
    assert.deepEqual(h.record(), source);
    assert.equal(h.p.sessionWriters.size, 0);
    assert.equal(h.p.messageEditPreparations.size, 0);
  });
}

for (const stage of ["store", "hydration"]) {
  test(`ordinary-view cancellation during branch ${stage} restores the original active record`, async () => {
    const h = await editSetup(), entered = gate(), release = gate();
    const source = structuredClone(h.record());
    if (stage === "store") h.beforeUpdate = async (key, value) => {
      if (key === STORE && value[h.projects[0].id]?.activeId !== "record-1") { entered.resolve(); await release.promise; }
    };
    else {
      const hydrate = h.p.postFullState.bind(h.p);
      h.p.postFullState = () => { hydrate(); h.p.abortAll(); };
    }
    const editing = h.send(h.edit({ chatId: undefined }), "view");
    if (stage === "store") { await entered.promise; h.p.abortAll(); release.resolve(); }
    await editing;
    assert.deepEqual(h.calls, []);
    assert.equal(h.acks().some(message => message.ok), false);
    assert.equal(h.p.getProjectStore(h.projects[0].id).activeId, "record-1");
    assert.deepEqual(h.p.getProjectStore(h.projects[0].id).sessions.map(record => record.id), ["record-1", "record-2"]);
    assert.deepEqual(h.record(), source);
    assert.equal(h.messages.filter(message => message.type === "transcript" && !message.chatId).at(-1)?.recordId, "record-1");
  });
}

test("cancel rollback preserves a chat binding changed away from the pending edit branch", async () => {
  const h = await editSetup(), entered = gate(), release = gate();
  const source = structuredClone(h.record());
  const hydrate = h.p.postMultiState.bind(h.p); let paused = false;
  h.p.postMultiState = async (...args) => {
    await hydrate(...args);
    if (!paused) { paused = true; entered.resolve(); await release.promise; }
  };
  const editing = h.send(h.edit()); await entered.promise;
  await h.p.saveChatSlots(h.p.getChatSlots().map(slot => slot.chatId === h.slots[0].chatId ? { ...slot, recordId: "record-2" } : slot));
  h.p.abortAll(); release.resolve(); await editing;
  assert.equal(h.p.findChatSlot(h.slots[0].chatId).recordId, "record-2");
  assert.deepEqual(h.record(), source);
  assert.deepEqual(h.calls, []);
});

for (const board of [true, false]) {
  test(`${board ? "board" : "ordinary-view"} rollback failure preserves both records and reports the actual binding`, async () => {
    const h = await editSetup(); const source = structuredClone(h.record()); let branchId;
    const failRestore = async (key, value) => {
      if (board ? key === CHATS && value.some(slot => slot.chatId === h.slots[0].chatId && slot.recordId === "record-1")
        : key === STORE && value[h.projects[0].id]?.activeId === "record-1") throw new Error("rollback storage offline");
    };
    if (board) {
      const hydrate = h.p.postMultiState.bind(h.p);
      h.p.postMultiState = async (...args) => {
        await hydrate(...args);
        if (!branchId) { branchId = h.p.findChatSlot(h.slots[0].chatId).recordId; h.beforeUpdate = failRestore; h.p.abortAll(); }
      };
    } else {
      const hydrate = h.p.postFullState.bind(h.p);
      h.p.postFullState = () => {
        hydrate();
        if (!branchId) { branchId = h.p.getProjectStore(h.projects[0].id).activeId; h.beforeUpdate = failRestore; h.p.abortAll(); }
      };
    }
    await h.send(h.edit(board ? {} : { chatId: undefined }), board ? "multi-panel" : "view");
    const actual = board ? h.p.findChatSlot(h.slots[0].chatId).recordId : h.p.getProjectStore(h.projects[0].id).activeId;
    assert.equal(actual, branchId);
    assert.equal(h.record(branchId)?.id, branchId);
    assert.deepEqual(h.record(), source);
    assert.deepEqual(h.calls, []);
    assert.equal(h.acks().at(-1)?.ok, false);
    assert.equal(h.acks().at(-1)?.recordId, actual);
    assert.match(h.acks().at(-1)?.error ?? "", /rollback storage offline/);
    assert.equal(h.messages.filter(message => message.type === "transcript" && message.chatId === (board ? h.slots[0].chatId : undefined)).at(-1)?.recordId, actual);
  });
}

for (const explicitFork of [true, false]) {
  test(`ordinary Codex session ${explicitFork ? "full-history fork remaps matching" : "change preserves old"} native anchors`, async () => {
    const h = await editSetup();
    h.record().sentMessages["selected-message"].anchor.sessionId = "unrelated-native-session";
    h.p.backends.codex.start = async function* (prompt, opts) {
      h.calls.push({ prompt, opts });
      yield { kind: "session", sessionId: "recovered-native-session", ...(explicitFork ? { forkedFromSessionId: "native-source" } : {}) };
      yield { kind: "assistantText", text: "Continued reply" };
    };
    await h.p.runTurn("Continue after writer conflict", "codex", [], h.projects[0].id, true, undefined, h.slots[0].chatId);
    const record = h.record();
    assert.equal(record.agentIds.codex, "recovered-native-session");
    assert.equal(record.sentMessages["first-message"].anchor.sessionId, explicitFork ? "recovered-native-session" : "native-source");
    assert.equal(record.sentMessages["selected-message"].anchor.sessionId, "unrelated-native-session");
    if (explicitFork) {
      h.p.backends.codex.prepareEdit = async opts => {
        assert.equal(opts.anchor.sessionId, opts.sessionId);
        assert.equal(opts.anchor.turnId, "turn-first");
        return {};
      };
      await h.send(h.edit({ messageId: "first-message" }));
      assert.equal(h.acks().at(-1)?.ok, true, "earlier messages remain natively editable after full-history recovery");
    }
  });
}

test("record generation change while provider is preparing rejects without resurrecting history", async () => {
  const h = await editSetup(), entered = gate(), release = gate();
  h.p.backends.codex.prepareEdit = async () => { entered.resolve(); await release.promise; return { resumeSessionId: "stale" }; };
  const editing = h.send(h.edit()); await entered.promise; h.record().createdAt++; release.resolve(); await editing;
  assert.equal(h.acks().at(-1)?.ok, false); assert.equal(h.p.findChatSlot(h.slots[0].chatId).recordId, "record-1"); assert.deepEqual(h.calls, []);
});

test("busy records and the same source displayed in another chat cannot acquire an edit writer", async () => {
  const h = await editSetup(); h.p.runs.set(h.slots[0].chatId, new AbortController()); await h.send(h.edit());
  assert.equal(h.acks().at(-1)?.ok, false); assert.deepEqual(h.prepares, []); h.p.runs.clear();
  h.p.sessionWriters.set(`record:${h.projects[0].id}:record-1:claude`, new AbortController()); await h.send(h.edit({ requestId: "second" })); assert.equal(h.acks().at(-1)?.ok, false); assert.deepEqual(h.prepares, []);
});

test("replacement inference failure retains the committed branch for retry", async () => {
  const h = await editSetup(); h.p.backends.codex.start = async function* () { throw new Error("inference offline"); };
  await h.send(h.edit()); const ack = h.acks().at(-1); assert.equal(ack?.ok, true); assert.equal(h.p.findChatSlot(h.slots[0].chatId).recordId, ack.recordId);
  const branch = h.record(ack.recordId); assert.equal(branch.chatLog.at(-1).text, "Replacement 📌"); assert.ok(Object.values(branch.sentMessages).some(m => m.text === "Replacement 📌"));
});

test("ordinary user echoes and hydration carry record identities and keep native anchors private", async () => {
  const h = await editSetup(); await h.p.runTurn("A fresh user prompt", "codex", [], h.projects[0].id, true);
  const echo = h.messages.find(m => m.type === "userMessage"); assert.equal(echo?.recordId, "record-1"); assert.ok(echo.sentMessage?.messageId); assert.equal(echo.sentMessage.anchor, undefined);
  assert.equal(h.record().sentMessages[echo.sentMessage.messageId].anchor.turnId, "replacement-turn");
  await h.send({ type: "ready" }, "view"); const hydration = h.messages.filter(m => m.type === "transcript" && !m.chatId).at(-1); assert.equal(hydration.recordId, "record-1");
  assert.equal(hydration.items.some(item => item.sentMessage?.anchor), false);
});

test("renderer supplied anchors, cut positions and provider identity are ignored on transcript save", async () => {
  const h = await editSetup(); const items = structuredClone(h.record().items);
  items[2].sentMessage = { ...items[2].sentMessage, agent: "claude", anchor: { provider: "claude", sessionId: "evil", userMessageUuid: "evil", transcriptPath: "/tmp/evil" }, logCut: 0, text: "evil" };
  await h.send({ type: "saveTranscript", path: h.projects[0].id, chatId: h.slots[0].chatId, recordId: "record-1", items });
  await h.send(h.edit({ requestId: "trusted-anchor-only", anchor: { turnId: "evil" }, logCut: 0 }));
  assert.equal(h.prepares[0].anchor.provider, "codex"); assert.equal(h.prepares[0].anchor.turnId, "turn-selected"); assert.equal(h.record(h.acks().at(-1).recordId).chatLog[1].text, "Earlier reply");
});

test("legacy unique messages get stable identities and exact native fallback suffixes", async () => {
  const h = await editSetup(); delete h.record().sentMessages; h.record().items.forEach(item => delete item.sentMessage);
  await h.send({ type: "ready", chatId: h.slots[0].chatId }); const first = h.messages.filter(m => m.type === "transcript").at(-1).items[2].sentMessage;
  await h.send({ type: "ready", chatId: h.slots[0].chatId }); const second = h.messages.filter(m => m.type === "transcript").at(-1).items[2].sentMessage;
  assert.equal(first.messageId, second.messageId); assert.equal(first.editUnavailableReason, undefined);
  await h.send(h.edit({ messageId: first.messageId })); assert.equal(h.prepares[0].anchor, undefined); assert.equal(h.prepares[0].legacyPrompt, "Original selected");
});

test("a retained same-provider legacy prompt can be edited again in the forked branch", async () => {
  const h = await editSetup(); delete h.record().sentMessages; h.record().items.forEach(item => delete item.sentMessage);
  await h.send({ type: "ready", chatId: h.slots[0].chatId });
  const items = h.messages.filter(message => message.type === "transcript").at(-1).items;
  const first = items[0].sentMessage, second = items[2].sentMessage;
  await h.send(h.edit({ messageId: second.messageId }));
  const branchId = h.acks().at(-1)?.recordId;
  assert.equal(h.acks().at(-1)?.ok, true);
  assert.equal(h.record(branchId).sentMessages[first.messageId].anchor, undefined);
  assert.equal(h.record(branchId).sentMessages[first.messageId].editUnavailableReason, undefined);
  await h.send(h.prepare({ recordId: branchId, messageId: first.messageId, requestId: "chained-legacy-prepare" }));
  assert.equal(h.prepared().at(-1)?.error, undefined);
  await h.send(h.edit({ recordId: branchId, messageId: first.messageId, requestId: "chained-legacy-edit" }));
  assert.equal(h.acks().at(-1)?.ok, true);
  assert.equal(h.prepares[1].sessionId, "native-prefix");
  assert.equal(h.prepares[1].anchor, undefined);
  assert.equal(h.prepares[1].legacyPrompt, "Earlier prompt");
});

test("legacy external attachment labels surface missing files while preserving an exact provider suffix", async () => {
  const h = await editSetup(); delete h.record().sentMessages; h.record().items.forEach(item => delete item.sentMessage);
  h.record().items[2].attachments = ["external.png"]; h.record().chatLog[2].text = "Original selected\n\nПриложенные файлы:\n- /gone/external.png (изображение — открой и рассмотри)";
  await h.send({ type: "ready", chatId: h.slots[0].chatId }); const sent = h.messages.filter(m => m.type === "transcript").at(-1).items[2].sentMessage;
  await h.send(h.prepare({ messageId: sent.messageId })); assert.equal(h.prepared().at(-1)?.error, undefined); assert.deepEqual(h.prepared().at(-1)?.missingAttachments, ["external.png"]);
  await h.send(h.edit({ messageId: sent.messageId })); assert.equal(h.acks().at(-1)?.ok, true); assert.equal(h.prepares[0].legacyPrompt, "Приложенные файлы:\n- /gone/external.png (изображение — открой и рассмотри)\n\nOriginal selected");
});

test("duplicate legacy visible text never guesses which native prompt or log boundary to edit", async () => {
  const h = await editSetup(); delete h.record().sentMessages; h.record().items.forEach(item => delete item.sentMessage);
  h.record().items.push({ id: 5, role: "user", text: "Original selected" });
  await h.send({ type: "ready", chatId: h.slots[0].chatId }); const sent = h.messages.filter(m => m.type === "transcript").at(-1).items[4].sentMessage;
  assert.ok(sent.editUnavailableReason); await h.send(h.edit({ messageId: sent.messageId })); assert.equal(h.acks().at(-1)?.ok, false); assert.deepEqual(h.prepares, []);
});

test("attachment disappearance during native preparation cannot commit a broken replacement", async () => {
  const h = await editSetup(), entered = gate(), release = gate(); const attached = join(temp, "vanishing.txt"); await writeFile(attached, "attached");
  h.p.backends.codex.prepareEdit = async () => { entered.resolve(); await release.promise; return { resumeSessionId: "prefix" }; };
  const editing = h.send(h.edit({ attachments: [{ name: "vanishing.txt", path: attached }] })); await entered.promise; await rm(attached); release.resolve(); await editing;
  assert.equal(h.acks().at(-1)?.ok, false); assert.equal(h.p.findChatSlot(h.slots[0].chatId).recordId, "record-1"); assert.deepEqual(h.calls, []);
});

test("steering echoes identify their record and explicitly disable native prompt editing", async () => {
  const h = await editSetup(); h.p.runs.set(h.slots[0].chatId, new AbortController()); h.p.steers.set(h.slots[0].chatId, { handler: async () => {} });
  await h.send({ type: "steer", text: "Live correction", agent: "codex", mode: "next", chatId: h.slots[0].chatId, path: h.projects[0].id });
  const echo = h.messages.find(m => m.type === "userMessage"); assert.equal(echo?.recordId, "record-1"); assert.equal(echo.sentMessage?.kind, "steer"); assert.ok(echo.sentMessage.editUnavailableReason);
});

test("fresh native sessions receive every retained entry without the resumed-tail clipping limit", async () => {
  const h = await editSetup(); h.record().agentIds.claude = null;
  h.record().chatLog = Array.from({ length: 25 }, (_, i) => ({ agent: "claude", role: i % 2 ? "assistant" : "user", text: `retained-${i}:` + "x".repeat(5000) + `:end-${i}` }));
  await h.p.runTurn("Continue", "claude", [], h.projects[0].id, true, undefined, h.slots[0].chatId);
  assert.equal(h.calls[0].prompt.includes("retained-0:"), true); assert.equal(h.calls[0].prompt.includes(":end-24"), true);
});

test("contextual attachment picking echoes the exact draft identity only while its binding is current", async () => {
  const h = await editSetup(); const draftContext = { draftId: "edit-draft-1", recordId: "record-1" };
  h.pickOpenDialog = async () => [{ fsPath: h.file }];
  await h.send({ type: "pickAttachment", chatId: h.slots[0].chatId, path: h.projects[0].id, draftContext });
  const added = h.messages.filter(m => m.type === "attachmentAdded").at(-1); assert.deepEqual(added.draftContext, draftContext); assert.equal(added.chatId, h.slots[0].chatId);
  h.messages.length = 0; const entered = gate(), release = gate(); h.pickOpenDialog = async () => { entered.resolve(); await release.promise; return [{ fsPath: h.file }]; };
  const picking = h.send({ type: "pickAttachment", chatId: h.slots[0].chatId, path: h.projects[0].id, draftContext }); await entered.promise;
  await h.send({ type: "newSession", chatId: h.slots[0].chatId }); release.resolve(); await picking;
  assert.equal(h.messages.some(m => m.type === "attachmentAdded"), false);
});

test("contextual upload rejects an old record and successful upload includes exact draft context", async () => {
  const h = await editSetup(), draftContext = { draftId: "edit-upload-1", recordId: "record-1", uploadId: "upload-one" };
  await h.send({ type: "saveAttachment", chatId: h.slots[0].chatId, path: h.projects[0].id, draftContext, name: "résumé 📌.txt", dataBase64: Buffer.from("draft file").toString("base64") });
  const added = h.messages.filter(m => m.type === "attachmentAdded").at(-1); assert.deepEqual(added.draftContext, draftContext); assert.equal(added.files[0].name, "résumé 📌.txt"); assert.equal(await readFile(added.files[0].path, "utf8"), "draft file");
  assert.equal(added.files[0].path.startsWith(join(h.projects[0].path, ".agent-hub", "attachments") + "/"), true);
  h.messages.length = 0; await h.send({ type: "newSession", chatId: h.slots[0].chatId });
  await h.send({ type: "saveAttachment", chatId: h.slots[0].chatId, path: h.projects[0].id, draftContext, name: "stale.txt", dataBase64: "eA==" });
  assert.equal(h.messages.some(m => m.type === "attachmentAdded"), false);
});

test("contextual upload errors identify the exact upload and never write an invalid filename", async (t) => {
  const h = await editSetup(), draftContext = { draftId: "edit-upload", recordId: "record-1", uploadId: "upload-error" };
  let writes = 0;
  t.mock.method(fsPromises, "writeFile", async () => { writes++; });
  await h.send({ type: "saveAttachment", chatId: h.slots[0].chatId, path: h.projects[0].id, draftContext, name: "../outside.txt", dataBase64: "eA==" });
  const error = h.messages.filter(message => message.type === "error").at(-1);
  assert.deepEqual(error?.draftContext, draftContext);
  assert.equal(error?.chatId, h.slots[0].chatId);
  assert.equal(error?.path, h.projects[0].id);
  assert.equal(writes, 0);
});

for (const uploadId of [undefined, "x".repeat(160)]) {
  test(`contextual uploads accept ${uploadId === undefined ? "omitted" : "maximum-length"} upload IDs`, async () => {
    const h = await editSetup();
    const draftContext = { draftId: "edit-upload", recordId: "record-1", ...(uploadId === undefined ? {} : { uploadId }) };
    await h.send({ type: "saveAttachment", chatId: h.slots[0].chatId, path: h.projects[0].id, draftContext, name: "draft.txt", dataBase64: "eA==" });
    const added = h.messages.filter(message => message.type === "attachmentAdded").at(-1);
    assert.deepEqual(added?.draftContext, draftContext);
    assert.equal(await readFile(added.files[0].path, "utf8"), "x");
  });
}

test("upload errors resolved after a record switch cannot affect the new draft", async (t) => {
  const h = await editSetup(), entered = gate(), release = gate();
  const draftContext = { draftId: "edit-upload", recordId: "record-1", uploadId: "old-upload" };
  t.mock.method(fsPromises, "writeFile", async () => { entered.resolve(); await release.promise; throw new Error("upload offline"); });
  const uploading = h.send({ type: "saveAttachment", chatId: h.slots[0].chatId, path: h.projects[0].id, draftContext, name: "draft.txt", dataBase64: "eA==" });
  await entered.promise;
  await h.send({ type: "newSession", chatId: h.slots[0].chatId });
  release.resolve(); await uploading;
  assert.equal(h.messages.some(message => message.type === "error" && /upload offline/.test(message.message)), false);
  assert.equal(h.messages.some(message => message.type === "attachmentAdded"), false);
});

for (const uploadId of ["", 42, null, "x".repeat(161)]) {
  test(`contextual uploads reject invalid upload ID ${JSON.stringify(uploadId).slice(0, 30)}`, async (t) => {
    const h = await editSetup(); let writes = 0;
    t.mock.method(fsPromises, "writeFile", async () => { writes++; });
    await h.send({ type: "saveAttachment", chatId: h.slots[0].chatId, path: h.projects[0].id,
      draftContext: { draftId: "edit-upload", recordId: "record-1", uploadId }, name: "draft.txt", dataBase64: "eA==" });
    assert.equal(writes, 0);
    assert.equal(h.messages.some(message => message.type === "attachmentAdded"), false);
  });
}

test("uploads without a draft context retain ordinary error delivery", async () => {
  const h = await editSetup();
  await h.send({ type: "saveAttachment", chatId: h.slots[0].chatId, path: h.projects[0].id, name: "../outside.txt", dataBase64: "eA==" });
  const error = h.messages.filter(message => message.type === "error").at(-1);
  assert.match(error?.message ?? "", /Некорректное имя/);
  assert.equal(error?.draftContext, undefined);
});

test("replacement retains selected attachments, adds new files and honors removed files", async () => {
  const h = await editSetup(); const second = join(temp, "new-attachment.txt"); await writeFile(second, "new");
  const files = [{ name: "kept.txt", path: h.file }, { name: "new-attachment.txt", path: second }];
  h.record().sentMessages["selected-message"].attachmentFiles = [{ name: "removed.txt", path: join(temp, "removed.txt") }, files[0]];
  await h.send(h.edit({ attachments: files })); const ack = h.acks().at(-1); assert.equal(ack.ok, true);
  assert.deepEqual(h.calls[0].opts.attachments.map(file => file.path), files.map(file => file.path));
  const replacement = Object.values(h.record(ack.recordId).sentMessages).find(m => m.text === "Replacement 📌"); assert.deepEqual(replacement.attachmentFiles, files);
});

test("trimming retained log boundaries makes pruned prompts explicitly unavailable", async () => {
  const h = await editSetup(); h.record().chatLog = Array.from({ length: 200 }, (_, i) => ({ agent: "codex", role: "user", text: `line-${i}` }));
  h.record().sentMessages["first-message"].logCut = 0; h.record().sentMessages["selected-message"].logCut = 2;
  h.record().sentMessages["first-message"].seenBefore = 0; h.record().sentMessages["selected-message"].seenBefore = 1;
  await h.p.runTurn("Newest", "codex", [], h.projects[0].id, true, undefined, h.slots[0].chatId);
  assert.equal(h.record().chatLog.length, 200); assert.equal(h.record().sentMessages["first-message"].logCut, undefined); assert.ok(h.record().sentMessages["first-message"].editUnavailableReason);
  assert.equal(h.record().sentMessages["selected-message"].logCut, 0);
  assert.equal(h.record().sentMessages["first-message"].seenBefore, undefined);
  assert.equal(h.record().sentMessages["selected-message"].seenBefore, 0);
  assert.equal(Object.values(h.record().sentMessages).find(message => message.text === "Newest").seenBefore, 2);
});

test("an unchanged native session resumes with other-provider updates without duplicating its own prior turns", async () => {
  const h = await editSetup(); h.record().chatSeen.codex = 0;
  await h.p.runTurn("Continue", "codex", [], h.projects[0].id, true, undefined, h.slots[0].chatId);
  assert.equal(h.calls[0].prompt.includes("Earlier prompt"), false); assert.equal(h.calls[0].prompt.includes("Discarded future"), true);
});
