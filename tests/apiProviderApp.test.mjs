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
    click(label) { const button = h.button(label); assert.ok(button, label); assert.equal(!!button.props.disabled, false, label); button.props.onClick({ currentTarget: { focus() {} } }); h.render(); },
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
  assert.equal(h.button("saved-model").props.disabled, false);
  assert.equal(h.button("⚡ Авто").props.disabled, false);
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

test("desktop and mobile keep image drafts out of the text-only model's after-turn queue", t => {
  for (const component of [ChatTile, RemoteChatTile]) {
    const h = setup(t, component);
    const image = { name: "capture.JPEG", path: "/fixture/capture.JPEG" };
    const origin = { ...primary, ...pinned, apiProfileModel: "abliterated-model-large-v2" };
    h.event(origin);
    h.event({ type: "busy", value: true });
    h.find(node => node.props.role === "radio" && textOf(node).includes("после")).props.onClick();
    h.render();
    h.draft("  Сравни с описанием  ");
    h.event({ type: "attachmentAdded", files: [image, attachment] });
    assert.equal(h.button("⏳ В очередь").props.disabled, true);
    h.composer().props.onKeyDown({ key: "Enter", preventDefault() {} });
    h.render();
    assert.equal(h.composer().props.value, "  Сравни с описанием  ");
    assert.ok(h.find(node => node.props["aria-label"] === "Открыть capture.JPEG"));
    assert.ok(h.find(node => node.props["aria-label"] === "Открыть notes.txt"));
    assert.match(textOf(h.find(node => node.props.role === "alert")), /abliterated-model-large-v2/);
    assert.equal(h.find(node => node.props.className?.includes("queue-chip")), undefined);
    h.event({ type: "busy", value: false });
    h.event({ ...origin, apiProfileModel: "abliterated-model-large-flash" });
    h.click("Отправить");
    assert.deepEqual(commands.at(-1).attachments, [image, attachment]);
  }
});

function confirmApiSetting(h, request = commands.at(-1)) {
  assert.equal(request.type, "applyApiModelSetting");
  assert.ok(request.requestId);
  h.deliver({ ...request, type: "apiModelSettingSaved", ok: true });
}

test("the text-only composer accepts extensionless dotfiles on POSIX and Windows paths", t => {
  const h = setup(t);
  h.event({ ...primary, ...pinned, apiProfileModel: "abliterated-model-large" });
  const files = [{ name: ".png", path: "/fixture/.png" }, { name: ".PNG", path: "C:\\fixture\\.PNG" },
    { name: ".PNG", path: "C:\\fixture\\.agent-hub\\attachments\\2026-03-03T13-24-58-12345678-4321-4321-8123-0123456789ab-.PNG" }];
  h.event({ type: "attachmentAdded", files });
  h.click("Отправить");
  assert.deepEqual(commands.at(-1).attachments, files);
});

