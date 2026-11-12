import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-resume-pending-"));
const stubKey = Symbol.for("agent-hub-resume-pending-tests");
let current;
globalThis[stubKey] = { get current() { return current; } };
after(async () => { delete globalThis[stubKey]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "provider.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/ChatViewProvider.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "isolated-resume-pending-host", setup(b) {
    b.onResolve({ filter: /^(vscode|qrcode|node:child_process)$|^\.\/agents\/|^\.\/remoteServer$|^\.\/journal$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      const h = 'globalThis[Symbol.for("agent-hub-resume-pending-tests")].current';
      if (path === "vscode") return { contents: `export const workspace={workspaceFolders:[],getConfiguration:(section)=>${h}.configuration(section),openTextDocument:async(doc)=>{${h}.documents.push(doc.content);return doc}};export const window={showInformationMessage:async()=>{},showWarningMessage:async()=>{},showErrorMessage:(message)=>${h}.errors.push(message),showTextDocument:async()=>{}};export const Uri={},commands={executeCommand:async()=>{}},ViewColumn={},ConfigurationTarget={Global:1},ProgressLocation={},env={};export class ThemeIcon{};` };
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
const entry = (text, role = "user", agent = "codex") => ({ agent, role, text });
const accepted = [entry("Accepted original request"), entry("Accepted original plan", "assistant")];
const pending = [entry("Answer to plan question: approve 📌"), entry("Clarification after failed resume: retain Unicode é")];
const currentPrompt = "Current message: continue with these answers";
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function until(check) {
  for (let i = 0; i < 50; i++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail("provider did not reach expected state");
}

async function setup(options = {}) {
  const { log = [...accepted, ...pending], agent = "codex", resumed = true } = options;
  const cursor = Object.hasOwn(options, "cursor") ? options.cursor : 2;
  const path = join(temp, "project"); await mkdir(path, { recursive: true });
  const project = { id: "project-resume", name: "Fixture", path };
  const record = { id: "record-resume", title: "Fixture history", createdAt: 1, updatedAt: 1,
    agentIds: { codex: resumed ? "native-codex" : null, claude: resumed ? "native-claude" : null },
    items: [], chatLog: structuredClone(log), ...(cursor === undefined ? {} : { chatSeen: { [agent]: cursor } }) };
  const slot = { chatId: "chat-resume-pending", projectPath: project.id, recordId: record.id, agent };
  const global = new Map([[STORE, { [project.id]: { activeId: record.id, sessions: [record] } }]]);
  const workspace = new Map([[CHATS, [slot]]]);
  const h = { project, slot, global, workspace, messages: [], errors: [], documents: [], calls: [] };
  const values = { projects: [project], autoCommit: false, autoPull: false, "codex.model": "test-model" };
  h.configuration = section => ({ get: (name, fallback) => values[section === "agentHub" ? name : `${section?.replace(/^agentHub\./, "")}.${name}`] ?? fallback });
  const memento = data => ({ keys: () => [...data.keys()], get: (key, fallback) => data.has(key) ? data.get(key) : fallback,
    update: async (key, value) => { data.set(key, structuredClone(value)); } });
  current = h;
  const p = Object.create(ChatViewProvider.prototype);
  p.context = { globalState: memento(global), workspaceState: memento(workspace), secrets: { get: async () => undefined } };
  p.runs = new Map(); p.pendingPermissions = new Map(); p.deferred = new Map(); p.steers = new Map(); p.steerTexts = new Map(); p.sessionWriters = new Map();
  p.post = message => h.messages.push(message);
  p.multiPanel = { webview: { postMessage: message => h.messages.push(message) } };
  p.relocateAttachments = async (_cwd, attachments) => attachments;
  p.autoPull = async () => {}; p.autoCommit = async () => {}; p.buildProjectCard = async () => "Fixture project card";
  p.getAgentAccessSnapshot = async () => ({ environment: {}, entries: [] });
  p.claudeModelsStale = () => false; p.resolveClaudeCli = () => undefined;
  p.buildAgentConfig = () => ({});
  p.backends = Object.fromEntries(["codex", "claude"].map(provider => [provider, {
    async *start(prompt, opts) {
      h.calls.push({ agent: provider, prompt, opts, logAtStart: structuredClone(h.record().chatLog) });
      yield* h.events(provider, opts);
    },
  }]));
  h.events = async function* (provider, opts) { yield { kind: "session", sessionId: opts.resumeSessionId ?? `fresh-${provider}` }; yield { kind: "assistantText", text: "Recovery reply" }; };
  h.p = p;
  h.record = () => p.getProjectStore(project.id).sessions.find(value => value.id === record.id);
  h.run = (prompt = currentPrompt, provider = agent, kind) => p.runTurn(prompt, provider, [], project.id, true, undefined, slot.chatId, false, kind);
  h.preview = async (provider = agent) => { await p.showContext(provider, slot.chatId); return h.documents.at(-1); };
  return h;
}

const occurrences = (text, needle) => text.split(needle).length - 1;
const assertOrdered = (text, values) => {
  let previous = -1;
  for (const value of values) { const index = text.indexOf(value); assert.ok(index > previous, `expected ${JSON.stringify(value)} after preceding message`); previous = index; }
};

test("resumed Codex carries two saved unanswered messages once before the current prompt", async () => {
  const h = await setup();
  const originalLog = structuredClone(h.record().chatLog);
  await h.run();
  assert.ok(h.calls.length, JSON.stringify(h.messages));
  const prompt = h.calls[0].prompt;
  assertOrdered(prompt, [...pending.map(value => value.text), currentPrompt]);
  for (const value of [...pending.map(value => value.text), currentPrompt]) assert.equal(occurrences(prompt, value), 1);
  for (const value of accepted) assert.equal(prompt.includes(value.text), false);
  assert.deepEqual(h.calls[0].logAtStart, originalLog);
  assert.deepEqual(h.record().chatLog.slice(0, originalLog.length), originalLog);
  assert.equal(h.record().chatSeen.codex, h.record().chatLog.length);
  assert.ok(h.messages.some(message => message.type === "info" && message.text.includes("сохранённые сообщения из ленты")));
  await h.run("One more current message");
  for (const value of [...pending, entry(currentPrompt)]) assert.equal(h.calls[1].prompt.includes(value.text), false);
  assert.equal(occurrences(h.calls[1].prompt, "One more current message"), 1);
  assert.equal(h.p.sessionWriters.size, 0);
});

test("answers logged after two pre-session resume failures reach the recovery prompt in order", async () => {
  const h = await setup({ log: accepted });
  h.events = async function* () { yield { kind: "error", message: "thread/resume timed out" }; };
  await h.run(pending[0].text, "codex", "question");
  await h.run(pending[1].text);
  assert.equal(h.record().chatSeen.codex, 2);
  assert.deepEqual(h.record().chatLog, [...accepted, ...pending]);
  h.events = async function* () { yield { kind: "session", sessionId: "recovered-codex" }; yield { kind: "assistantText", text: "Recovered" }; };
  await h.run();
  assertOrdered(h.calls[2].prompt, [...pending.map(value => value.text), currentPrompt]);
  for (const value of pending) assert.equal(occurrences(h.calls[2].prompt, value.text), 1);
  assert.equal(h.calls[2].opts.resumeSessionId, "native-codex");
});

test("a session event followed by an ambiguous turn-start failure advances the checkpoint without replay", async () => {
  const h = await setup({ log: accepted });
  h.events = async function* () { yield { kind: "session", sessionId: "native-codex" }; throw new Error("turn/start failed after resume"); };
  await h.run(pending[0].text);
  assert.equal(h.record().chatSeen.codex, 3);
  h.events = async function* () { yield { kind: "session", sessionId: "native-codex" }; };
  await h.run();
  assert.equal(h.calls[1].prompt.includes(pending[0].text), false);
});

test("resumed Codex includes pending user entries and other-provider context while excluding its own assistant", async () => {
  const other = entry("Claude decision after checkpoint", "assistant", "claude");
  const ownAssistant = entry("Do not inject own assistant again", "assistant");
  const h = await setup({ log: [...accepted, pending[0], ownAssistant, other, pending[1]] });
  await h.run();
  assertOrdered(h.calls[0].prompt, [pending[0].text, other.text, pending[1].text, currentPrompt]);
  assert.equal(h.calls[0].prompt.includes(ownAssistant.text), false);
  assert.equal(h.calls[0].prompt.includes("ты их ещё не видел"), false);
});

test("explicit zero is a valid checkpoint for pending Codex users", async () => {
  const h = await setup({ log: [pending[0], entry("Own assistant is not pending", "assistant")], cursor: 0 });
  await h.run();
  assert.equal(occurrences(h.calls[0].prompt, pending[0].text), 1);
  assert.equal(h.calls[0].prompt.includes("Own assistant is not pending"), false);
});

for (const [label, sessionId, included] of [["matching", "native-codex", false], ["foreign", "another-codex-session", true]]) {
  test(`${label} authoritative native anchor ${included ? "does not prove acceptance" : "prevents replay"} when the cursor is behind`, async () => {
    const h = await setup({ log: [pending[0]], cursor: 0 });
    h.record().sentMessages = { known: { messageId: "known", agent: "codex", kind: "prompt", text: pending[0].text,
      attachmentFiles: [], logCut: 0, anchor: { provider: "codex", sessionId, turnId: "accepted-turn" } } };
    await h.run();
    assert.equal(h.calls[0].prompt.includes(pending[0].text), included);
  });
}

test("a stale anchored prompt cannot claim an undelivered row that later occupies its saved cut", async () => {
  const h = await setup();
  h.record().sentMessages = { crashed: { messageId: "crashed", agent: "codex", kind: "prompt", text: "Anchored prompt lost before log append",
    attachmentFiles: [], logCut: 2, anchor: { provider: "codex", sessionId: "native-codex", turnId: "accepted-before-crash" } } };
  await h.run();
  assertOrdered(h.calls[0].prompt, [...pending.map(value => value.text), currentPrompt]);
});

for (const [label, filePath, included] of [["matching", "/fixture/original.png", false], ["different", "/fixture/replacement.png", true]]) {
  test(`${label} saved attachment identity ${included ? "keeps pending row" : "proves anchored row acceptance"}`, async () => {
    const text = "Question with attachment";
    const logged = `${text}\n\nПриложенные файлы:\n- ${filePath} (изображение — открой и рассмотри)`;
    const h = await setup({ log: [entry(logged)], cursor: 0 });
    h.record().sentMessages = { anchored: { messageId: "anchored", agent: "codex", kind: "prompt", text,
      attachmentFiles: [{ name: "original.png", path: "/fixture/original.png" }], logCut: 0,
      anchor: { provider: "codex", sessionId: "native-codex", turnId: "attachment-turn" } } };
    await h.run();
    assert.equal(h.calls[0].prompt.includes(logged), included);
  });
}

for (const [label, acceptedSessionId] of [["foreign", "another-codex-session"], ["malformed", { sessionId: "native-codex" }]]) {
  test(`${label} per-entry acceptance cannot suppress pending own messages`, async () => {
    const h = await setup({ log: [{ ...pending[0], acceptedSessionId }], cursor: 0 });
    await h.run();
    assert.equal(h.calls[0].prompt.includes(pending[0].text), true);
  });
}

test("a verified complete-history fork remaps only matching per-entry acceptance", async () => {
  const h = await setup({ log: [...accepted, { ...pending[0], acceptedSessionId: "native-codex" },
    { ...pending[1], acceptedSessionId: "another-codex-session" }] });
  h.events = async function* () { yield { kind: "session", sessionId: "verified-fork", forkedFromSessionId: "native-codex" }; };
  await h.run();
  assert.equal(h.calls[0].prompt.includes(pending[0].text), false);
  assert.equal(h.calls[0].prompt.includes(pending[1].text), true);
  assert.equal(h.record().chatLog[2].acceptedSessionId, "verified-fork");
  assert.equal(h.record().chatLog[3].acceptedSessionId, "another-codex-session");
});

test("late acknowledged live steering belongs to its original record and is not replayed", async () => {
  const h = await setup({ log: accepted }); const ack = gate(), done = gate();
  h.events = async function* (_provider, opts) {
    opts.steer.handler = async () => ack.promise;
    yield { kind: "session", sessionId: "native-codex" };
    await done.promise;
  };
  const run = h.run("Original live task");
  await until(() => h.p.steers.get(h.slot.chatId)?.handler);
  const steered = h.p.onMessage({ type: "steer", text: "Accepted late steering", agent: "codex", path: h.project.id, chatId: h.slot.chatId, mode: "next" });
  await until(() => h.messages.some(message => message.type === "userMessage" && message.text === "Accepted late steering"));
  done.resolve(); await run;
  h.events = async function* () { yield { kind: "error", message: "resume failed" }; };
  await h.run("Other undelivered prompt");
  const freshTexts = ["Foreign in-flight map"];
  h.p.steerTexts.set(h.slot.chatId, freshTexts);
  ack.resolve(); await steered;
  assert.deepEqual(h.p.steerTexts.get(h.slot.chatId), freshTexts);
  assert.equal(h.record().chatLog.filter(value => value.text === "Accepted late steering").length, 1);
  assert.equal(h.record().chatSeen.codex, 3);
  await h.run();
  assert.equal(h.calls[2].prompt.includes("Accepted late steering"), false);
  assert.equal(h.calls[2].prompt.includes("Other undelivered prompt"), true);
});

for (const verifiedFork of [true, false]) {
  test(`late live steering ACK ${verifiedFork ? "follows verified fork lineage" : "cannot claim an unrelated replacement session"}`, async () => {
    const h = await setup({ log: accepted }); const ack = gate(), done = gate();
    h.events = async function* (_provider, opts) {
      opts.steer.handler = async () => ack.promise;
      yield { kind: "session", sessionId: "native-codex" };
      await done.promise;
    };
    const run = h.run("Original live task");
    await until(() => h.p.steers.get(h.slot.chatId)?.handler);
    const steered = h.p.onMessage({ type: "steer", text: "ACK after native change", agent: "codex", path: h.project.id, chatId: h.slot.chatId, mode: "next" });
    await until(() => h.messages.some(message => message.type === "userMessage" && message.text === "ACK after native change"));
    done.resolve(); await run;
    h.events = async function* () { yield { kind: "session", sessionId: "replacement-session", ...(verifiedFork ? { forkedFromSessionId: "native-codex" } : {}) }; };
    await h.run("Recover original session");
    h.events = async function* () { yield { kind: "error", message: "resume failed" }; };
    await h.run("Intervening undelivered prompt");
    ack.resolve(); await steered;
    assert.equal(h.record().chatLog.at(-1).acceptedSessionId, verifiedFork ? "replacement-session" : "native-codex");
    await h.run();
    assert.equal(h.calls[3].prompt.includes("ACK after native change"), !verifiedFork);
    assert.equal(h.calls[3].prompt.includes("Intervening undelivered prompt"), true);
  });
}

test("a checkpoint at the current log end contributes no old Codex messages", async () => {
  const h = await setup({ cursor: accepted.length + pending.length });
  await h.run();
  for (const value of [...accepted, ...pending]) assert.equal(h.calls[0].prompt.includes(value.text), false);
});

for (const [label, cursor] of [["absent", undefined], ["negative", -1], ["NaN", NaN], ["infinite", Infinity], ["fractional", 1.5], ["too large", 99], ["string", "2"], ["null", null]]) {
  test(`${label} saved cursor does not replay own historical Codex messages`, async () => {
    const other = entry("Other-provider legacy context", "user", "claude");
    const h = await setup({ log: [...accepted, ...pending, other], cursor });
    await h.run();
    for (const value of [...accepted, ...pending]) assert.equal(h.calls[0].prompt.includes(value.text), false);
    assert.equal(h.calls[0].prompt.includes(other.text), true);
  });
}

test("context preview and the actual resumed prompt contain the same saved history block", async () => {
  const h = await setup({ log: [...accepted, pending[0], entry("Claude update", "assistant", "claude"), pending[1]] });
  const preview = await h.preview();
  const blocks = [...preview.matchAll(/```\n([\s\S]*?)\n```/g)].map(match => match[1]);
  const historyBlock = blocks.find(block => block.startsWith("Контекст беседы:"));
  assert.ok(historyBlock);
  assertOrdered(historyBlock, pending.map(value => value.text));
  assert.equal(preview.includes("Сообщения другого агента из этой ленты"), false);
  await h.run();
  assert.equal(h.calls[0].prompt.includes(historyBlock), true);
});

test("fresh native sessions retain their own complete saved history in preview and send", async () => {
  const h = await setup({ resumed: false });
  const preview = await h.preview();
  for (const value of [...accepted, ...pending]) assert.equal(preview.includes(value.text), true);
  await h.run();
  assertOrdered(h.calls[0].prompt, [...accepted, ...pending].map(value => value.text).concat(currentPrompt));
});

test("resumed Claude retains other-provider-only selection and slash commands do not advance its checkpoint", async () => {
  const own = entry("Claude saved answer", "user", "claude");
  const other = entry("Codex decision for Claude", "assistant");
  const h = await setup({ log: [own, other], cursor: 0, agent: "claude" });
  await h.run("/compact");
  assert.equal(h.calls[0].prompt, "/compact");
  assert.equal(h.record().chatSeen.claude, 0);
  await h.run("Continue Claude", "claude");
  assert.equal(h.calls[1].prompt.includes(own.text), false);
  assert.equal(h.calls[1].prompt.includes(other.text), true);
  assert.equal(h.calls[1].prompt.includes("/compact"), false);
});

test("resumed history keeps existing entry truncation and latest-message total caps", async () => {
  const long = entry("Long pending answer:" + "x".repeat(6000) + ":clipped tail");
  const h = await setup({ log: [...accepted, long], cursor: 2 });
  await h.run();
  assert.equal(h.calls[0].prompt.includes("Long pending answer:"), true);
  assert.equal(h.calls[0].prompt.includes(":clipped tail"), false);
  assert.equal(h.calls[0].prompt.includes("…[обрезано]"), true);
  const many = Array.from({ length: 20 }, (_, i) => entry(`pending-${i}:` + "x".repeat(3500)));
  const capped = await setup({ log: [...accepted, ...many], cursor: 2 });
  await capped.run();
  assert.equal(capped.calls[0].prompt.includes("pending-0:"), false);
  assert.equal(capped.calls[0].prompt.includes("pending-19:"), true);
  assert.match(capped.calls[0].prompt, /показаны последние \d+ из 20/);
});
