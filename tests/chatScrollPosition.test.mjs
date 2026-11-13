import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-chat-scroll-"));
const hookKey = Symbol.for("agent-hub-chat-scroll-hooks");
const globals = ["window", "localStorage", "acquireVsCodeApi", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"];
const originalGlobals = new Map(globals.map(key => [key, globalThis[key]]));
let listeners = new Set(), commands = [], frames = new Map(), observers = new Set(), nextFrame = 0;
globalThis.window = { addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn), innerHeight: 800 };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.acquireVsCodeApi = () => ({ postMessage: message => commands.push(message) });
globalThis.requestAnimationFrame = fn => { frames.set(++nextFrame, fn); return nextFrame; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; this.targets = new Set(); observers.add(this); }
  observe(target) { this.targets.add(target); }
  disconnect() { observers.delete(this); this.targets.clear(); }
};
after(async () => {
  for (const [key, value] of originalGlobals) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  delete globalThis[hookKey]; await rm(temp, { recursive: true, force: true });
});
const outfile = join(temp, "app.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../webview/App.tsx", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "controlled-chat-scroll-react-host", setup(b) {
    b.onResolve({ filter: /^(react(?:\/jsx-runtime)?|react-markdown|remark-gfm)$/ }, ({ path }) => ({ path, namespace: "ui" }));
    b.onLoad({ filter: /.*/, namespace: "ui" }, ({ path }) => {
      if (path.endsWith("jsx-runtime")) return { contents: 'export const Fragment="fragment";export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;' };
      if (path === "react") return { contents: 'const h=()=>globalThis[Symbol.for("agent-hub-chat-scroll-hooks")];export const useState=(v)=>h().state(v);export const useRef=(v)=>h().ref(v);export const useEffect=(f,d)=>h().effect(f,d);export const useMemo=(f,d)=>h().memo(f,d);export const useCallback=(f,d)=>h().memo(()=>f,d);export const useId=()=>h().ref("scroll-id").current;' };
      return { contents: 'export default function Stub(){return null;}' };
    });
  } }],
});
const { App } = await import(pathToFileURL(outfile));
const ChatTile = App().type;
const project = { id: "project-one", name: "One", path: "/fixture/shared" };
const secondProject = { id: "project-two", name: "Two", path: "/fixture/shared" };
const textOf = node => node == null || typeof node === "boolean" ? "" : Array.isArray(node) ? node.map(textOf).join("") : typeof node === "object" ? textOf(node.props?.children) : String(node);
function nodes(node, path = "root") {
  return Array.isArray(node) ? node.flatMap((child, i) => nodes(child, `${path}.${i}`))
    : node && typeof node === "object" ? [{ node, path }, ...nodes(node.props?.children, `${path}.children`)] : [];
}
const harnesses = [];
afterEach(() => { harnesses.splice(0).forEach(h => h.dispose()); listeners.clear(); commands = []; frames.clear(); observers.clear(); });