for (const [surface, Component, chatId] of [["desktop", ChatTile], ["tile", ChatTile, "model-tile"], ["mobile", RemoteChatTile]]) {
  test(`${surface} changes model and effort for the bound API record and preserves the composer`, t => {
    const recordId = "api-record", scope = { path: project.id, recordId, apiProfileId: profile.id, ...(chatId && { chatId }) };
    const h = setup(t, Component, chatId ? { chatId, initialProjectPath: project.id, initialRecordId: recordId, initialAgent: "codex" } : {});
    h.event({ ...primary, recordId, ...pinned, apiProfileEffort: "medium" });
    h.draft("Мой черновик"); h.event({ type: "attachmentAdded", files: [attachment] });
    h.click("saved-model");
    const { requestId, ...request } = commands.at(-1);
    assert.ok(requestId);
    assert.deepEqual(request, { type: "apiModelSettings", ...scope, action: "model" });
    const options = { ...request, type: "apiModelOptions", requestId, values: ["", "provider-first", "provider-second"], current: "" };
    for (const mismatch of [{ recordId: "unrelated" }, { apiProfileId: other.id }, { path: "/other" },
        { chatId: chatId ? undefined : "other-tile" }, { requestId: "expired" }, { action: "effort" }]) {
      h.deliver({ ...options, ...mismatch });
      assert.equal(h.find(node => node.type === "select" && node.props["aria-label"] === "Модель для этого чата"), undefined);
    }
    h.deliver(options);
    const models = h.find(node => node.type === "select" && node.props["aria-label"] === "Модель для этого чата");
    const modelChoices = nodes(models).filter(node => node.type === "option");
    assert.deepEqual(modelChoices.slice(0, -1).map(node => node.props.value), options.values);
    assert.equal(textOf(modelChoices.at(-1)), "Ввести ID вручную…");
    models.props.onChange({ target: { value: "provider-second" } }); h.render(); h.click("Применить");
    const { requestId: saveId, ...save } = commands.at(-1);
    assert.deepEqual(save, { type: "applyApiModelSetting", ...scope, action: "model", value: "provider-second" });
    assert.notEqual(saveId, requestId);
    const ack = { ...save, type: "apiModelSettingSaved", ok: true, requestId: saveId };
    for (const mismatch of [{ path: "other" }, { recordId: "other" }, { apiProfileId: other.id },
        { action: "effort" }, { chatId: chatId ? undefined : "other-tile" }, { requestId: "old" }]) {
      h.deliver({ ...ack, ...mismatch });
      assert.ok(h.button("Применить").props.disabled);
      assert.ok(h.button("Отправить").props.disabled);
      h.button("Отправить").props.onClick(); h.render();
      assert.equal(h.composer().props.value, "Мой черновик");
    }
    confirmApiSetting(h);
    assert.equal(h.find(node => node.type === "dialog"), undefined);
    h.event({ ...primary, recordId, ...pinned, apiProfileModel: "provider-second", apiProfileEffort: "medium" });
    assert.ok(h.button("provider-second"));
    h.event({ type: "effortInfo", agent: "codex", effort: "high", recordId });
    h.event({ type: "effortInfo", agent: "codex", effort: "native-global" });
    h.event({ type: "effortInfo", agent: "codex", effort: "old-record", recordId: "old" });
    h.click("⚡ high");
    const effortRequest = commands.at(-1);
    assert.equal(effortRequest.action, "effort");
    h.deliver({ ...effortRequest, type: "apiModelOptions", values: ["low", "high"], current: "high" });
    const efforts = h.find(node => node.type === "select" && node.props["aria-label"] === "Уровень для этого чата");
    assert.equal(efforts.props.value, "high");
    assert.deepEqual(nodes(efforts).filter(node => node.type === "option").map(node => node.props.value), ["", "low", "high"]);
    efforts.props.onChange({ target: { value: "" } }); h.render(); h.click("Применить");
    const { requestId: effortSaveId, ...effortSave } = commands.at(-1);
    assert.ok(effortSaveId);
    assert.deepEqual(effortSave, { type: "applyApiModelSetting", ...scope, action: "effort", value: "" });
    confirmApiSetting(h);
    assert.equal(h.composer().props.value, "Мой черновик");
    assert.ok(h.find(node => node.props["aria-label"] === "Открыть notes.txt"));
    assert.equal(commands.some(message => ["pickModel", "pickEffort", "choose", "send"].includes(message.type)), false);
  });
}

test("API catalog fallback accepts a typed model ID or profile reset, and abandons stale or busy pickers", t => {
  const h = setup(t), recordId = "api-manual";
  h.event({ ...primary, recordId, ...pinned });
  const open = () => { h.click("saved-model"); return commands.at(-1); };
  const first = open();
  h.click("Отмена");
  const second = open();
  h.deliver({ ...first, type: "apiModelOptions", values: ["old"], current: "" });
  assert.equal(h.button("Применить"), undefined);
  const fallback = { type: "apiModelOptions", values: [""], current: "", notice: "Каталог недоступен" };
  h.deliver({ ...second, ...fallback });
  const modelInput = () => h.find(node => node.type === "input" && node.props["aria-label"] === "ID модели API");
  assert.ok(textOf(h.tree).includes(fallback.notice));
  modelInput().props.onChange({ target: { value: "  provider/manual  " } }); h.render(); h.click("Применить");
  assert.equal(commands.at(-1).value, "provider/manual");
  confirmApiSetting(h);
  h.deliver({ ...open(), ...fallback, current: "old-custom-id" });
  modelInput().props.onChange({ target: { value: "" } }); h.render(); h.click("Применить");
  assert.equal(commands.at(-1).value, "");
  confirmApiSetting(h);
  const pending = open();
  h.event({ type: "busy", value: true });
  h.deliver({ ...pending, ...fallback });
  assert.equal(h.find(node => node.type === "dialog"), undefined);
  assert.equal(h.button("saved-model").props.disabled, true);
  h.event({ type: "busy", value: false });
  const beforeSwitch = open();
  h.event({ ...primary, recordId: "native-next" });
  h.deliver({ ...beforeSwitch, ...fallback });
  assert.equal(h.find(node => node.type === "dialog"), undefined);
});

test("discovered and fallback lists offer manual model entry and validate typed IDs before applying", t => {
  const h = setup(t);
  h.event({ ...primary, recordId: "api-record", ...pinned });
  for (const notice of [undefined, "Список из документации профиля"]) {
    h.click("saved-model");
    h.deliver({ ...commands.at(-1), type: "apiModelOptions", values: ["", "known"], current: "", notice });
    const models = h.find(node => node.type === "select" && node.props["aria-label"] === "Модель для этого чата");
    assert.ok(textOf(models).includes("known"));
    const manualChoice = nodes(models).find(node => node.type === "option" && textOf(node) === "Ввести ID вручную…");
    models.props.onChange({ target: { value: manualChoice.props.value } }); h.render();
    const manual = () => h.find(node => node.type === "input" && node.props["aria-label"] === "ID модели API");
    manual().props.onChange({ target: { value: "bad model" } }); h.render();
    assert.equal(manual().props["aria-invalid"], true); assert.equal(h.button("Применить").props.disabled, true);
    manual().props.onChange({ target: { value: "model:version-2026" } }); h.render();
    let prevented = false;
    manual().props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() { prevented = true; } });
    h.render(); assert.equal(prevented, true, "Enter must not also activate the model badge after focus is restored");
    assert.equal(commands.at(-1).value, "model:version-2026");
    confirmApiSetting(h);
  }
});

