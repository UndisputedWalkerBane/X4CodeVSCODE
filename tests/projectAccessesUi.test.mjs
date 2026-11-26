import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-access-ui-"));
const hookKey = Symbol.for("agent-hub-access-ui-hooks");
const originalGlobals = new Map(["window", "document"].map(key => [key, globalThis[key]]));
const origin = "https://webview.invalid";
globalThis.window = Object.assign(new EventTarget(), { origin });
globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
const hostMessage = (data, eventOrigin = origin) => window.dispatchEvent(new MessageEvent("message", { data, origin: eventOrigin }));
after(async () => {
  delete globalThis[hookKey];
  for (const [key, value] of originalGlobals) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  await rm(temp, { recursive: true, force: true });
});
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
const harnesses = [];
afterEach(() => { harnesses.splice(0).forEach(h => h.dispose()); document.visibilityState = "visible"; });
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
  const h = { commands: [], props: { projectPath: "project-one", snapshot: null, testResult: null, ...props }, tree: null, focused: null };
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
      element.value = node.props.value ?? "";
      element.validity ??= { badInput: false, valid: true };
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
  h.input = name => nodes(h.tree).find(node => ["input", "select"].includes(node.type) && node.props.name === name);
  h.edit = (name, value) => { const input = h.input(name); assert.ok(input, `missing ${name}`);
    if (input.props.ref?.current) { input.props.ref.current.value = value; input.props.ref.current.validity = { badInput: false, valid: true }; }
    input.props.onChange({ target: { value } }); h.render(); };
  h.respond = (patch = {}) => { const request = h.commands.at(-1); h.props.snapshot = { type: "projectAccesses", projectPath: h.props.projectPath, requestId: request.requestId, revision: 0, entries: [], ...(h.props.chatId ? { chatId: h.props.chatId } : {}), ...patch }; h.render(); };
  h.revealReply = (request, patch = {}, eventOrigin = origin) => {
    const data = { type: "projectAccessRevealed", projectPath: request.projectPath, chatId: h.props.chatId,
      requestId: request.requestId, revision: request.expectedRevision, id: request.id, ...patch };
    hostMessage(data, eventOrigin); h.render();
  };
  h.testRespond = (patch = {}) => { const request = h.commands.filter(command => command.type === "testProjectAccess").at(-1); assert.ok(request, "missing access test request");
    h.props.testResult = { type: "projectAccessTestResult", projectPath: request.projectPath, requestId: request.requestId, revision: request.expectedRevision,
      id: request.access.id, protocol: request.access.protocol, ok: true, message: "Fixture connection succeeded", ...(h.props.chatId ? { chatId: h.props.chatId } : {}), ...patch }; h.render(); };
  h.dispose = () => slots.forEach(slot => slot?.cleanup?.());
  harnesses.push(h); h.render(); return h;
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

const fixtureValues = { url: "https://service.invalid/fixture", login: "  Логин\nfixture  ", password: '<fixture>&"пароль"', apiKey: "fixture-" + "ABC".repeat(500) };
const twoEntries = [summary(), summary({ id: "access-two", name: "Staging", hasValues: { url: false, login: true, password: false, apiKey: false } })];

test("only the requested card shows exact saved values and Hide removes them from the rendered page", () => {
  const h = harness({ chatId: "access-chat" });
  h.respond({ revision: 7, entries: twoEntries });
  const button = h.button("Показать данные: Production");
  assert.ok(button);
  assert.equal(textOf(button), "Показать");
  assert.equal(button.props["aria-expanded"], false);
  assert.equal(h.commands.length, 1);
  h.click("Показать данные: Production");
  const request = h.commands.at(-1);
  assert.deepEqual(request, { type: "revealProjectAccess", projectPath: "project-one", id: "access-one", expectedRevision: 7, requestId: request.requestId, chatId: "access-chat" });
  assert.ok(request.requestId);
  for (const patch of [{ id: "access-two" }, { requestId: "wrong" }, { projectPath: "other" }, { chatId: "other" }, { chatId: undefined }, { revision: 6 }]) {
    h.revealReply(request, { values: fixtureValues, ...patch });
    assert.ok(!textOf(h.tree).includes(fixtureValues.password));
  }
  h.revealReply(request, { values: fixtureValues }, "https://unrelated.invalid");
  assert.ok(!textOf(h.tree).includes(fixtureValues.password));
  h.revealReply(request, { values: fixtureValues });
  const hide = h.button("Скрыть данные: Production");
  assert.equal(textOf(hide), "Скрыть");
  assert.equal(hide.props["aria-expanded"], true);
  assert.ok(h.all("dl").some(node => node.props.id === hide.props["aria-controls"]));
  for (const value of Object.values(fixtureValues)) {
    assert.ok(nodes(h.all("article")[0]).some(node => node.type === "dd" && textOf(node) === value));
    assert.ok(!textOf(h.all("article")[1]).includes(value));
  }
  h.click("Скрыть данные: Production");
  h.revealReply(request, { values: fixtureValues });
  assert.equal(h.commands.length, 2);
  for (const value of Object.values(fixtureValues)) assert.ok(!textOf(h.tree).includes(value));
});

