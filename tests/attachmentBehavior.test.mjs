import assert from "node:assert/strict";
import { File } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-attachment-ui-"));
const hookKey = Symbol.for("agent-hub-attachment-ui-hooks");
const originalGlobals = new Map(["window", "localStorage", "acquireVsCodeApi", "File", "FileReader", "requestAnimationFrame"].map(key => [key, globalThis[key]]));
let commands = [], listeners = new Set(), readers = [];
globalThis.window = { addEventListener: (_name, listener) => listeners.add(listener), removeEventListener: (_name, listener) => listeners.delete(listener), innerHeight: 800 };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.acquireVsCodeApi = () => ({ postMessage: message => commands.push(message) });
globalThis.File = File;
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
globalThis.FileReader = class {
  constructor() { readers.push(this); }
  readAsDataURL(file) { this.file = file; }
  async succeed() { this.result = `data:${this.file.type};base64,${Buffer.from(await this.file.arrayBuffer()).toString("base64")}`; this.onload?.(); }
  fail() { this.onerror?.(); }
};
after(async () => { for (const [key, value] of originalGlobals) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  delete globalThis[hookKey]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "app.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../webview/App.tsx", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "controlled-attachment-react-host", setup(b) {
    b.onResolve({ filter: /^(react(?:\/jsx-runtime)?|react-markdown|remark-gfm)$/ }, ({ path }) => ({ path, namespace: "ui" }));
    b.onLoad({ filter: /.*/, namespace: "ui" }, ({ path }) => {
      if (path.endsWith("jsx-runtime")) return { contents: 'export const Fragment="fragment";export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;' };
      if (path === "react") return { contents: 'const h=()=>globalThis[Symbol.for("agent-hub-attachment-ui-hooks")];export const useState=(v)=>h().state(v);export const useRef=(v)=>h().ref(v);export const useEffect=(f,d)=>h().effect(f,d);export const useMemo=(f,d)=>h().memo(f,d);export const useCallback=(f,d)=>h().memo(()=>f,d);export const useId=()=>h().ref("attachment-id").current;' };
      return { contents: 'export default function Stub(){return null;}' };
    });
  } }],
});
const { App } = await import(pathToFileURL(outfile));
const ChatTile = App().type;
const project = { id: "project-one", name: "One", path: "/fixture/one" };
const secondProject = { id: "project-two", name: "Two", path: "/fixture/two" };
const oldImage = { name: "original.PNG", path: "/fixture/one/.agent-hub/attachments/original.PNG" };
const note = { name: "note.txt", path: "/fixture/one/.agent-hub/attachments/note.txt" };
const lastImage = { name: "last.webp", path: "/fixture/one/.agent-hub/attachments/last.webp" };
const replacement = { name: "new.png", path: "/fixture/one/.agent-hub/attachments/new.png" };
const textOf = node => node == null || typeof node === "boolean" ? "" : Array.isArray(node) ? node.map(textOf).join("") : typeof node === "object" ? textOf(node.props?.children) : String(node);
function nodes(node) { return Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.props?.children)] : []; }
const harnesses = [];
afterEach(() => { harnesses.splice(0).forEach(h => h.dispose()); commands = []; listeners.clear(); readers = []; });
function harness(props = {}) {
  const slots = []; let cursor = 0, dirty = false, effects = [], cleanups = [], refs = new Map();
  const hooks = {
    state(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], value => { const next = typeof value === "function" ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    ref(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    memo(fn, deps) { const i = cursor++, previous = slots[i]; if (!previous || deps.some((value, j) => !Object.is(value, previous.deps[j]))) slots[i] = { deps, value: fn() }; return slots[i].value; },
    effect(fn, deps) { const i = cursor++, previous = slots[i]; if (!previous || !deps || deps.some((value, j) => !Object.is(value, previous.deps?.[j]))) {
      if (previous?.cleanup) cleanups.push(previous.cleanup); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = fn(); }); } },
  };
  const h = { tree: null, focused: null, clickedInput: null };
  const commitRefs = () => {
    const next = new Map();
    for (const node of nodes(h.tree)) {
      const ref = node.props?.ref;
      if (!ref || typeof ref !== "object") continue;
      const element = refs.get(ref) ?? { style: {}, scrollHeight: 30, open: false,
        focus() { h.focused = this.label; }, click() { h.clickedInput = this.label; },
        showModal() { this.open = true; }, close() { this.open = false; } };
      element.label = node.props["aria-label"] ?? textOf(node).trim(); element.disabled = !!node.props.disabled;
      ref.current = element; next.set(ref, element);
    }
    for (const [ref] of refs) if (!next.has(ref)) ref.current = null;
    refs = next;
  };
  h.render = () => { for (let n = 0; n < 30; n++) { globalThis[hookKey] = hooks; cursor = 0; dirty = false; effects = []; cleanups = [];
    h.tree = ChatTile(props); commitRefs(); cleanups.forEach(fn => fn()); effects.forEach(fn => fn()); if (!dirty) return; } assert.fail("render did not settle"); };
  h.all = type => nodes(h.tree).filter(node => node.type === type);
  h.button = label => h.all("button").find(node => (node.props["aria-label"] ?? textOf(node).trim()) === label);
  h.click = label => { const button = h.button(label); assert.ok(button, `missing ${label}`); assert.equal(!!button.props.disabled, false, `${label} is disabled`);
    button.props.onClick({ currentTarget: button.props.ref?.current ?? { isConnected: true, focus() {} } }); h.render(); };
  h.field = label => nodes(h.tree).find(node => ["textarea", "input"].includes(node.type) && node.props["aria-label"] === label);
  h.edit = (label, value) => { const field = h.field(label); assert.ok(field, `missing ${label}`); field.props.onChange({ target: { value } }); h.render(); };
  h.deliver = message => { [...listeners].forEach(listener => listener({ data: message })); h.render(); };
  h.event = message => h.deliver({ path: project.id, ...(props.chatId ? { chatId: props.chatId } : {}), ...message });
  h.pick = files => { h.click("Прикрепить файлы"); const request = commands.filter(command => command.type === "pickAttachment").at(-1); h.event({ type: "attachmentAdded", files, draftContext: request.draftContext }); };
  h.chooseReplacement = file => { const input = h.field("Выбрать замену изображения"); assert.ok(input); input.props.onChange({ target: { files: file ? [file] : [], value: file?.name ?? "" } }); h.render(); };
  h.resolve = async (reader = readers.at(-1)) => { await reader.succeed(); h.render(); return commands.filter(command => command.type === "saveAttachment").at(-1); };
  h.ack = (request, files = [replacement], patch = {}) => h.event({ type: "attachmentAdded", draftContext: request.draftContext, files,
    ...(request.chatId ? { chatId: request.chatId } : {}), ...patch });
  h.chipNames = () => nodes(h.tree).filter(node => node.props?.className === "attach-chip").map(node => textOf(node).replace(/📎|Просмотр|Заменить|✕/g, "").trim());
  h.beginEdit = () => {
    h.event({ type: "transcript", recordId: "record-one", items: [{ id: 10, role: "user", text: "Original prompt", sentMessage: { messageId: "message-one", agent: "codex", kind: "prompt", attachmentFiles: [oldImage] } }] });
    h.click("Редактировать сообщение"); const request = commands.filter(command => command.type === "prepareMessageEdit").at(-1);
    h.event({ type: "messageEditPrepared", requestId: request.requestId, sourceRecordId: "record-one", messageId: "message-one", agent: "codex", text: "Editable prompt", attachments: [oldImage] });
  };
  h.dispose = () => slots.forEach(slot => slot?.cleanup?.());
  harnesses.push(h); h.render();
  h.event({ type: "projects", projects: [project, secondProject], activePath: project.id });
  h.event({ type: "agentInfo", agent: "codex", recordId: "record-one" }); return h;
}