function harness(props = {}) {
  const slots = []; let cursor = 0, dirty = false, effects = [], cleanups = [], committed = new Map();
  const h = { tree: null, feed: null, height: 3000, nextMountHeight: null };
  const hooks = {
    state(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], value => { const next = typeof value === "function" ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    ref(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    memo(fn, deps) { const i = cursor++, prev = slots[i]; if (!prev || deps.some((value, j) => !Object.is(value, prev.deps[j]))) slots[i] = { deps, value: fn() }; return slots[i].value; },
    effect(fn, deps) { const i = cursor++, prev = slots[i]; if (!prev || !deps || deps.some((value, j) => !Object.is(value, prev.deps?.[j]))) {
      if (prev?.cleanup) cleanups.push(prev.cleanup); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = fn(); }); } },
  };
  const setRef = (ref, element) => { if (typeof ref === "function") ref(element); else if (ref) ref.current = element; };
  function elementFor(node) {
    if (node.type !== "main") return { style: {}, scrollHeight: 30, focus() {} };
    const element = {
      clientHeight: 400, scrollHeight: h.nextMountHeight ?? h.height, top: 0, style: {}, isConnected: true,
      children: [{ fixtureContent: true }], scrollCalls: [],
      get scrollTop() { return this.top; },
      set scrollTop(value) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
      scrollTo(options) { this.scrollCalls.push(options); this.scrollTop = options.top; },
      addEventListener() {}, removeEventListener() {},
    };
    h.nextMountHeight = null;
    return element;
  }
  function commitRefs() {
    const next = new Map(); h.feed = null;
    for (const { node, path } of nodes(h.tree)) {
      if (!node.props?.ref) continue;
      const previous = committed.get(path);
      const element = previous?.type === node.type ? previous.element : elementFor(node);
      next.set(path, { type: node.type, ref: node.props.ref, element });
      if (node.type === "main" && node.props.onScroll) { h.feed = element; element.onScroll = node.props.onScroll; }
    }
    // React detaches refs for replaced nodes/callbacks before attaching the next tree.
    for (const [path, previous] of committed) {
      const current = next.get(path);
      if (!current || current.ref !== previous.ref || current.element !== previous.element) setRef(previous.ref, null);
      if (!current || current.element !== previous.element) previous.element.isConnected = false;
    }
    for (const [path, current] of next) {
      const previous = committed.get(path);
      if (!previous || previous.ref !== current.ref || previous.element !== current.element) setRef(current.ref, current.element);
    }
    committed = next;
  }
  h.render = () => { for (let n = 0; n < 30; n++) {
    globalThis[hookKey] = hooks; cursor = 0; dirty = false; effects = []; cleanups = [];
    h.tree = ChatTile(props); commitRefs();
    if (h.beforeEffects) { const callback = h.beforeEffects; h.beforeEffects = null; callback(); }
    cleanups.forEach(fn => fn()); effects.forEach(fn => fn());
    if (!dirty) return;
  } assert.fail("render did not settle"); };
  h.flush = () => { for (let n = 0; n < 3; n++) { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(n * 16)); h.render(); } };
  h.deliver = message => { [...listeners].forEach(fn => fn({ data: message })); h.render(); };
  h.event = message => h.deliver({ path: project.id, ...(props.chatId ? { chatId: props.chatId } : {}), ...message });
  h.click = label => { const button = nodes(h.tree).map(({ node }) => node).find(node => node.type === "button" && textOf(node).trim() === label);
    assert.ok(button, `missing ${label}`); assert.equal(!!button.props.disabled, false); button.props.onClick(); h.render(); };
  h.scroll = top => { assert.ok(h.feed); h.feed.scrollTop = top; h.feed.onScroll({ currentTarget: h.feed }); h.render(); };
  h.layout = height => {
    h.height = height; if (!h.feed) return;
    h.feed.scrollHeight = height; h.feed.scrollTop = h.feed.scrollTop;
    for (const observer of [...observers]) observer.callback([...observer.targets].map(target => ({ target })));
    h.flush();
  };
  h.transcript = (recordId = "record-one", path = project.id) => h.event({ type: "transcript", path, recordId,
    items: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, role: "assistant", text: `Message ${i} 🧪`, ts: i + 1 })) });
  h.dispose = () => { for (const { ref } of committed.values()) setRef(ref, null); committed.clear(); slots.forEach(slot => slot?.cleanup?.()); };
  harnesses.push(h); h.render();
  h.event({ type: "projects", projects: [project, secondProject], activePath: props.initialProjectPath ?? project.id });
  h.event({ type: "agentInfo", agent: "codex", recordId: props.initialRecordId ?? "record-one" });
  h.transcript(props.initialRecordId ?? "record-one"); h.flush();
  return h;
}

