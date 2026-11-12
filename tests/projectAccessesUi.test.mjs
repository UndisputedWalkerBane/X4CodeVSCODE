import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-access-ui-"));
const hookKey = Symbol.for("agent-hub-access-ui-hooks");
after(async () => { delete globalThis[hookKey]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "accesses.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../webview/ProjectAccesses.tsx", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "controlled-access-react-host", setup(b) {
    b.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, ({ path }) => ({ path, namespace: "ui" }));
    b.onLoad({ filter: /.*/, namespace: "ui" }, ({ path }) => path.endsWith("jsx-runtime")
      ? { contents: 'export const Fragment="fragment";export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;' }
      : { contents: 'const h=()=>globalThis[Symbol.for("agent-hub-access-ui-hooks")];export const useState=(v)=>h().state(v);export const useRef=(v)=>h().ref(v);export const useEffect=(f,d)=>h().effect(f,d);export const useId=()=>h().ref("access-id").current;' });
  } }],
});
const { ProjectAccesses } = await import(pathToFileURL(outfile));
const fields = ["url", "login", "password", "apiKey"];
const summary = (patch = {}) => ({ id: "access-one", name: "Production", purpose: "Deploy the project", hasValues: Object.fromEntries(fields.map(field => [field, true])), envNames: Object.fromEntries(fields.map(field => [field, `SAFE_${field.toUpperCase()}`])), ...patch });
const textOf = node => node == null || typeof node === "boolean" ? "" : Array.isArray(node) ? node.map(textOf).join("") : typeof node === "object" ? textOf(node.props?.children) : String(node);
function nodes(node) { return Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.props?.children)] : []; }
function harness(props = {}) {
  const slots = []; let cursor = 0, dirty = false, effects = [];
  const elements = new WeakMap(); let committedRefs = new Set();
  const hooks = {
    state(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], value => { const next = typeof value === "function" ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    ref(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    effect(fn, deps) { const i = cursor++, previous = slots[i]; if (!previous || deps.some((value, j) => !Object.is(value, previous.deps[j]))) {
      previous?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = fn(); }); } },
  };
  const h = { commands: [], props: { projectPath: "project-one", snapshot: null, ...props }, tree: null, focused: null };
  h.props.onPost = message => h.commands.push(message);
  const commitRefs = () => {
    const nextRefs = new Set();
    for (const node of nodes(h.tree)) {
      const ref = node.props?.ref;
      if (!ref || typeof ref !== "object") continue;
      let element = elements.get(ref);
      if (!element) {
        element = { disabled: false, name: "", focus() { if (!this.disabled) h.focused = this.name; } };
        elements.set(ref, element);
      }
      element.disabled = !!node.props.disabled;
      element.name = node.props.name ?? textOf(node.props.children);
      ref.current = element;
      nextRefs.add(ref);
    }
    for (const ref of committedRefs) if (!nextRefs.has(ref)) ref.current = null;
    committedRefs = nextRefs;
  };
  h.render = () => { for (let n = 0; n < 30; n++) { globalThis[hookKey] = hooks; cursor = 0; dirty = false; effects = [];
    h.tree = ProjectAccesses(h.props); commitRefs(); effects.forEach(effect => effect()); if (!dirty) return; } assert.fail("render did not settle"); };
  h.all = type => nodes(h.tree).filter(node => node.type === type);
  h.button = label => h.all("button").find(node => (node.props["aria-label"] ?? textOf(node.props.children)) === label);
  h.click = label => { const button = h.button(label); assert.ok(button, `missing ${label}`); assert.equal(!!button.props.disabled, false); h.focused = label; button.props.onClick(); h.render(); };
  h.input = name => h.all("input").find(node => node.props.name === name);
  h.edit = (name, value) => { const input = h.input(name); assert.ok(input, `missing ${name}`); input.props.onChange({ target: { value } }); h.render(); };
  h.respond = (patch = {}) => { const request = h.commands.at(-1); h.props.snapshot = { type: "projectAccesses", projectPath: h.props.projectPath, requestId: request.requestId, revision: 0, entries: [], ...(h.props.chatId ? { chatId: h.props.chatId } : {}), ...patch }; h.render(); };
  h.render(); return h;
}