test("text dialog saves UTF-8 as a .txt attachment without changing or sending the ordinary composer", async () => {
  const h = harness(); h.edit("Сообщение агенту", "Keep my prompt"); h.click("Прикрепить текст");
  assert.equal(h.all("dialog")[0].props.ref.current.open, true);
  const text = "Large pasted text\nUnicode 🧪 日本語\n\n ";
  h.edit("Текст вложения", text); h.edit("Имя текстового файла", "Notes 🧪"); h.click("Сохранить текстовое вложение");
  assert.equal(readers[0].file.name, "Notes 🧪.txt"); assert.equal(readers[0].file.type, "text/plain;charset=utf-8");
  assert.equal(readers[0].file.size, Buffer.byteLength(text)); assert.equal(h.button("Отправить").props.disabled, true);
  const request = await h.resolve(); assert.equal(Buffer.from(request.dataBase64, "base64").toString(), text);
  assert.equal(request.path, project.id); assert.equal(request.draftContext.recordId, "record-one");
  h.ack(request, [{ name: request.name, path: "/fixture/one/.agent-hub/attachments/text.txt" }]);
  assert.equal(h.all("dialog").length, 0); assert.equal(h.field("Сообщение агенту").props.value, "Keep my prompt");
  assert.equal(commands.some(command => ["send", "steer", "editMessage"].includes(command.type)), false);
});