for (const menu of ["settings", "archive", "projects"]) test(`${menu} roundtrip restores the exact reading position after delayed layout`, () => {
  const h = harness(); h.scroll(1234.5); const oldFeed = h.feed;
  h.click(menu === "settings" ? "⚙" : menu === "archive" ? "📦 Архив" : "🗂 Проекты");
  if (menu === "projects") h.event({ type: "openSettingsScreen" });
  assert.equal(h.feed, null, "the menu replaces the chat feed");
  h.nextMountHeight = 400; h.click("← Назад"); h.flush();
  assert.notEqual(h.feed, oldFeed, "returning mounts a new DOM scroll container");
  h.feed.onScroll({ currentTarget: h.feed }); h.render();
  h.layout(3500);
  assert.equal(h.feed.scrollTop, 1234.5);
});

test("a deliberate scroll while delayed content is loading replaces the pending restore target", () => {
  const h = harness(); h.scroll(1450); h.click("⚙");
  h.nextMountHeight = 1000; h.click("← Назад"); h.flush();
  assert.equal(h.feed.scrollTop, 600, "the old offset is initially clamped by the short layout");
  h.scroll(120); h.layout(3500);
  assert.equal(h.feed.scrollTop, 120, "late layout must honor the reader's newer scroll");
});

test("the top of a conversation is a saved reading position rather than an unset position", () => {
  const h = harness(); h.scroll(0); h.click("📦 Архив"); h.click("← Назад"); h.flush();
  h.height = 3800; h.event({ type: "assistantText", text: "New content below the reader" }); h.layout(3800);
  assert.equal(h.feed.scrollTop, 0);
});

test("incoming messages retain an older reading position and bottom-follow resumes after returning to the bottom", () => {
  const h = harness(); h.scroll(842); h.height = 3500;
  h.event({ type: "assistantText", text: "A new live response" }); h.layout(3500);
  assert.equal(h.feed.scrollTop, 842);
  h.scroll(3100); h.height = 4000;
  h.event({ type: "textDelta", text: "Continuing the response" }); h.layout(4000);
  assert.equal(h.feed.scrollTop, 3600);
});

test("the jump-to-latest action explicitly resumes bottom-following", () => {
  const h = harness(); h.scroll(842); h.click("⇣");
  assert.equal(h.feed.scrollTop, 2600);
  h.height = 4200; h.event({ type: "assistantText", text: "Latest after explicitly returning" }); h.layout(4200);
  assert.equal(h.feed.scrollTop, 3800);
});

test("jump-to-latest reaches the bottom before streaming content can interrupt it", () => {
  const h = harness(); h.scroll(842);
  const feed = h.feed;
  // A browser emits intermediate scroll events during smooth scrolling.
  feed.scrollTo = options => {
    feed.scrollTop = options.behavior === "smooth" ? feed.scrollTop + 38 : options.top;
    feed.onScroll({ currentTarget: feed });
  };
  h.click("⇣");
  assert.equal(feed.scrollTop, 2600);
  h.height = 4200; h.event({ type: "assistantText", text: "Streaming immediately after the jump" }); h.layout(4200);
  assert.equal(feed.scrollTop, 3800);
});

test("a delayed programmatic scroll event after new layout preserves bottom-follow intent", () => {
  const h = harness(); h.scroll(842); h.click("⇣");
  const feed = h.feed;
  h.height = 4200;
  h.beforeEffects = () => {
    feed.scrollHeight = 4200;
    feed.onScroll({ currentTarget: feed });
  };
  h.event({ type: "assistantText", text: "New layout before the old scroll event is delivered" });
  h.layout(4200);
  assert.equal(feed.scrollTop, 3800);
  h.height = 4700; h.event({ type: "assistantText", text: "Still following the next response" }); h.layout(4700);
  assert.equal(feed.scrollTop, 4300);
});