test("requests metadata on mount and loads named cards without any stored values", () => {
  const h = harness(); assert.equal(h.commands[0].type, "getProjectAccesses"); assert.equal(h.commands[0].projectPath, "project-one");
  assert.equal(h.button("Добавить доступ").props.disabled, true);
  h.respond({ revision: 3, entries: [summary()] });
  assert.ok(textOf(h.tree).includes("Production")); assert.ok(textOf(h.tree).includes("Deploy the project"));
  assert.equal(h.all("input").length, 0); assert.equal(h.commands.length, 1);
  h.click("Изменить Production");
  for (const field of fields) assert.equal(h.input(field).props.value, "");
  assert.equal(h.input("password").props.type, "password"); assert.equal(h.input("apiKey").props.type, "password");
  for (const input of h.all("input").filter(node => node.props.type !== "checkbox")) assert.ok(h.all("label").some(label => label.props.htmlFor === input.props.id));
});

test("adding is local until Save and successful saving clears every credential draft", () => {
  const h = harness(); h.respond(); h.click("Добавить доступ"); h.edit("name", "Analytics"); h.edit("purpose", "Read reports");
  h.edit("url", "https://metrics.invalid"); h.edit("password", "fake-secret-for-test");
  assert.equal(h.commands.length, 1); h.click("Сохранить доступ");
  const request = h.commands.at(-1); assert.equal(request.type, "saveProjectAccess"); assert.equal(request.expectedRevision, 0);
  assert.deepEqual(request.access, { name: "Analytics", purpose: "Read reports", values: { url: "https://metrics.invalid", password: "fake-secret-for-test" } });
  assert.equal(h.button("Сохранить доступ").props.disabled, true);
  h.respond({ revision: 1, entries: [summary({ name: "Analytics" })] }); assert.equal(h.all("input").length, 0);
  h.click("Изменить Analytics"); assert.equal(h.input("password").props.value, "");
});

test("blank edit fields preserve stored values while explicit clear sends only the selected field", () => {
  const h = harness(); h.respond({ revision: 2, entries: [summary()] }); h.click("Изменить Production"); h.edit("purpose", "A new purpose");
  h.click("Очистить сохранённое: Пароль"); h.click("Сохранить доступ");
  assert.deepEqual(h.commands.at(-1).access, { id: "access-one", name: "Production", purpose: "A new purpose", clearFields: ["password"] });
  assert.equal(h.commands.at(-1).expectedRevision, 2);
});

test("cancel discards new credentials and never writes; a new editor starts empty", () => {
  const h = harness(); h.respond(); h.click("Добавить доступ"); h.edit("name", "Unsent"); h.edit("apiKey", "fake-unsent-key"); h.click("Отмена доступа");
  assert.equal(h.commands.length, 1); assert.equal(h.all("input").length, 0); h.click("Добавить доступ");
  assert.equal(h.input("name").props.value, ""); assert.equal(h.input("apiKey").props.value, "");
});

test("missing name or all empty values visibly blocks saving", () => {
  const h = harness(); h.respond(); h.click("Добавить доступ");
  assert.equal(h.button("Сохранить доступ").props.disabled, true); h.edit("name", "Without credentials");
  assert.equal(h.button("Сохранить доступ").props.disabled, true); assert.ok(nodes(h.tree).some(node => node.props?.role === "alert"));
  h.edit("login", "test-user"); assert.equal(h.button("Сохранить доступ").props.disabled, false);
});

