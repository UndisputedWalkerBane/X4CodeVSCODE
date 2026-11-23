import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-api-provider-app-"));
const hookKey = Symbol.for("agent-hub-api-provider-app-hooks");
let commands = [], listeners = new Set(), persisted = [];
const originalGlobals = new Map(["window", "localStorage", "acquireVsCodeApi"].map(key => [key, globalThis[key]]));
globalThis.window = { addEventListener: (_name, listener) => listeners.add(listener), removeEventListener: (_name, listener) => listeners.delete(listener), innerHeight: 800 };
globalThis.localStorage = { getItem: () => null, setItem: (...values) => persisted.push(values), removeItem() {} };
globalThis.acquireVsCodeApi = () => ({ postMessage: message => commands.push(message), setState: value => persisted.push(value) });
after(async () => { for (const [key, value] of originalGlobals) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  delete globalThis[hookKey]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "app.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../webview/App.tsx", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "controlled-api-provider-host", setup(b) {
    b.onResolve({ filter: /^(react(?:\/jsx-runtime)?|react-markdown|remark-gfm)$/ }, ({ path }) => ({ path, namespace: "ui" }));
    b.onLoad({ filter: /.*/, namespace: "ui" }, ({ path }) => {
      if (path.endsWith("jsx-runtime")) return { contents: 'export const Fragment="fragment";export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;' };
      if (path === "react") return { contents: 'const h=()=>globalThis[Symbol.for("agent-hub-api-provider-app-hooks")];export const useState=(v)=>h().state(v);export const useRef=(v)=>h().ref(v);export const useEffect=(f,d)=>h().effect(f,d);export const useMemo=(f,d)=>h().memo(f,d);export const useCallback=(f,d)=>h().memo(()=>f,d);export const useId=()=>h().ref("api-provider-app-id").current;' };
      return { contents: 'export default function Stub(){ return null; }' };
    });
  } }],
});
const { App } = await import(pathToFileURL(outfile));
const ChatTile = App().type;
window.__AGENT_HUB_REMOTE__ = true;
const RemoteChatTile = (await import(`${pathToFileURL(outfile)}?remote`)).App().type;
delete window.__AGENT_HUB_REMOTE__;
const project = { id: "project-one", name: "One", path: "/same/folder" };
function nodes(node) { return Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.props?.children)] : []; }
const textOf = node => node == null || typeof node === "boolean" ? "" : Array.isArray(node) ? node.map(textOf).join("") : typeof node === "object" ? textOf(node.props?.children) : String(node);
function hookRenderer() {
  const slots = []; let cursor = 0, dirty = false, effects = [];
  const hooks = {
    state(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], value => { const next = typeof value === "function" ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    ref(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    memo(fn, deps) { const i = cursor++, previous = slots[i]; if (!previous || deps.some((value, j) => !Object.is(value, previous.deps[j]))) slots[i] = { deps, value: fn() }; return slots[i].value; },
    effect(fn, deps) { const i = cursor++, previous = slots[i]; if (!previous || deps.some((value, j) => !Object.is(value, previous.deps[j]))) {
      previous?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = fn(); }); } },
  };
  return {
    render(Component, props) { for (let n = 0; n < 30; n++) { globalThis[hookKey] = hooks; cursor = 0; dirty = false; effects = [];
      const tree = Component(props); effects.forEach(effect => effect()); if (!dirty) return tree; } assert.fail("render did not settle"); },
    dispose: () => slots.forEach(slot => slot?.cleanup?.()),
  };
}
const profile = { id: "abliteration", name: "Abliteration.ai", model: "catalog-model" };
const other = { id: "custom-test", name: "Other API", model: "other-model" };
const pinned = { apiProfileId: profile.id, apiProfileName: "Saved profile name", apiProfileModel: "saved-model" };
const primary = { type: "agentInfo", path: project.id, recordId: "native-one", agent: "codex" };
const settings = { project: null, claude: {}, codex: {}, secretEnvNames: [], autoAllowTools: [], autoAllowBash: [] };