test("a scoped settings error ends loading and leaves the chat and its draft available", t => {
  const h = setup(t), error = "Адрес профиля изменился";
  h.event({ ...primary, recordId: "error-record", ...pinned });
  h.draft("Keep this draft"); h.click("saved-model");
  const request = commands.at(-1);
  h.deliver({ ...request, type: "apiModelOptions", current: "", values: [], error });
  assert.equal(textOf(h.find(node => node.props.role === "alert")), error);
  assert.equal(h.button("Применить"), undefined);
  assert.equal(h.find(node => node.props["aria-label"] === "ID модели API"), undefined);
  h.click("Закрыть"); assert.equal(h.composer().props.value, "Keep this draft");
});

test("failed API saves preserve the setting and draft and allow retry or cancel", t => {
  const h = setup(t);
  h.event({ ...primary, recordId: "api-save-failure", ...pinned }); h.draft("My draft");
  h.click("saved-model"); h.deliver({ ...commands.at(-1), type: "apiModelOptions", current: "", values: [] });
  const input = () => h.find(node => node.props["aria-label"] === "ID модели API");
  input().props.onChange({ target: { value: "model/v2" } }); h.render(); h.click("Применить");
  const first = commands.at(-1);
  assert.ok(input().props.disabled); assert.ok(h.button("Отмена").props.disabled);
  const dialog = h.find(node => node.type === "dialog");
  dialog.props.onCancel({ preventDefault() {} }); h.render();
  assert.ok(h.find(node => node.type === "dialog"));
  const fail = { ...first, type: "apiModelSettingSaved", ok: false, error: "Диск недоступен" };
  h.deliver(fail);
  assert.equal(textOf(h.find(node => node.props.role === "alert")), fail.error);
  assert.equal(input().props.value, "model/v2");
  assert.ok(!input().props.disabled);
  h.click("Применить");
  const retry = commands.at(-1); assert.notEqual(first.requestId, retry.requestId);
  confirmApiSetting(h, first); assert.ok(h.button("Применить").props.disabled);
  h.deliver({ ...fail, requestId: retry.requestId });
  h.click("Отмена"); assert.equal(h.composer().props.value, "My draft");
  assert.ok(!h.button("Отправить").props.disabled);
});

test("a missing save confirmation times out, keeps the selection, and ignores late acknowledgements", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = setup(t);
  h.event({ ...primary, recordId: "api-lost-save", ...pinned }); h.draft("Unsent");
  h.click("saved-model"); h.deliver({ ...commands.at(-1), type: "apiModelOptions", current: "custom", values: [] });
  h.click("Применить"); const lost = commands.at(-1);
  t.mock.timers.tick(20_000); h.render();
  assert.match(textOf(h.find(node => node.props.role === "alert")), /Подтверждение сохранения не получено/);
  assert.equal(h.find(node => node.props["aria-label"] === "ID модели API").props.value, "custom");
  confirmApiSetting(h, lost); assert.ok(h.button("Применить"));
  h.click("Применить"); confirmApiSetting(h);
  assert.equal(h.find(node => node.type === "dialog"), undefined);
  assert.equal(h.composer().props.value, "Unsent");
});
const rejected = message => ({ type: "sendRejected", requestId: message.requestId, recordId: message.recordId,
  path: message.path, ...(message.chatId && { chatId: message.chatId }), error: "Missing API key" });
const echoes = message => ({ type: "userMessage", requestId: message.requestId, recordId: message.recordId,
  path: message.path, ...(message.chatId && { chatId: message.chatId }), text: message.text });

test("correcting a rejected image draft clears the host warning for that submission", t => {
  for (const correction of ["remove", "model", "text"]) {
    const h = setup(t);
    const origin = { ...primary, ...pinned, apiProfileModel: "abliterated-model" };
    const image = { name: "capture.png", path: "/capture.png" };
    h.event(origin); h.draft("Опиши файл"); h.event({ type: "attachmentAdded", files: [image] });
    h.click("Отправить");
    const error = "Удалите изображение или выберите модель с поддержкой изображений.";
    h.deliver({ ...rejected(commands.at(-1)), error });
    assert.ok(textOf(h.tree).includes(error));
    if (correction === "remove") {
      h.find(node => node.props["aria-label"] === "Убрать вложение capture.png").props.onClick();
      h.render();
    } else if (correction === "model") h.event({ ...origin, apiProfileModel: "abliterated-model-large-flash" });
    else h.draft("Исправленный запрос");
    assert.equal(textOf(h.tree).includes(error), false, correction);
    assert.equal(h.button("Отправить").props.disabled, false);
  }
});

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
