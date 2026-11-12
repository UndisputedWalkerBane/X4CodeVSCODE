import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-access-app-"));
const hookKey = Symbol.for("agent-hub-access-app-hooks");
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
  plugins: [{ name: "controlled-access-app-host", setup(b) {
    b.onResolve({ filter: /^(react(?:\/jsx-runtime)?|react-markdown|remark-gfm)$/ }, ({ path }) => ({ path, namespace: "ui" }));
    b.onLoad({ filter: /.*/, namespace: "ui" }, ({ path }) => {
      if (path.endsWith("jsx-runtime")) return { contents: 'export const Fragment="fragment";export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;' };
      if (path === "react") return { contents: 'const h=()=>globalThis[Symbol.for("agent-hub-access-app-hooks")];export const useState=(v)=>h().state(v);export const useRef=(v)=>h().ref(v);export const useEffect=(f,d)=>h().effect(f,d);export const useMemo=(f,d)=>h().memo(f,d);export const useCallback=(f,d)=>h().memo(()=>f,d);export const useId=()=>h().ref("access-app-id").current;' };
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
const otherProject = { ...project, id: "project-two", name: "Two" };
const settings = (projectValue = project) => ({ project: projectValue, projectHasPassword: true, secretEnvNames: ["OLD_ENV"],
  claude: { model: "", effort: "", permissionMode: "default", maxTurns: 0, contextWindow: 0 }, codex: { model: "", effort: "", sandbox: "workspace-write", yolo: false, contextWindow: 0 },
  journalDir: "docs/journal", journalContextEntries: 3, autoAllowTools: [], autoAllowBash: [], autoCommit: false, autoPush: false, autoPull: true, autoScrollMode: "perProject" });
const summary = { id: "access-one", name: "Metrics", purpose: "Read reports", hasValues: { url: true, login: true, password: true, apiKey: false }, envNames: { url: "SAFE_URL", login: "SAFE_LOGIN", password: "SAFE_PASSWORD", apiKey: "SAFE_API_KEY" } };
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
function setup(props = {}, remote = false) {
  commands = []; listeners = new Set(); persisted = [];
  const parent = hookRenderer(); let child, childKey;
  const h = { tree: null, editor: null };
  h.card = () => nodes(h.tree).find(node => typeof node.type === "function" && node.type.name === "ProjectAccesses");
  h.render = () => { h.tree = parent.render(remote ? RemoteChatTile : ChatTile, props); const card = h.card();
    if (!card || card.key !== childKey) { child?.dispose(); child = undefined; childKey = card?.key; }
    if (card) { child ??= hookRenderer(); h.editor = child.render(card.type, card.props); } else h.editor = null; };
  h.deliver = message => { [...listeners].forEach(listener => listener({ data: message })); h.render(); };
  h.input = name => nodes(h.editor).find(node => node.type === "input" && node.props.name === name);
  h.edit = (name, value) => { h.input(name).props.onChange({ target: { value } }); h.render(); };
  h.button = (label, editor = false) => nodes(editor ? h.editor : h.tree).find(node => node.type === "button" && (node.props["aria-label"] ?? textOf(node.props.children).trim()) === label);
  h.click = (label, editor = false) => { const button = h.button(label, editor); assert.ok(button, `missing ${label}`); assert.equal(!!button.props.disabled, false); button.props.onClick(); h.render(); };
  h.respond = (patch = {}) => { const request = commands.filter(message => ["getProjectAccesses", "saveProjectAccess", "deleteProjectAccess"].includes(message.type)).at(-1);
    assert.ok(request, "missing access request"); h.deliver({ type: "projectAccesses", projectPath: request.projectPath, requestId: request.requestId, revision: 1, entries: [summary], ...(props.chatId ? { chatId: props.chatId } : {}), ...patch }); };
  h.dispose = () => { parent.dispose(); child?.dispose(); };
  h.render(); h.deliver({ type: "projects", projects: [project, otherProject], activePath: project.id, ...(props.chatId ? { chatId: props.chatId } : {}) });
  h.click("⚙"); h.deliver({ type: "settings", settings: settings(), ...(props.chatId ? { chatId: props.chatId } : {}) });
  return h;
}

test("settings show the inline service cards alongside the old env manager and scope every request", () => {
  const chatId = "access-chat-one"; const h = setup({ chatId, initialProjectPath: project.id, initialRecordId: "record-one" });
  assert.ok(h.card(), "inline accesses editor must exist"); assert.equal(h.card().props.projectPath, project.id);
  assert.ok(textOf(h.tree).includes("OLD_ENV"));
  const load = commands.find(message => message.type === "getProjectAccesses"); assert.equal(load.chatId, chatId); assert.equal(load.projectPath, project.id);
  h.respond(); h.click("Изменить Metrics", true); h.edit("password", "fake-new-password"); h.click("Сохранить доступ", true);
  assert.equal(commands.at(-1).chatId, chatId); assert.equal(commands.at(-1).projectPath, project.id);
  h.respond({ revision: 2 }); h.click("Удалить Metrics", true); assert.equal(commands.at(-1).chatId, chatId); assert.equal(commands.at(-1).type, "deleteProjectAccess");
  h.dispose();
});

test("access metadata and CRUD responses preserve the separate unsaved project and server password drafts", () => {
  const h = setup(); h.respond();
  const projectName = () => nodes(h.tree).find(node => node.type === "label" && textOf(node.props.children).startsWith("Название")).props.children.find(node => node?.type === "input");
  const serverPassword = () => nodes(h.tree).find(node => node.type === "input" && node.props.type === "password");
  projectName().props.onChange({ target: { value: "Unsaved project title" } }); serverPassword().props.onChange({ target: { value: "fake-primary-password" } }); h.render();
  assert.equal(commands.filter(message => message.type === "getProjectAccesses").length, 1, "unrelated settings edits must not reload the access editor");
  h.click("Добавить доступ", true); h.edit("name", "New service"); h.edit("apiKey", "fake-inline-key"); h.click("Сохранить доступ", true); h.respond({ revision: 2 });
  assert.equal(projectName().props.value, "Unsaved project title"); assert.equal(serverPassword().props.value, "fake-primary-password");
  assert.equal(commands.some(message => ["saveSettings", "send", "steer", "saveTranscript"].includes(message.type)), false);
  assert.equal(JSON.stringify(persisted).includes("fake-inline-key"), false); assert.equal(JSON.stringify(persisted).includes("fake-primary-password"), false);
  h.click("Сохранить"); const savedSettings = commands.find(message => message.type === "saveSettings");
  assert.equal(savedSettings.settings.project.name, "Unsaved project title"); assert.equal(savedSettings.settings.newPassword, "fake-primary-password"); h.dispose();
});

test("other chats and stale project events cannot acknowledge a save or replace the current project editor", () => {
  const chatId = "access-chat-one"; const h = setup({ chatId, initialProjectPath: project.id, initialRecordId: "record-one" }); h.respond();
  h.click("Изменить Metrics", true); h.edit("apiKey", "fake-local-key"); h.click("Сохранить доступ", true);
  const pending = commands.at(-1);
  h.respond({ chatId: "other-chat", revision: 3 }); h.respond({ chatId: undefined, revision: 3 }); h.respond({ projectPath: otherProject.id, revision: 3 });
  assert.equal(h.input("apiKey").props.value, "fake-local-key"); assert.equal(h.button("Сохранить доступ", true).props.disabled, true);
  h.respond({ revision: 2, error: "Storage unavailable" }); assert.equal(h.input("apiKey").props.value, "fake-local-key");
  assert.ok(nodes(h.editor).some(node => node.props?.role === "alert"));
  h.deliver({ type: "settings", chatId, settings: settings(otherProject) }); assert.equal(h.card().props.projectPath, otherProject.id); assert.equal(h.input("apiKey"), undefined);
  const nextLoad = commands.at(-1); assert.equal(nextLoad.projectPath, otherProject.id);
  h.deliver({ type: "projectAccesses", chatId, projectPath: project.id, requestId: pending.requestId, revision: 9, entries: [summary] });
  assert.equal(h.card().props.projectPath, otherProject.id); assert.equal(h.button("Добавить доступ", true).props.disabled, true);
  h.respond({ entries: [] }); h.click("Добавить доступ", true); assert.equal(h.input("apiKey").props.value, ""); h.dispose();
});

test("closing settings unmounts new secret drafts and reopening loads metadata afresh", () => {
  const h = setup(); h.respond(); h.click("Добавить доступ", true); h.edit("password", "fake-discarded-secret"); h.click("← Назад");
  assert.equal(h.card(), undefined); h.click("⚙"); assert.ok(h.card()); h.respond(); h.click("Добавить доступ", true);
  assert.equal(h.input("password").props.value, ""); assert.equal(commands.some(message => message.type === "saveProjectAccess"), false); h.dispose();
});

test("remote settings never mount the credential editor or request its metadata", () => {
  const h = setup({}, true); assert.equal(h.card(), undefined); assert.equal(commands.some(message => message.type === "getProjectAccesses"), false); h.dispose();
});