function setup(t, Component = ChatTile, props = {}) {
  commands = [];
  listeners = new Set();
  const renderer = hookRenderer();
  t.after(renderer.dispose);
  const h = {
    render() { h.tree = renderer.render(Component, props); },
    deliver(message) { for (const listener of listeners) listener({ data: message }); h.render(); },
    event(message) { h.deliver({ path: project.id, ...(props.chatId ? { chatId: props.chatId } : {}), ...message }); },
    find(predicate) { return nodes(h.tree).find(predicate); },
    provider() { return h.find(node => node.props["aria-label"] === "Провайдер чата"); },
    composer() { return h.find(node => node.props["aria-label"] === "Сообщение агенту"); },
    button(label) { return h.find(node => node.type === "button" && textOf(node).trim() === label); },
    change(value) { const provider = h.provider(); assert.equal(provider.props.disabled, false); provider.props.onChange({ target: { value } }); h.render(); },
    draft(value) { h.composer().props.onChange({ target: { value } }); h.render(); },
    click(label) { const button = h.button(label); assert.ok(button, label); assert.equal(!!button.props.disabled, false, label); button.props.onClick(); h.render(); },
  };
  h.render();
  h.event({ type: "projects", projects: [project], activePath: project.id });
  h.deliver({ type: "apiProviders", profiles: [profile, other] });
  return h;
}

test("single chat selects a named API only after its matching ack and restores native Codex explicitly", t => {
  const h = setup(t);
  h.event(primary);
  h.draft("Hello API");
  h.change("api:abliteration");
  assert.deepEqual(commands.at(-1), { type: "selectApiProvider", profileId: profile.id, agent: "codex", path: project.id, recordId: primary.recordId });
  for (const event of [primary, { ...primary, requestedApiProfileId: other.id, requestedAgent: "codex" }]) {
    h.event(event);
    assert.equal(h.button("Отправить").props.disabled, true);
    h.button("Отправить").props.onClick();
    assert.equal(commands.some(msg => msg.type === "send"), false);
  }
  const external = { ...primary, recordId: "external-one", ...pinned };
  h.event({ ...external, requestedApiProfileId: profile.id, requestedAgent: "codex" });
  h.event({ ...primary, recordId: external.recordId });
  h.event({ type: "modelInfo", agent: "codex", model: "native-model" });
  assert.equal(h.provider().props.value, "api:abliteration");
  assert.equal(h.button("saved-model").props.disabled, true);
  assert.equal(h.button("⚡ effort: —").props.disabled, true);
  h.click("Отправить");
  const { requestId, ...sent } = commands.at(-1);
  assert.equal(typeof requestId, "string");
  assert.deepEqual(sent, { type: "send", text: "Hello API", attachments: [], path: project.id, agent: "codex", apiProfileId: profile.id, recordId: external.recordId });

  h.change("codex");
  assert.deepEqual(commands.at(-1), { type: "selectApiProvider", profileId: null, agent: "codex", path: project.id, recordId: external.recordId });
  h.event({ ...external, requestedApiProfileId: null, requestedAgent: "codex", error: "Could not save selection" });
  assert.equal(h.provider().props.value, "api:abliteration");
  assert.ok(textOf(h.tree).includes("Could not save selection"));
  h.change("codex");
  h.event({ ...primary, recordId: "native-two", requestedApiProfileId: null, requestedAgent: "codex" });
  assert.equal(h.provider().props.value, "codex");
  assert.equal(h.button("native-model").props.disabled, false);
  h.draft("Native prompt"); h.click("Отправить");
  assert.equal(commands.at(-1).recordId, "native-two");
  assert.equal(commands.at(-1).apiProfileId, null);
});