test("failed save keeps local secrets and adopts the conflict revision for explicit retry", () => {
  const h = harness(); h.respond({ revision: 2, entries: [summary()] }); h.click("Изменить Production"); h.edit("apiKey", "fake-retry-key"); h.click("Сохранить доступ");
  h.respond({ revision: 4, entries: [summary()], error: "Другой редактор сохранил новую версию" });
  assert.equal(h.input("apiKey").props.value, "fake-retry-key"); assert.ok(nodes(h.tree).some(node => node.props?.role === "alert"));
  assert.equal(h.commands.length, 2); h.click("Сохранить доступ"); assert.equal(h.commands.at(-1).expectedRevision, 4);
  assert.equal(h.commands.at(-1).access.values.apiKey, "fake-retry-key");
});

test("unrelated requests, projects, chats and lower revisions cannot acknowledge pending saves", () => {
  const h = harness({ chatId: "chat-one" }); h.respond({ revision: 3, entries: [summary()] }); h.click("Изменить Production"); h.edit("password", "fake-pending-secret"); h.click("Сохранить доступ");
  const request = h.commands.at(-1);
  for (const patch of [{ requestId: "other-request" }, { projectPath: "project-two" }, { chatId: "chat-two" }, { chatId: undefined }, { revision: 2 }]) {
    h.respond({ revision: 4, entries: [], ...patch });
    assert.equal(h.input("password").props.value, "fake-pending-secret"); assert.equal(h.button("Сохранить доступ").props.disabled, true);
  }
  h.respond({ revision: 4, entries: [summary()], requestId: request.requestId }); assert.equal(h.all("input").length, 0);
});

test("unsolicited snapshots keep the current draft and project changes clear it before reloading", () => {
  const h = harness(); h.respond({ revision: 1, entries: [summary()] }); h.click("Изменить Production"); h.edit("password", "fake-project-one-secret");
  h.respond({ requestId: "external", revision: 4, entries: [] }); assert.equal(h.input("password").props.value, "fake-project-one-secret");
  h.props.projectPath = "project-two"; h.render(); assert.equal(h.all("input").length, 0); assert.equal(h.commands.at(-1).type, "getProjectAccesses");
  assert.equal(h.commands.at(-1).projectPath, "project-two"); h.respond(); h.click("Добавить доступ"); assert.equal(h.input("password").props.value, "");
});

test("delete sends the exact card and revision once and recovers from an error", () => {
  const h = harness(); h.respond({ revision: 7, entries: [summary()] }); h.click("Удалить Production");
  assert.equal(h.commands.at(-1).type, "deleteProjectAccess"); assert.equal(h.commands.at(-1).id, "access-one"); assert.equal(h.commands.at(-1).expectedRevision, 7);
  assert.equal(h.button("Удалить Production").props.disabled, true);
  h.respond({ revision: 7, entries: [summary()], error: "Не удалось удалить" }); assert.ok(h.button("Удалить Production"));
  h.click("Удалить Production"); h.respond({ revision: 8 }); assert.ok(textOf(h.tree).includes("Доступов пока нет"));
});

test("load failure offers an explicit retry without a write", () => {
  const h = harness(); h.respond({ error: "Хранилище недоступно" }); assert.equal(h.button("Добавить доступ").props.disabled, true);
  h.click("Повторить загрузку"); assert.equal(h.commands.at(-1).type, "getProjectAccesses"); h.respond();
  assert.equal(h.button("Добавить доступ").props.disabled, false);
});

test("renaming a card with blank fields sends metadata only and clearing the last value requires a replacement", () => {
  const h = harness(); h.respond({ entries: [summary({ hasValues: { url: false, login: false, password: true, apiKey: false } })] });
  h.click("Изменить Production"); h.edit("name", "Renamed service"); h.click("Сохранить доступ");
  assert.deepEqual(h.commands.at(-1).access, { id: "access-one", name: "Renamed service", purpose: "Deploy the project" });
  h.respond({ revision: 1, entries: [summary({ hasValues: { url: false, login: false, password: true, apiKey: false } })] });
  h.click("Изменить Production"); h.click("Очистить сохранённое: Пароль"); assert.equal(h.button("Сохранить доступ").props.disabled, true);
  h.click("Не очищать: Пароль"); assert.equal(h.button("Сохранить доступ").props.disabled, false);
  h.click("Очистить сохранённое: Пароль"); h.edit("apiKey", "fake-replacement-key"); h.click("Сохранить доступ");
  assert.deepEqual(h.commands.at(-1).access.clearFields, ["password"]); assert.deepEqual(h.commands.at(-1).access.values, { apiKey: "fake-replacement-key" });
});