test("empty text is blocked and cancel or Escape restores focus without an upload", () => {
  const h = harness(); h.click("Прикрепить текст"); h.edit("Текст вложения", " \n ");
  assert.equal(h.button("Сохранить текстовое вложение").props.disabled, true); h.click("Отмена текстового вложения");
  assert.equal(h.all("dialog").length, 0); assert.equal(h.focused, "Прикрепить текст");
  h.click("Прикрепить текст"); h.all("dialog")[0].props.onCancel({ preventDefault() {} }); h.render();
  assert.equal(h.all("dialog").length, 0); assert.equal(readers.length, 0);
});

test("text filenames reject traversal and control characters while the default is a safe dated .txt name", async () => {
  const h = harness(); h.click("Прикрепить текст"); h.edit("Текст вложения", "Keep this text");
  for (const name of ["../outside", "a\\b", "bad\u0000name"]) {
    h.edit("Имя текстового файла", name); h.click("Сохранить текстовое вложение");
    assert.ok(nodes(h.tree).some(node => node.props?.role === "alert")); assert.equal(readers.length, 0);
  }
  h.edit("Имя текстового файла", ""); h.click("Сохранить текстовое вложение");
  assert.match(readers[0].file.name, /^text-\d{4}-\d{2}-\d{2}.*\.txt$/);
  const request = await h.resolve(); h.ack(request, [{ name: request.name, path: "/fixture/default.txt" }]);
});

test("the 20 MiB limit measures UTF-8 bytes and preserves oversized text for correction", () => {
  const h = harness(); h.click("Прикрепить текст"); const text = "🧪".repeat(5 * 1024 * 1024 + 1);
  h.edit("Текст вложения", text); h.click("Сохранить текстовое вложение");
  assert.equal(readers.length, 0); assert.equal(h.field("Текст вложения").props.value, text);
  assert.ok(nodes(h.tree).some(node => node.props?.role === "alert" && textOf(node).includes("20")));
});

test("text read and host save failures keep the text available for retry", async () => {
  const h = harness(); h.click("Прикрепить текст"); h.edit("Текст вложения", "Do not lose this"); h.click("Сохранить текстовое вложение");
  readers.at(-1).fail(); h.render(); assert.equal(h.field("Текст вложения").props.value, "Do not lose this");
  assert.equal(h.button("Сохранить текстовое вложение").props.disabled, false);
  h.click("Сохранить текстовое вложение"); const request = await h.resolve();
  h.event({ type: "error", message: "Storage unavailable", draftContext: request.draftContext });
  assert.equal(h.field("Текст вложения").props.value, "Do not lose this");
  assert.ok(nodes(h.tree).some(node => node.props?.role === "alert" && textOf(node).includes("Storage unavailable")));
  h.click("Сохранить текстовое вложение"); const retried = await h.resolve(); h.ack(retried, [{ name: retried.name, path: "/fixture/retry.txt" }]);
  assert.equal(h.all("dialog").length, 0);
});