test("restored tile uses the pinned API binding, ignores unrelated acks and remains locked through early board hydration", t => {
  const chatId = "external-tile";
  const slot = { chatId, projectPath: project.id, recordId: "saved-record", agent: "codex", title: "", ...pinned };
  const h = setup(t, ChatTile, { chatId, initialAgent: "codex", initialProjectPath: project.id, initialRecordId: slot.recordId,
    initialApiProfileId: pinned.apiProfileId, initialApiProfileName: pinned.apiProfileName, initialApiProfileModel: pinned.apiProfileModel });
  h.event({ ...primary, recordId: slot.recordId });
  assert.equal(h.provider().props.value, "api:abliteration");
  h.deliver({ type: "apiProviders", profiles: [other] });
  assert.ok(textOf(h.provider()).includes(pinned.apiProfileName));
  assert.ok(h.button("saved-model"));
  h.draft("Draft for tile"); h.change("api:custom-test");
  assert.deepEqual(commands.at(-1), { type: "selectApiProvider", profileId: other.id, agent: "codex", path: project.id, recordId: slot.recordId, chatId });
  const next = { ...slot, recordId: "other-record", apiProfileId: other.id, apiProfileName: other.name, apiProfileModel: other.model };
  h.deliver({ type: "multiState", projects: [project], chats: [next] });
  const ack = { ...primary, recordId: next.recordId, apiProfileId: other.id, requestedApiProfileId: other.id, requestedAgent: "codex" };
  h.deliver(ack); h.event({ ...ack, chatId: "unrelated-tile" }); h.event({ ...primary, recordId: next.recordId });
  assert.equal(h.button("Отправить").props.disabled, true);
  h.event(ack);
  h.click("Отправить");
  assert.equal(commands.at(-1).chatId, chatId);
  assert.equal(commands.at(-1).recordId, next.recordId);
  assert.equal(commands.at(-1).apiProfileId, other.id);
});

test("remote can choose catalog entries; only desktop settings expose native profile management", t => {
  for (const [component, desktop] of [[RemoteChatTile, false], [ChatTile, true]]) {
    const h = setup(t, component); h.event(primary);
    assert.ok(textOf(h.provider()).includes(profile.name)); h.change("api:abliteration");
    assert.equal(commands.at(-1).type, "selectApiProvider");
    h.click("⚙"); h.event({ type: "settings", settings });
    assert.equal(!!h.button("Настроить API-провайдеры…"), desktop);
    if (desktop) { h.click("Настроить API-провайдеры…"); assert.deepEqual(commands.at(-1), { type: "manageApiProviders" }); }
  }
});

test("ordinary steer and delayed queued sends retain the profile and record originally addressed", async t => {
  const h = setup(t);
  const recordId = "external-at-submit";
  h.event({ ...primary, recordId, ...pinned });
  h.event({ type: "busy", value: true });
  const selectMode = value => {
    const button = h.find(node => node.props.role === "radio" && textOf(node).includes(value));
    button.props.onClick(); h.render();
  };
  selectMode("на шаге"); h.draft("Steer"); h.click("↪ Докинуть");
  assert.equal(commands.at(-1).type, "steer"); assert.equal(commands.at(-1).recordId, recordId);
  assert.equal(commands.at(-1).apiProfileId, profile.id);
  selectMode("после"); h.draft("Queued"); h.click("⏳ В очередь");
  h.event({ type: "busy", value: false });
  h.event({ ...primary, recordId: "new-native-record" });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(commands.at(-1).type, "send"); assert.equal(commands.at(-1).text, "Queued");
  assert.equal(commands.at(-1).recordId, recordId); assert.equal(commands.at(-1).apiProfileId, profile.id);
  h.deliver(rejected(commands.at(-1)));
  assert.equal(h.button("Восстановить черновик"), undefined);
  h.event({ ...primary, recordId, ...pinned });
  h.click("Восстановить черновик");
  assert.equal(h.composer().props.value, "Queued");
});

const attachment = { name: "notes.txt", path: "/fixture/notes.txt" };
const rejected = message => ({ type: "sendRejected", requestId: message.requestId, recordId: message.recordId,
  path: message.path, ...(message.chatId && { chatId: message.chatId }), error: "Missing API key" });
const echoes = message => ({ type: "userMessage", requestId: message.requestId, recordId: message.recordId,
  path: message.path, ...(message.chatId && { chatId: message.chatId }), text: message.text });