test("a reader at the bottom follows messages received while a menu is open", () => {
  const h = harness(); h.scroll(2600); h.click("⚙");
  h.height = 3900; h.event({ type: "assistantText", text: "Finished while settings was open" });
  h.click("← Назад"); h.flush();
  assert.equal(h.feed.scrollTop, 3500);
});

test("turning auto-scroll off preserves the exact bottom coordinate across a menu and incoming messages", () => {
  const h = harness(); h.event({ type: "autoScrollMode", mode: "allOff" }); h.scroll(2600); h.click("📦 Архив");
  h.height = 3900; h.event({ type: "assistantText", text: "New response with auto-scroll off" }); h.click("← Назад"); h.flush();
  assert.equal(h.feed.scrollTop, 2600);
});

test("a hidden tile with zero layout restores its previous position when shown again", () => {
  const h = harness(); h.scroll(1190); h.layout(0);
  h.feed.onScroll({ currentTarget: h.feed }); h.render(); h.layout(3000);
  assert.equal(h.feed.scrollTop, 1190);
});

test("two tiles showing the same project and record restore independent reading positions", () => {
  const first = harness({ chatId: "chat-first", initialProjectPath: project.id, initialRecordId: "record-one", initialAgent: "codex" });
  const second = harness({ chatId: "chat-second", initialProjectPath: project.id, initialRecordId: "record-one", initialAgent: "codex" });
  first.scroll(320); second.scroll(1710); first.click("⚙"); second.click("📦 Архив");
  first.click("← Назад"); second.click("← Назад"); first.flush(); second.flush();
  assert.equal(first.feed.scrollTop, 320); assert.equal(second.feed.scrollTop, 1710);
});

test("changing a tile session while settings is open never inherits another session's scroll", () => {
  const chatId = "chat-session";
  const h = harness({ chatId, initialProjectPath: project.id, initialRecordId: "record-one", initialAgent: "codex" });
  h.scroll(1475); h.click("⚙");
  const bind = recordId => h.deliver({ type: "multiState", projects: [project, secondProject], chats: [{ chatId, projectPath: project.id, recordId, agent: "codex", title: recordId }] });
  bind("record-two"); h.transcript("record-two"); h.height = 1200; h.click("← Назад"); h.flush();
  assert.equal(h.feed.scrollTop, 800, "an unseen session starts at its own latest message");
  h.scroll(250); h.click("⚙"); bind("record-one"); h.transcript("record-one"); h.height = 3000; h.click("← Назад"); h.flush();
  assert.equal(h.feed.scrollTop, 1475, "returning to the old session restores only its own position");
});

test("a new single-chat session starts at its own content after the host acknowledges it", () => {
  const h = harness(); h.scroll(1475); h.click("＋ Новая");
  const requestId = commands.find(command => command.type === "newSession").requestId;
  h.height = 400; h.event({ type: "reset" }); h.layout(400);
  h.event({ type: "agentInfo", agent: "codex", recordId: "record-new", contextRequestId: requestId });
  h.height = 1200; h.transcript("record-new"); h.layout(1200);
  assert.equal(h.feed.scrollTop, 800);
});

test("projects sharing a folder keep separate scroll positions", () => {
  const chatId = "chat-project";
  const h = harness({ chatId, initialProjectPath: project.id, initialRecordId: "record-one", initialAgent: "codex" });
  h.scroll(678);
  const bind = (projectPath, recordId) => h.deliver({ type: "multiState", projects: [project, secondProject], chats: [{ chatId, projectPath, recordId, agent: "codex", title: recordId }] });
  bind(secondProject.id, "record-one"); h.transcript("record-one", secondProject.id); h.flush(); h.scroll(1890);
  bind(project.id, "record-one"); h.transcript(); h.flush();
  assert.equal(h.feed.scrollTop, 678);
  bind(secondProject.id, "record-one"); h.transcript("record-one", secondProject.id); h.flush();
  assert.equal(h.feed.scrollTop, 1890);
});