test("switching cards or hiding a pending request prevents older responses from showing values", () => {
  const h = harness(); h.respond({ revision: 3, entries: twoEntries });
  h.click("Показать данные: Production"); const first = h.commands.at(-1);
  h.click("Показать данные: Staging"); const second = h.commands.at(-1);
  h.revealReply(first, { values: fixtureValues });
  assert.ok(!textOf(h.tree).includes(fixtureValues.login));
  h.revealReply(second, { values: { login: fixtureValues.login } });
  assert.ok(textOf(h.all("article")[1]).includes(fixtureValues.login));
  assert.ok(textOf(h.all("article")[1]).includes("не задано"));
  h.click("Показать данные: Production"); const third = h.commands.at(-1);
  assert.ok(!textOf(h.tree).includes(fixtureValues.login));
  h.click("Скрыть данные: Production");
  h.revealReply(third, { values: fixtureValues });
  assert.ok(!textOf(h.tree).includes(fixtureValues.login));
});

for (const transition of ["edit", "project", "chat", "revision", "hidden"]) {
  test(`a ${transition} change masks the current card and invalidates its reveal request`, () => {
    const h = harness(); h.respond({ revision: 3, entries: twoEntries });
    h.click("Показать данные: Production"); const old = h.commands.at(-1);
    h.revealReply(old, { values: fixtureValues });
    assert.ok(textOf(h.tree).includes(fixtureValues.password));
    if (transition === "edit") h.click("Изменить Production");
    if (transition === "project") { h.props.projectPath = "project-two"; h.render(); }
    if (transition === "chat") { h.props.chatId = "new-chat"; h.render(); }
    if (transition === "revision") h.respond({ requestId: "another-editor", revision: 4, entries: twoEntries });
    if (transition === "hidden") { document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange")); h.render(); }
    h.revealReply(old, { chatId: undefined, values: fixtureValues });
    assert.ok(!textOf(h.tree).includes(fixtureValues.password));
    if (transition === "edit") assert.equal(h.input("password").props.value, "");
  });
}

test("a reveal response that arrives while the webview is hidden stays masked when the view is reopened", () => {
  const h = harness(); h.respond({ revision: 3, entries: twoEntries });
  h.click("Показать данные: Production"); const request = h.commands.at(-1);
  document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange")); h.render();
  h.revealReply(request, { values: fixtureValues });
  document.visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange")); h.render();
  assert.ok(h.button("Показать данные: Production"));
  assert.ok(!textOf(h.tree).includes(fixtureValues.password));
});

test("a newer project broadcast masks sibling chat tiles, ignores other projects and keeps draft values", () => {
  const first = harness({ chatId: "first" }), sibling = harness({ chatId: "sibling" });
  const other = harness({ chatId: "other", projectPath: "other-project" }), editor = harness({ chatId: "editor" });
  const tiles = [first, sibling, other, editor];
  for (const h of tiles) h.respond({ revision: 3, entries: twoEntries });
  for (const h of [first, sibling, other]) h.click("Показать данные: Production");
  const pending = sibling.commands.at(-1);
  for (const h of [first, other]) h.revealReply(h.commands.at(-1), { values: fixtureValues });
  editor.click("Изменить Production"); editor.edit("password", "draft-fixture");
  const changed = { type: "projectAccessRevisionChanged", projectPath: first.props.projectPath, revision: 4 };
  for (const [data, eventOrigin] of [[changed, "https://other.invalid"], [{ ...changed, revision: 3 }, origin]]) {
    hostMessage(data, eventOrigin); first.render();
    assert.ok(textOf(first.tree).includes(fixtureValues.password));
  }
  hostMessage(changed); tiles.forEach(h => h.render());
  sibling.revealReply(pending, { values: fixtureValues });
  assert.ok(!textOf(first.tree).includes(fixtureValues.password)); assert.ok(first.button("Показать данные: Production"));
  assert.ok(!textOf(sibling.tree).includes(fixtureValues.password)); assert.ok(sibling.button("Показать данные: Production"));
  assert.ok(textOf(other.tree).includes(fixtureValues.password));
  assert.equal(editor.input("password").props.value, "draft-fixture");
  for (const h of tiles) assert.equal(h.commands.filter(message => message.type === "revealProjectAccess").length, h === editor ? 0 : 1);
  for (const h of [other, editor]) assert.equal(h.commands.filter(message => message.type === "getProjectAccesses").length, 1);
  editor.click("Сохранить доступ"); assert.equal(editor.commands.at(-1).expectedRevision, 3);
});

test("the first Show after sibling saves uses fresh card metadata, including a second change during refresh", () => {
  const h = harness({ chatId: "idle-tile" }); h.respond({ revision: 3, entries: twoEntries });
  const announce = revision => { hostMessage({ type: "projectAccessRevisionChanged", projectPath: h.props.projectPath, revision }); h.render(); };
  announce(4);
  assert.deepEqual(h.commands.map(command => command.type), ["getProjectAccesses", "getProjectAccesses"]);
  announce(5);
  assert.equal(h.commands.length, 2);
  h.respond({ revision: 4, entries: twoEntries });
  assert.equal(h.commands.length, 3);
  assert.equal(h.commands.at(-1).type, "getProjectAccesses");
  h.respond({ revision: 5, entries: [summary({ name: "Renamed service" })] });
  assert.equal(h.button("Показать данные: Production"), undefined);
  h.click("Показать данные: Renamed service");
  const request = h.commands.at(-1);
  assert.equal(request.type, "revealProjectAccess"); assert.equal(request.expectedRevision, 5);
  h.revealReply(request, { values: fixtureValues });
  assert.ok(textOf(h.tree).includes(fixtureValues.password));
  assert.equal(h.commands.filter(message => message.type === "revealProjectAccess").length, 1);
});

for (const completed of [false, true]) test(`a native surface hide clears a ${completed ? "completed" : "pending"} reveal while the DOM still reports visible`, () => {
  const h = harness({ chatId: "retained" }); h.respond({ revision: 3, entries: twoEntries });
  h.click("Показать данные: Production"); const request = h.commands.at(-1);
  if (completed) h.revealReply(request, { values: fixtureValues });
  hostMessage({ type: "hideProjectAccessValues" }, "https://unrelated.invalid"); h.render();
  assert.ok(h.button("Скрыть данные: Production"));
  hostMessage({ type: "hideProjectAccessValues" }); h.render();
  h.revealReply(request, { values: fixtureValues });
  assert.equal(document.visibilityState, "visible"); assert.ok(h.button("Показать данные: Production"));
  assert.ok(!textOf(h.tree).includes(fixtureValues.password)); assert.equal(h.commands.length, 2);
});

for (const completed of [false, true]) test(`covering a tile with the board archive clears its ${completed ? "displayed" : "pending"} reveal and keeps its editor mounted`, () => {
  const h = harness(); h.respond({ revision: 3, entries: twoEntries });
  h.click("Показать данные: Production"); const request = h.commands.at(-1);
  if (completed) h.revealReply(request, { values: fixtureValues });
  h.props.visible = false; h.render();
  h.revealReply(request, { values: fixtureValues });
  h.props.visible = true; h.render();
  assert.ok(h.button("Показать данные: Production")); assert.ok(!textOf(h.tree).includes(fixtureValues.password));
  h.click("Изменить Production"); h.edit("password", "fixture-board-draft");
  h.props.visible = false; h.render(); h.props.visible = true; h.render();
  assert.equal(h.input("password").props.value, "fixture-board-draft");
  assert.equal(h.commands.length, 2);
});

test("a reveal storage error and a revision conflict both allow explicit retry", () => {
  const h = harness(); h.respond({ revision: 3, entries: twoEntries });
  h.click("Показать данные: Production");
  h.revealReply(h.commands.at(-1), { revision: 0, error: "Fixture storage unavailable" });
  assert.ok(nodes(h.tree).some(node => node.props.role === "alert" && textOf(node).includes("Fixture storage unavailable")));
  h.click("Показать данные: Production");
  h.revealReply(h.commands.at(-1), { revision: 4, error: "Fixture revision conflict" });
  assert.equal(h.commands.at(-1).type, "getProjectAccesses");
  h.respond({ revision: 4, entries: twoEntries });
  h.click("Показать данные: Production");
  assert.equal(h.commands.at(-1).expectedRevision, 4);
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

test("card repository and connection metadata are editable public fields and survive saving", () => {
  const h = harness(); h.respond({ revision: 3, entries: [summary({ protocol: "sftp", port: 2222, repository: "https://github.com/example/server" })] });
  const link = h.all("a").find(node => node.props.href === "https://github.com/example/server"); assert.ok(link); assert.ok(link.props.rel.includes("noopener"));
  assert.ok(textOf(h.tree).includes("SFTP")); assert.ok(textOf(h.tree).includes("2222"));
  h.click("Изменить Production"); assert.equal(h.input("protocol").props.value, "sftp"); assert.equal(h.input("port").props.value, "2222");
  assert.equal(h.input("repository").props.value, "https://github.com/example/server");
  h.edit("protocol", "ftp"); h.edit("port", "2121"); h.edit("repository", "git@example.invalid:team/code.git"); h.click("Сохранить доступ");
  assert.deepEqual(h.commands.at(-1).access, { id: "access-one", name: "Production", purpose: "Deploy the project", protocol: "ftp", port: 2121, repository: "git@example.invalid:team/code.git" });
});

test("legacy cards display SSH defaults, blank public metadata clears, and unsafe repository schemes never become links", () => {
  const h = harness(); h.respond({ entries: [summary({ repository: "javascript:alert(1)" })] });
  assert.equal(h.all("a").length, 0); h.click("Изменить Production"); assert.equal(h.input("protocol").props.value, "ssh");
  assert.equal(h.input("port").props.value, ""); assert.ok(h.input("port").props.placeholder.includes("SSH"));
  h.edit("repository", ""); h.click("Сохранить доступ"); assert.equal(h.commands.at(-1).access.repository, undefined); assert.equal(h.commands.at(-1).access.port, undefined);
});

test("invalid ports visibly block Save and Check without falling back to a default port", () => {
  const h = harness(); h.respond({ entries: [summary()] }); h.click("Изменить Production");
  for (const port of ["0", "-1", "65536", "NaN", "2.5"]) {
    h.edit("port", port); assert.equal(h.button("Сохранить доступ").props.disabled, true); assert.equal(h.button("Проверить текущие поля").props.disabled, true);
    assert.ok(nodes(h.tree).some(node => node.props?.role === "alert" && textOf(node).includes("Порт")));
  }
  h.input("port").props.onChange({ target: { value: "", validity: { badInput: true } } }); h.render();
  assert.equal(h.button("Сохранить доступ").props.disabled, true, "a browser-sanitized invalid number is not an intentional blank port");
  h.edit("port", ""); h.edit("protocol", "ftp"); assert.equal(h.input("port").props.placeholder, "21");
  assert.equal(h.button("Сохранить доступ").props.disabled, false);
});

test("saved-card checking sends only card identity and connection metadata and never saves", () => {
  const h = harness(); h.respond({ revision: 3, entries: [summary({ protocol: "sftp", port: 2222, repository: "https://github.com/example/server" })] });
  h.click("Проверить доступ Production"); const request = h.commands.at(-1);
  assert.equal(request.type, "testProjectAccess"); assert.equal(request.expectedRevision, 3);
  assert.deepEqual(request.access, { id: "access-one", protocol: "sftp", port: 2222 });
  assert.equal(h.button("Проверить доступ Production").props.disabled, true); assert.equal(h.commands.some(command => command.type === "saveProjectAccess"), false);
  h.testRespond(); assert.ok(textOf(h.tree).includes("Fixture connection succeeded")); assert.equal(h.all("input").length, 0);
});

test("a nameless new draft can check its current SSH fields without API key, repository or saving", () => {
  const h = harness(); h.respond(); h.click("Добавить доступ");
  h.edit("url", "fixture-alias"); assert.equal(h.button("Проверить текущие поля").props.disabled, true, "login must be explicit");
  h.edit("login", "fixture-login"); h.edit("password", "fake-test-password"); h.edit("apiKey", "fake-excluded-api-key"); h.edit("repository", "https://github.com/example/server");
  h.click("Проверить текущие поля"); const request = h.commands.at(-1);
  assert.deepEqual(request.access, { protocol: "ssh", values: { url: "fixture-alias", login: "fixture-login", password: "fake-test-password" } });
  assert.equal(h.input("password").props.disabled, false); assert.equal(h.button("Отмена доступа").props.disabled, false);
  h.testRespond(); assert.equal(h.input("password").props.value, "fake-test-password"); assert.equal(h.commands.some(command => command.type === "saveProjectAccess"), false);
  h.edit("name", "New server"); h.click("Сохранить доступ"); assert.equal(h.commands.at(-1).type, "saveProjectAccess");
});

test("editing a saved card checks blank-preserved credentials and explicit clears from that exact card", () => {
  const h = harness(); h.respond({ revision: 3, entries: [summary()] }); h.click("Изменить Production"); h.edit("protocol", "ftp");
  h.click("Очистить сохранённое: Пароль"); h.click("Очистить сохранённое: API-ключ"); h.edit("login", "replacement-login");
  h.click("Проверить текущие поля"); assert.deepEqual(h.commands.at(-1).access, { id: "access-one", protocol: "ftp", values: { login: "replacement-login" }, clearFields: ["password"] });
});

test("connection changes permanently invalidate a pending result even when edited values are reverted", () => {
  const h = harness(); h.respond({ revision: 3, entries: [summary()] }); h.click("Изменить Production"); h.edit("login", "first-login"); h.click("Проверить текущие поля");
  const duplicate = h.button("Проверить текущие поля").props.onClick; duplicate(); assert.equal(h.commands.filter(command => command.type === "testProjectAccess").length, 1);
  h.edit("login", "different-login"); h.edit("login", "first-login"); h.testRespond();
  assert.equal(textOf(h.tree).includes("Fixture connection succeeded"), false); assert.equal(h.button("Проверить текущие поля").props.disabled, false);
  h.click("Проверить текущие поля"); h.testRespond(); assert.ok(textOf(h.tree).includes("Fixture connection succeeded"));
  h.edit("password", "changed-password"); assert.equal(textOf(h.tree).includes("Fixture connection succeeded"), false);
});

test("probe responses require matching project, chat, request, card, protocol and successful revision", () => {
  const h = harness({ chatId: "chat-probe" }); h.respond({ revision: 3, entries: [summary()] }); h.click("Проверить доступ Production");
  for (const patch of [{ projectPath: "project-other" }, { chatId: "other-chat" }, { chatId: undefined }, { requestId: "other-request" }, { id: "other-card" }, { protocol: "ftp" }, { revision: 2 }, { revision: 4 }]) {
    h.testRespond(patch); assert.equal(textOf(h.tree).includes("Fixture connection succeeded"), false); assert.equal(h.button("Проверить доступ Production").props.disabled, true);
  }
  h.testRespond({ revision: 0, ok: false, message: "Protected storage unavailable" });
  assert.equal(h.button("Проверить доступ Production").props.disabled, false); assert.ok(nodes(h.tree).some(node => node.props?.role === "alert" && textOf(node).includes("Protected storage unavailable")));
  h.click("Проверить доступ Production"); assert.equal(h.commands.at(-1).expectedRevision, 3);
});

test("Cancel and project changes discard probe results without discarding a later editor", () => {
  const h = harness(); h.respond({ revision: 3, entries: [summary()] }); h.click("Изменить Production"); h.click("Проверить текущие поля");
  h.click("Отмена доступа"); h.click("Изменить Production"); h.testRespond(); assert.equal(textOf(h.tree).includes("Fixture connection succeeded"), false);
  h.click("Проверить текущие поля"); const oldRequest = h.commands.at(-1); h.props.projectPath = "project-two"; h.render();
  h.respond({ entries: [summary({ id: "different-access" })] }); h.props.testResult = { type: "projectAccessTestResult", projectPath: "project-one", requestId: oldRequest.requestId, revision: 3, id: oldRequest.access.id, protocol: "ssh", ok: true, message: "Wrong old result" }; h.render();
  assert.equal(textOf(h.tree).includes("Wrong old result"), false);
});

test("a local watchdog settles an unanswered check and ignores its later success", t => {
  let expire;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => { assert.equal(delay, 17000); expire = callback; return 42; });
  t.mock.method(globalThis, "clearTimeout", () => {});
  const h = harness(); h.respond({ revision: 3, entries: [summary()] }); h.click("Проверить доступ Production"); assert.equal(typeof expire, "function");
  expire(); h.render(); assert.equal(h.button("Проверить доступ Production").props.disabled, false);
  assert.ok(nodes(h.tree).some(node => node.props?.role === "alert" && textOf(node).includes("не завершилась вовремя")));
  h.testRespond(); assert.equal(textOf(h.tree).includes("Fixture connection succeeded"), false);
});

for (const completed of [false, true]) test(`a newer unsolicited revision invalidates ${completed ? "completed" : "pending"} probe proof while keeping the current metadata and draft`, () => {
  const h = harness({ chatId: "chat-revision-fixture" }); h.respond({ revision: 3, entries: [summary()] });
  h.click("Изменить Production"); h.edit("password", "fake-draft-to-keep"); h.click("Проверить текущие поля");
  if (completed) h.testRespond();
  h.respond({ requestId: "another-editors-request", revision: 4, entries: [] });
  assert.equal(textOf(h.tree).includes("Fixture connection succeeded"), false);
  assert.equal(h.input("password").props.value, "fake-draft-to-keep"); assert.ok(h.button("Изменить Production"));
  h.testRespond(); assert.equal(textOf(h.tree).includes("Fixture connection succeeded"), false);
  h.click("Сохранить доступ"); assert.equal(h.commands.at(-1).expectedRevision, 3, "unknown responses cannot replace the last acknowledged metadata revision");
});

for (const key of ["-", "e"]) test(`native input for '${key}' invalidates a blank-port success even when React onChange is suppressed`, () => {
  const h = harness(); h.respond({ revision: 3, entries: [summary({ protocol: "sftp" })] }); h.click("Изменить Production");
  h.click("Проверить текущие поля"); h.testRespond(); assert.ok(textOf(h.tree).includes("Fixture connection succeeded"));
  const port = h.input("port"); assert.equal(port.props.value, ""); assert.equal(typeof port.props.onInput, "function", "port must observe native input independently of React's value-change tracking");
  const nativePort = { value: "", validity: { badInput: true, valid: false } };
  port.props.onInput({ currentTarget: nativePort, target: nativePort }); h.render();
  assert.equal(h.input("port").props["aria-invalid"], true); assert.equal(h.button("Сохранить доступ").props.disabled, true); assert.equal(h.button("Проверить текущие поля").props.disabled, true);
  assert.equal(textOf(h.tree).includes("Fixture connection succeeded"), false);
  nativePort.validity = { badInput: false, valid: true };
  h.input("port").props.onInput({ currentTarget: nativePort, target: nativePort }); h.render();
  assert.equal(h.input("port").props["aria-invalid"], false); assert.equal(h.button("Сохранить доступ").props.disabled, false); assert.equal(h.button("Проверить текущие поля").props.disabled, false);
  assert.equal(textOf(h.tree).includes("Fixture connection succeeded"), false, "clearing invalid text cannot resurrect old proof");
});

for (const action of ["Сохранить доступ", "Проверить текущие поля"]) test(`${action} guards native port validity even if an input event was missed`, () => {
  const h = harness(); h.respond({ revision: 3, entries: [summary()] }); h.click("Изменить Production"); h.click("Проверить текущие поля"); h.testRespond();
  const port = h.input("port"); assert.ok(port.props.ref?.current, "native port validity needs a live element reference");
  port.props.ref.current.value = ""; port.props.ref.current.validity = { badInput: true, valid: false };
  const count = h.commands.length; h.button(action).props.onClick(); h.render();
  assert.equal(h.commands.length, count, "invalid native input must never send a request");
  assert.equal(h.input("port").props["aria-invalid"], true); assert.equal(textOf(h.tree).includes("Fixture connection succeeded"), false);
});

test("a newer-revision probe failure refreshes metadata without saving, rechecking or losing draft fields", () => {
  const h = harness({ chatId: "refresh-chat" }); h.respond({ revision: 3, entries: [summary()] }); h.click("Изменить Production");
  h.edit("url", "draft-alias"); h.edit("login", "draft-login"); h.edit("password", "fake-refresh-password"); h.edit("repository", "git@example.invalid:team/draft.git");
  h.click("Проверить текущие поля"); h.testRespond({ ok: false, revision: 4, message: "Card changed in another editor" });
  const refresh = h.commands.at(-1); assert.equal(refresh.type, "getProjectAccesses", "newer revision requires actual metadata before retrying");
  assert.equal(h.button("Проверить текущие поля").props.disabled, true);
  for (const patch of [{ requestId: "another-read" }, { projectPath: "another-project" }, { chatId: "another-chat" }]) {
    h.respond({ revision: 4, entries: [summary({ protocol: "ftp" })], ...patch }); assert.equal(h.button("Проверить текущие поля").props.disabled, true);
  }
  h.respond({ requestId: refresh.requestId, revision: 4, entries: [summary({ protocol: "ftp", repository: "https://github.com/example/new" })] });
  for (const [name, value] of Object.entries({ url: "draft-alias", login: "draft-login", password: "fake-refresh-password", repository: "git@example.invalid:team/draft.git" })) assert.equal(h.input(name).props.value, value);
  assert.equal(h.commands.filter(command => command.type === "testProjectAccess").length, 1); assert.equal(h.commands.some(command => command.type === "saveProjectAccess"), false);
  h.click("Проверить текущие поля"); assert.equal(h.commands.at(-1).expectedRevision, 4);
});

test("failed conflict metadata refresh preserves the editor and offers explicit read retry", () => {
  const h = harness(); h.respond({ revision: 3, entries: [summary()] }); h.click("Изменить Production"); h.edit("password", "fake-retry-read-password");
  h.click("Проверить текущие поля"); h.testRespond({ ok: false, revision: 4, message: "Newer version exists" });
  assert.equal(h.commands.at(-1).type, "getProjectAccesses"); h.respond({ revision: 0, entries: [], error: "Cannot refresh protected storage" });
  assert.equal(h.input("password").props.value, "fake-retry-read-password"); assert.equal(h.button("Проверить текущие поля").props.disabled, true);
  assert.equal(h.button("Отмена доступа").props.disabled, false); h.click("Повторить загрузку"); assert.equal(h.commands.at(-1).type, "getProjectAccesses");
  h.respond({ revision: 4, entries: [summary()] }); assert.equal(h.input("password").props.value, "fake-retry-read-password");
  h.click("Проверить текущие поля"); assert.equal(h.commands.at(-1).expectedRevision, 4);
});

test("failed metadata refresh remains retryable after Cancel and opening another editor clear the error", () => {
  const h = harness(); h.respond({ revision: 3, entries: [summary()] }); h.click("Изменить Production"); h.click("Проверить текущие поля");
  h.testRespond({ ok: false, revision: 4, message: "Newer version exists" }); h.respond({ revision: 0, entries: [], error: "Refresh unavailable" });
  h.click("Отмена доступа"); assert.ok(h.button("Повторить загрузку"), "Cancel must not hide the required metadata recovery action");
  h.click("Изменить Production"); assert.ok(h.button("Повторить загрузку"), "opening an editor must keep metadata recovery available");
  h.click("Повторить загрузку"); h.respond({ revision: 4, entries: [summary()] });
  h.click("Проверить текущие поля"); assert.equal(h.commands.at(-1).expectedRevision, 4);
});

test("successful matched CRUD metadata clears a failed refresh requirement after an explicit save conflict retry", () => {
  const h = harness(); h.respond({ revision: 3, entries: [summary()] }); h.click("Изменить Production"); h.edit("password", "fake-save-recovery-password");
  h.click("Проверить текущие поля"); h.testRespond({ ok: false, revision: 4, message: "Newer version exists" });
  h.respond({ revision: 0, entries: [], error: "Refresh unavailable" }); h.click("Сохранить доступ");
  h.respond({ revision: 4, entries: [summary()], error: "Save conflict" }); assert.equal(h.input("password").props.value, "fake-save-recovery-password");
  h.click("Сохранить доступ"); assert.equal(h.commands.at(-1).expectedRevision, 4); h.respond({ revision: 5, entries: [summary()] });
  assert.equal(h.all("input").length, 0); assert.equal(h.button("Проверить доступ Production").props.disabled, false);
  assert.equal(h.button("Повторить загрузку"), undefined); h.click("Проверить доступ Production"); assert.equal(h.commands.at(-1).expectedRevision, 5);
});