test("canceling a text upload ignores both delayed file reading and a later host acknowledgement", async () => {
  const h = harness(); h.edit("Сообщение агенту", "Prompt"); h.click("Прикрепить текст"); h.edit("Текст вложения", "Canceled text");
  h.click("Сохранить текстовое вложение"); const reader = readers.at(-1); h.click("Отмена текстового вложения");
  await h.resolve(reader); assert.equal(commands.some(command => command.type === "saveAttachment"), false);
  h.click("Прикрепить текст"); h.edit("Текст вложения", "Canceled after reading"); h.click("Сохранить текстовое вложение");
  const request = await h.resolve(); h.click("Отмена текстового вложения"); h.ack(request, [{ name: "canceled.txt", path: "/fixture/canceled.txt" }]);
  assert.deepEqual(h.chipNames(), []); assert.equal(h.button("Отправить").props.disabled, false);
});

test("exactly 20 MiB of UTF-8 text is accepted by the existing attachment size boundary", () => {
  const h = harness(); h.click("Прикрепить текст"); h.edit("Текст вложения", "a".repeat(20 * 1024 * 1024));
  h.click("Сохранить текстовое вложение"); assert.equal(readers.at(-1).file.size, 20 * 1024 * 1024);
  h.click("Отмена текстового вложения");
});

test("image names and Preview open the existing file while non-images have no replacement action", () => {
  const h = harness(); h.pick([note, oldImage]); h.click("Просмотр original.PNG");
  assert.deepEqual(commands.at(-1), { type: "openFile", path: oldImage.path, project: project.id });
  h.click("Открыть original.PNG"); assert.equal(commands.at(-1).path, oldImage.path);
  assert.equal(h.button("Заменить note.txt"), undefined);
});

test("a replacement retains the original and blocks sending until its exact acknowledgement replaces it in place", async () => {
  const h = harness(); h.edit("Сообщение агенту", "Prompt"); h.pick([note, oldImage, lastImage]); h.click("Заменить original.PNG");
  assert.equal(h.clickedInput, "Выбрать замену изображения");
  h.chooseReplacement(new File(["png bytes"], "new.png", { type: "image/png" }));
  assert.deepEqual(h.chipNames(), [note.name, oldImage.name, lastImage.name]); assert.equal(h.button("Отправить").props.disabled, true);
  h.field("Сообщение агенту").props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {} });
  assert.equal(commands.some(command => command.type === "send"), false);
  const request = await h.resolve(); h.ack(request, [replacement], { draftContext: { ...request.draftContext, uploadId: "wrong-upload" } });
  assert.deepEqual(h.chipNames(), [note.name, oldImage.name, lastImage.name]);
  h.ack(request); assert.deepEqual(h.chipNames(), [note.name, replacement.name, lastImage.name]);
  assert.equal(h.button("Отправить").props.disabled, false); h.ack(request);
  assert.deepEqual(h.chipNames(), [note.name, replacement.name, lastImage.name]);
});

for (const failure of ["cancel", "type", "read", "host"]) test(`replacement ${failure} keeps the original image`, async () => {
  const h = harness(); h.edit("Сообщение агенту", "Prompt"); h.pick([oldImage]); h.click("Заменить original.PNG");
  h.chooseReplacement(failure === "cancel" ? null : new File(["contents"], failure === "type" ? "not-an-image.txt" : "new.png"));
  if (failure === "read") { readers.at(-1).fail(); h.render(); }
  if (failure === "host") { const request = await h.resolve(); h.event({ type: "error", message: "Cannot save replacement", draftContext: request.draftContext }); }
  assert.deepEqual(h.chipNames(), [oldImage.name]); assert.equal(h.button("Отправить").props.disabled, false);
  if (failure === "type") assert.equal(readers.length, 0);
});

test("removing an image during replacement prevents the eventual success from reattaching it", async () => {
  const h = harness(); h.pick([oldImage, note]); h.click("Заменить original.PNG"); h.chooseReplacement(new File(["image"], "new.png"));
  h.click("Убрать вложение original.PNG"); const request = await h.resolve(); h.ack(request);
  assert.deepEqual(h.chipNames(), [note.name]);
});

test("ordinary pasted files also block sending until their upload completes or fails", () => {
  const h = harness(); h.edit("Сообщение агенту", "Prompt");
  h.field("Сообщение агенту").props.onPaste({ clipboardData: { files: [new File(["image"], "pasted.png")] }, preventDefault() {} }); h.render();
  assert.equal(h.button("Отправить").props.disabled, true); readers.at(-1).fail(); h.render();
  assert.equal(h.button("Отправить").props.disabled, false); assert.ok(nodes(h.tree).some(node => node.props?.role === "alert"));
});