test("a pre-echo failure restores exact text and attachments only to the submitting tile without sending", t => {
  const chatId = "api-restore-tile", recordId = "external-record";
  const h = setup(t, ChatTile, { chatId, initialProjectPath: project.id, initialRecordId: recordId, initialAgent: "codex" });
  h.event({ ...primary, recordId, ...pinned });
  const original = "  Keep this draft\n";
  h.draft(original);
  h.event({ type: "attachmentAdded", files: [attachment] });
  h.click("Отправить");
  const submitted = commands.at(-1), failure = rejected(submitted);
  assert.equal(submitted.text, original.trim());
  assert.equal(h.composer().props.value, "");
  for (const invalid of [{ ...failure, chatId: undefined }, { ...failure, chatId: "other-tile" },
      { ...failure, path: "other-project" }, { ...failure, recordId: "other-record" }, { ...failure, requestId: "other-request" }]) {
    h.deliver(invalid);
    assert.equal(h.composer().props.value, "");
  }
  h.deliver(failure);
  assert.equal(h.composer().props.value, original);
  assert.ok(h.find(node => node.props["aria-label"] === "Открыть notes.txt"));
  assert.ok(textOf(h.tree).includes(failure.error));
  assert.equal(commands.filter(message => message.type === "send").length, 1);
  h.click("Отправить");
  const retry = commands.at(-1);
  assert.notEqual(retry.requestId, submitted.requestId);
  assert.deepEqual(retry.attachments, [attachment]);
  h.deliver(echoes(retry));
  h.deliver(rejected(retry));
  assert.equal(h.composer().props.value, "");
  assert.equal(h.button("Восстановить черновик"), undefined);
});

test("late API rejection keeps newer text and attachments; the original draft can be recovered in its source record", t => {
  const h = setup(t);
  const external = { ...primary, recordId: "external-source", ...pinned };
  h.event(external);
  h.draft("Original on API");
  h.event({ type: "attachmentAdded", files: [attachment] });
  h.click("Отправить");
  const failure = rejected(commands.at(-1));
  h.event({ ...primary, recordId: "different-native" });
  h.draft("Newer input");
  const nextFile = { name: "new.txt", path: "/fixture/new.txt" };
  h.event({ type: "attachmentAdded", files: [nextFile] });
  h.deliver(failure);
  assert.equal(h.composer().props.value, "Newer input");
  assert.equal(h.button("Восстановить черновик"), undefined);
  h.event(external);
  assert.equal(h.composer().props.value, "Newer input");
  assert.equal(h.button("Восстановить черновик").props.disabled, true);
  h.click("Отправить");
  assert.deepEqual(commands.at(-1).attachments, [nextFile]);
  h.click("Восстановить черновик");
  assert.equal(h.composer().props.value, "Original on API");
  assert.ok(h.find(node => node.props["aria-label"] === "Открыть notes.txt"));
  assert.equal(commands.filter(message => message.type === "send").length, 2);
});

test("rejecting attachment-only steering restores the original empty prompt and file", t => {
  const h = setup(t);
  h.event({ ...primary, recordId: "external-steer", ...pinned });
  h.event({ type: "attachmentAdded", files: [attachment] });
  h.event({ type: "busy", value: true });
  const mode = h.find(node => node.props.role === "radio" && textOf(node).includes("на шаге"));
  mode.props.onClick(); h.render();
  h.click("↪ Докинуть");
  const submission = commands.at(-1);
  assert.equal(submission.type, "steer"); assert.ok(submission.requestId);
  h.deliver(rejected(submission));
  assert.equal(h.composer().props.value, "");
  assert.ok(h.find(node => node.props["aria-label"] === "Открыть notes.txt"));
  assert.equal(commands.filter(message => message.type === "steer").length, 1);
});

test("editing the empty composer after submission prevents a late rejection from replacing the new draft", t => {
  const h = setup(t);
  h.event({ ...primary, recordId: "external-active", ...pinned });
  h.draft("Submitted draft"); h.click("Отправить");
  const request = commands.at(-1);
  h.draft("In progress");
  h.deliver(rejected(request));
  assert.equal(h.composer().props.value, "In progress");
  assert.equal(h.button("Восстановить черновик").props.disabled, true);
  h.draft(""); h.click("Восстановить черновик");
  assert.equal(h.composer().props.value, "Submitted draft");
  assert.equal(commands.filter(message => message.type === "send").length, 1);
});