test("Escape only cancels this editor and repeated callbacks cannot submit duplicate requests", () => {
  const h = harness(); h.respond(); h.click("Добавить доступ"); h.edit("name", "Keyboard service"); h.edit("password", "fake-keyboard-password");
  let stopped = false; nodes(h.tree).find(node => node.props?.role === "group").props.onKeyDown({ key: "Escape", stopPropagation() { stopped = true; } }); h.render();
  assert.equal(stopped, true); assert.equal(h.all("input").length, 0); assert.equal(h.commands.length, 1);
  h.click("Добавить доступ"); h.edit("name", "One request"); h.edit("login", "test-user");
  const save = h.button("Сохранить доступ").props.onClick; save(); save(); h.render();
  assert.equal(h.commands.filter(message => message.type === "saveProjectAccess").length, 1);
});

test("a changing post callback cannot trigger metadata reloads or discard the current editor", () => {
  const h = harness(); h.respond(); h.click("Добавить доступ"); h.edit("name", "Draft service"); h.edit("password", "fake-local-only");
  h.props.onPost = message => h.commands.push(message); h.render();
  assert.equal(h.commands.length, 1); assert.equal(h.input("password").props.value, "fake-local-only");
  h.click("Сохранить доступ"); assert.equal(h.commands.length, 2);
});

for (const operation of ["save", "delete"]) test(`a matching revision-zero ${operation} storage error settles pending and retains the last valid metadata`, () => {
  const h = harness({ chatId: "chat-error-fixture" }); h.respond({ revision: 3, entries: [summary()] });
  const action = operation === "save" ? "Сохранить доступ" : "Удалить Production";
  if (operation === "save") { h.click("Изменить Production"); h.edit("password", "fake-preserved-on-storage-error"); }
  h.click(action); const pendingRequest = h.commands.at(-1);
  h.respond({ requestId: "unrelated-error", revision: 0, error: "Cannot read protected storage" });
  assert.equal(h.button(action).props.disabled, true, "another request's error cannot settle this operation");
  h.respond({ requestId: pendingRequest.requestId, revision: 0, entries: [], error: "Cannot read protected storage" });
  assert.equal(h.button(action).props.disabled, false, "a matching storage error must enable an explicit retry");
  assert.ok(h.button("Изменить Production"), "the last valid card metadata must remain visible");
  assert.ok(nodes(h.tree).some(node => node.props?.role === "alert" && textOf(node).includes("Cannot read protected storage")));
  if (operation === "save") {
    assert.equal(h.input("password").props.value, "fake-preserved-on-storage-error");
    assert.equal(h.button("Отмена доступа").props.disabled, false);
  }
  h.click(action); assert.equal(h.commands.at(-1).expectedRevision, 3);
});

for (const action of ["cancel", "escape", "save", "delete"]) test(`${action} restores focus after the add button is committed as enabled`, () => {
  const h = harness(); h.respond({ revision: 3, entries: [summary()] });
  if (action === "delete") {
    h.click("Удалить Production"); h.respond({ revision: 4, entries: [] });
  } else {
    h.click("Изменить Production"); assert.equal(h.focused, "name");
    if (action === "cancel") h.click("Отмена доступа");
    if (action === "escape") {
      nodes(h.tree).find(node => node.props?.role === "group").props.onKeyDown({ key: "Escape", stopPropagation() {} }); h.render();
    }
    if (action === "save") { h.click("Сохранить доступ"); h.respond({ revision: 4, entries: [summary()] }); }
  }
  assert.equal(h.button("Добавить доступ").props.disabled, false);
  assert.equal(h.focused, "Добавить доступ");
});