for (const phase of ["read", "host"]) test(`project switches discard stale ${phase} completion and unblock the new draft`, async () => {
  const chatId = "chat-one", h = harness({ chatId, initialProjectPath: project.id, initialRecordId: "record-one", initialAgent: "codex" });
  h.pick([oldImage]); h.click("Заменить original.PNG"); h.chooseReplacement(new File(["image"], "new.png"));
  const reader = readers.at(-1), request = phase === "host" ? await h.resolve(reader) : null;
  h.deliver({ type: "multiState", projects: [project, secondProject], chats: [{ chatId, projectPath: secondProject.id, recordId: "record-two", agent: "codex", title: "Two" }] });
  if (request) h.ack(request); else await h.resolve(reader);
  assert.equal(commands.filter(command => command.type === "saveAttachment").length, phase === "host" ? 1 : 0);
  assert.deepEqual(h.chipNames(), []); h.edit("Сообщение агенту", "New project prompt"); assert.equal(h.button("Отправить").props.disabled, false);
});

test("new session changes close the text modal and reject the old upload response", async () => {
  const chatId = "chat-modal", h = harness({ chatId, initialProjectPath: project.id, initialRecordId: "record-one", initialAgent: "codex" });
  h.click("Прикрепить текст"); h.edit("Текст вложения", "Old session only"); h.click("Сохранить текстовое вложение"); const request = await h.resolve();
  h.deliver({ type: "multiState", projects: [project], chats: [{ chatId, projectPath: project.id, recordId: "record-two", agent: "codex", title: "Two" }] });
  h.ack(request, [{ name: "old.txt", path: "/fixture/old.txt" }]); assert.equal(h.all("dialog").length, 0); assert.deepEqual(h.chipNames(), []);
});

test("uploads and image replacement remain isolated between two chats of the same project", async () => {
  const props = { initialProjectPath: project.id, initialRecordId: "record-one", initialAgent: "codex" };
  const first = harness({ ...props, chatId: "chat-first" }), second = harness({ ...props, chatId: "chat-second" });
  first.pick([oldImage]); second.pick([lastImage]); first.click("Заменить original.PNG"); first.chooseReplacement(new File(["image"], "new.png"));
  const request = await first.resolve(); second.ack(request); assert.deepEqual(second.chipNames(), [lastImage.name]);
  first.ack(request); assert.deepEqual(first.chipNames(), [replacement.name]);
});

test("sent-message editing can add text and replace an image while retaining the ordinary composer draft", async () => {
  const h = harness(); h.edit("Сообщение агенту", "Ordinary unsent prompt"); h.beginEdit();
  h.click("Прикрепить текст"); h.edit("Текст вложения", "Edit attachment body"); h.click("Сохранить текстовое вложение");
  assert.equal(h.button("Сохранить и отправить").props.disabled, true);
  let request = await h.resolve(); const textFile = { name: request.name, path: "/fixture/edit.txt" }; h.ack(request, [textFile]);
  h.click("Заменить original.PNG"); h.chooseReplacement(new File(["image"], "new.png"));
  assert.equal(h.button("Сохранить и отправить").props.disabled, true); request = await h.resolve(); h.ack(request);
  assert.deepEqual(h.chipNames(), [replacement.name, textFile.name]); h.click("Отмена");
  assert.equal(h.field("Сообщение агенту").props.value, "Ordinary unsent prompt"); assert.deepEqual(h.chipNames(), []);
  assert.equal(commands.some(command => ["send", "steer", "editMessage"].includes(command.type)), false);
});

test("a successful replacement retry clears the edit composer's previous upload error", async () => {
  const h = harness(); h.beginEdit(); h.click("Заменить original.PNG"); h.chooseReplacement(new File(["image"], "new.png"));
  readers.at(-1).fail(); h.render(); assert.ok(nodes(h.tree).some(node => node.props?.role === "alert"));
  h.click("Заменить original.PNG"); h.chooseReplacement(new File(["image"], "new.png")); const request = await h.resolve(); h.ack(request);
  assert.equal(nodes(h.tree).some(node => node.props?.role === "alert"), false);
});
