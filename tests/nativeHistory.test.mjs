import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-native-edit-"));
const key = Symbol.for("agent-hub.native-edit-tests");
let current;
globalThis[key] = {
  spawn: (...args) => { current.spawnArgs = args; return current.child; },
  track: () => current.tracked++,
  stop: async (child) => { current.stopped++; child.exitCode = 0; child.emit("exit", 0); return true; },
  fork: (...args) => current.fork(...args),
};
after(async () => { delete globalThis[key]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "backend.mjs");
const entry = join(temp, "entry.mjs");
await writeFile(entry, `export { CodexAppServerBackend } from ${JSON.stringify(fileURLToPath(new URL("../src/agents/codexAppServerBackend.ts", import.meta.url)))}; export * from ${JSON.stringify(fileURLToPath(new URL("../src/agents/nativeHistory.ts", import.meta.url)))};`);
await build({
  entryPoints: [entry],
  outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "native-edit-mocks", setup(b) {
    b.onResolve({filter:/^node:child_process$|^\.\/codexBackend$/}, ({path})=>({path,namespace:"mock"}));
    b.onLoad({filter:/.*/,namespace:"mock"}, ({path})=>({contents:path==="node:child_process"
      ? 'export const spawn = (...a) => globalThis[Symbol.for("agent-hub.native-edit-tests")].spawn(...a);'
      : `export class CodexBackend { async *start() { throw new Error("inference forbidden"); } }
        export const WRITER_CONFLICT_RE=/thread-store conflict/;
        export const codexDefaultModel=()=>"test";
        export const stopStaleCodex=()=>{throw Error("must not stop unrelated processes")};
        export const trackCodex=()=>{};
        export const trackCodexProcess=()=>globalThis[Symbol.for("agent-hub.native-edit-tests")].track();
        export const stopCodex=(c)=>globalThis[Symbol.for("agent-hub.native-edit-tests")].stop(c);
        export const hardKill=(c)=>{c.exitCode=0;c.emit("exit",0)};` }));
  }}],
});
const { CodexAppServerBackend, forkCodexHistoryForResume } = await import(pathToFileURL(outfile).href);
function codexHarness(source, {fork=source.slice(0,1), failList=false, ignore, hang}={}) {
  const h = current = {child:new EventEmitter(),calls:[],stopped:0,tracked:0};
  Object.assign(h.child,{stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null});
  h.child.stdin=new Writable({write(chunk,_e,cb){
    const req=JSON.parse(chunk.toString()); h.calls.push(req); cb();
    if (!req.id || req.method===hang) return;
    let result={};
    if(req.method==="thread/turns/list") {
      if(failList) {h.child.stdout.write(JSON.stringify({id:req.id,error:{code:-32601,message:"method not found"}})+"\n");return;}
      result={data:req.params.threadId==="source"?source:fork,nextCursor:null};
    }
    if(req.method==="thread/read") result={thread:{id:req.params.threadId,turns:req.params.threadId==="source"?source:fork}};
    if(req.method==="thread/fork") result={thread:{id:ignore??"fork"}};
    if(req.method==="turn/start") throw Error("inference forbidden");
    h.child.stdout.write(JSON.stringify({id:req.id,result})+"\n");
  }});
  return h;
}
const turn=(id,text=id)=>({id,status:"completed",items:[{id:`user-${id}`,type:"userMessage",content:[{type:"text",text}]}]});
const opts=(anchor={provider:"codex",sessionId:"source",turnId:"two"})=>({cwd:temp,sessionId:"source",anchor,signal:new AbortController().signal,config:{contextWindow:0}});

test("resume history rejects coerced terminal statuses before creating a fork", async () => {
  const malformed = [{ ...turn("one"), status: ["completed"] }];
  const h = codexHarness(malformed, { fork: malformed });
  await assert.rejects(forkCodexHistoryForResume(opts()), /незаверш|истор/iu);
  assert.equal(h.calls.some(request => request.method === "thread/fork"), false);
  assert.equal(h.stopped, 1);
});

test("Codex native edit forks exact earlier prefix and never starts inference",async()=>{
  const source=[turn("one"),turn("two"),turn("three")];const h=codexHarness(source);
  assert.deepEqual(await new CodexAppServerBackend().prepareEdit(opts()),{resumeSessionId:"fork"});
  assert.deepEqual(h.calls.find(r=>r.method==="thread/fork").params,{threadId:"source",lastTurnId:"one",cwd:temp,excludeTurns:true});
  assert.equal(h.calls.some(r=>r.method==="turn/start"||r.method==="thread/resume"||r.method==="thread/revert"),false);
  assert.equal(h.stopped,1);assert.equal(h.tracked,1);assert.deepEqual(source,[turn("one"),turn("two"),turn("three")]);
});
test("first Codex prompt becomes fresh history without a fork",async()=>{
 const h=codexHarness([turn("one"),turn("two")]);assert.deepEqual(await new CodexAppServerBackend().prepareEdit(opts({provider:"codex",sessionId:"source",turnId:"one"})),{});
 assert.equal(h.calls.some(r=>r.method==="thread/fork"),false);
});
test("Codex refuses an old server that ignores the fork boundary",async()=>{
 const source=[turn("one"),turn("two"),turn("three")];const h=codexHarness(source,{fork:source});
 await assert.rejects(new CodexAppServerBackend().prepareEdit(opts()),/prefix|границ|истори/iu);assert.equal(h.stopped,1);
});
test("Codex exact legacy suffix must be unique; no fuzzy or count matching",async()=>{
 const h=codexHarness([turn("one","context\nrepeat"),turn("two","repeat")]);
 await assert.rejects(new CodexAppServerBackend().prepareEdit({...opts(),anchor:undefined,legacyPrompt:"repeat"}),/однознач|unique|ambiguous/iu);
 assert.equal(h.calls.some(r=>r.method==="thread/fork"),false);
});
test("Codex uses read compatibility only for unavailable paginated API",async()=>{
 const h=codexHarness([turn("one"),turn("two")],{failList:true});await new CodexAppServerBackend().prepareEdit(opts());
 assert.equal(h.calls.filter(r=>r.method==="thread/read").length,2);
});
test("Codex abort rejects pending read and cleans up its own server",async()=>{
 const h=codexHarness([],{hang:"thread/turns/list"});const ctrl=new AbortController();
 const promise=new CodexAppServerBackend().prepareEdit({...opts(),signal:ctrl.signal});
 await new Promise(r=>setImmediate(r));ctrl.abort();await assert.rejects(promise,/отмен|abort/iu);assert.equal(h.stopped,1);
});

test("Codex metadata paging reads full prefix with no tool payload hydration",async()=>{
 const source=[turn("one"),turn("two"),turn("three")];const h=codexHarness(source);
 const write=h.child.stdin._write;h.child.stdin._write=(chunk,e,cb)=>{
  const req=JSON.parse(chunk.toString());
  if(req.method!=="thread/turns/list")return write(chunk,e,cb);
  h.calls.push(req);cb();assert.equal(req.params.itemsView,"notLoaded");
  const all=req.params.threadId==="source"?source:source.slice(0,2);
  const start=req.params.cursor?Number(req.params.cursor):0;
  h.child.stdout.write(JSON.stringify({id:req.id,result:{data:all.slice(start,start+1).map(({id,status})=>({id,status,items:[],itemsView:"notLoaded"})),nextCursor:start+1<all.length?String(start+1):null}})+"\n");
 };
 assert.deepEqual(await new CodexAppServerBackend().prepareEdit(opts({provider:"codex",sessionId:"source",turnId:"three"})),{resumeSessionId:"fork"});
 assert.equal(h.calls.filter(r=>r.method==="thread/turns/list").length,5);
});
test("Codex pending native-history request times out and clears all deadlines",async(t)=>{
 const timers=new Map();t.mock.method(globalThis,"setTimeout",(cb)=>{const timer={unref(){return this;}};timers.set(timer,cb);return timer;});t.mock.method(globalThis,"clearTimeout",timer=>timers.delete(timer));
 const h=codexHarness([],{hang:"thread/turns/list"});const promise=new CodexAppServerBackend().prepareEdit(opts());
 await new Promise(r=>setImmediate(r));assert.equal(timers.size,1);[...timers.values()][0]();
 await assert.rejects(promise,/60|врем/iu);assert.equal(h.stopped,1);assert.equal(timers.size,0);
});
test("Codex rejects same-source fork IDs and unknown anchors without replay",async()=>{
 const h=codexHarness([turn("one"),turn("two")],{ignore:"source"});await assert.rejects(new CodexAppServerBackend().prepareEdit(opts()),/отдельн|обновит/iu);
 assert.equal(h.calls.some(r=>r.method==="turn/start"),false);
});

const missingOpts = (overrides = {}) => ({ ...opts(), anchor: undefined, legacyPrompt: "Missing original 📌", allowSavedContextFallback: true, ...overrides });
const noNativeMutation = h => assert.equal(h.calls.some(r => ["thread/fork", "thread/resume", "thread/revert", "turn/start"].includes(r.method)), false);

test("Codex missing original can explicitly return saved-context fallback without native mutation", async () => {
 const source = [turn("one", "Earlier prompt"), turn("two", "Last persisted prompt")], before = structuredClone(source);
 const h = codexHarness(source);
 assert.deepEqual(await new CodexAppServerBackend().prepareEdit(missingOpts()), { contextFallback: true });
 assert.ok(h.calls.filter(r => r.method === "thread/turns/list").every(r => r.params.itemsView === "full"));
 noNativeMutation(h); assert.equal(h.stopped, 1); assert.deepEqual(source, before);
});

test("Codex missing-original fallback requires explicit opt-in and no anchor", async () => {
 for (const extra of [{ allowSavedContextFallback: undefined }, { anchor: { provider: "codex", sessionId: "source", turnId: "absent" } }]) {
  const h = codexHarness([turn("one")]);
  await assert.rejects(new CodexAppServerBackend().prepareEdit(missingOpts(extra)), /однознач|истори/iu); noNativeMutation(h);
 }
});

test("Codex resolves only the first user message of a turn even when later steers exist", async () => {
 const target = turn("two", "context\nOriginal exact"), steer = { type: "userMessage", content: [{ type: "text", text: "Later steer" }] };
 target.items.push(steer);
 const h = codexHarness([turn("one"), target, turn("three")]);
 assert.deepEqual(await new CodexAppServerBackend().prepareEdit(missingOpts({ legacyPrompt: "Original exact" })), { resumeSessionId: "fork" });
 assert.equal(h.calls.find(r => r.method === "thread/fork").params.lastTurnId, "one");
});

test("Codex never mistakes a later steer for the original prompt or an absent message", async () => {
 for (const text of ["Missing original 📌", "prefix Missing original 📌 suffix"]) {
  const target = turn("two", "Actual original"); target.items.push({ type: "userMessage", content: [{ type: "text", text }] });
  const h = codexHarness([turn("one"), target]);
  await assert.rejects(new CodexAppServerBackend().prepareEdit(missingOpts()), /однознач|истори/iu); noNativeMutation(h);
 }
});

test("Codex rejects duplicate original suffixes and substring-only matches instead of fallback", async () => {
 for (const source of [[turn("one", "Missing original 📌"), turn("two", "context\nMissing original 📌")],
  [turn("one", "Missing original 📌 is present but not an exact suffix")]]) {
  const h = codexHarness(source);
  await assert.rejects(new CodexAppServerBackend().prepareEdit(missingOpts()), /однознач|истори/iu); noNativeMutation(h);
 }
});

test("Codex proves missing-original absence across every full source page", async () => {
 const h = codexHarness([]), write = h.child.stdin._write;
 h.child.stdin._write = (chunk, e, cb) => {
  const req = JSON.parse(chunk.toString()); if (req.method !== "thread/turns/list") return write(chunk, e, cb);
  h.calls.push(req); cb(); assert.equal(req.params.itemsView, "full");
  h.child.stdout.write(JSON.stringify({ id: req.id, result: req.params.cursor ? { data: [turn("two", "Missing original 📌 in later page")], nextCursor: null } : { data: [turn("one")], nextCursor: "next" } }) + "\n");
 };
 await assert.rejects(new CodexAppServerBackend().prepareEdit(missingOpts()), /однознач|истори/iu);
 assert.equal(h.calls.filter(r => r.method === "thread/turns/list").length, 2); noNativeMutation(h);
});

test("Codex missing-original fallback refuses malformed, unknown or partial source content", async () => {
 for (const source of [[{ ...turn("one"), itemsView: "notLoaded" }], [{ ...turn("one"), items: [null] }],
  [turn("one", undefined), { ...turn("two"), items: [{ type: "userMessage", content: [{ type: "text", text: null }] }] }],
  [{ ...turn("one"), items: [{ type: "userMessage", content: [{ type: "unknown", text: "hidden" }] }] }]]) {
  const h = codexHarness(source);
  await assert.rejects(new CodexAppServerBackend().prepareEdit(missingOpts())); noNativeMutation(h);
 }
});

test("Codex missing-original fallback rejects a failed later page and abort without changing source", async () => {
 for (const abort of [false, true]) {
  const source = [turn("one")], before = structuredClone(source), h = codexHarness(source), write = h.child.stdin._write;
  const ctrl = new AbortController();
  h.child.stdin._write = (chunk, e, cb) => {
   const req = JSON.parse(chunk.toString()); if (req.method !== "thread/turns/list") return write(chunk, e, cb);
   h.calls.push(req); cb();
   if (!req.params.cursor) h.child.stdout.write(JSON.stringify({ id: req.id, result: { data: source, nextCursor: "next" } }) + "\n");
   else if (abort) ctrl.abort();
   else h.child.stdout.write(JSON.stringify({ id: req.id, error: { code: -32000, message: "source read failed" } }) + "\n");
  };
  await assert.rejects(new CodexAppServerBackend().prepareEdit(missingOpts({ signal: ctrl.signal })), abort ? /отмен|abort/iu : /source read failed/);
  noNativeMutation(h); assert.deepEqual(source, before); assert.equal(h.stopped, 1);
 }
});

const resumeOpts = () => {
 const { anchor, ...rest } = opts(); return rest;
};
test("resume recovery forks and verifies every terminal native turn without inference", async () => {
 const source = [turn("one"), { ...turn("two"), status: "interrupted" }, { ...turn("three"), status: "failed" }];
 const before = structuredClone(source), h = codexHarness(source, { fork: source });
 assert.deepEqual(await forkCodexHistoryForResume(resumeOpts()), { resumeSessionId: "fork" });
 assert.deepEqual(h.calls.find(r => r.method === "thread/fork").params, { threadId: "source", lastTurnId: "three", cwd: temp, excludeTurns: true });
 assert.ok(h.calls.filter(r => r.method === "thread/turns/list").every(r => r.params.itemsView === "notLoaded"));
 assert.equal(h.calls.some(r => ["thread/resume", "thread/start", "turn/start", "thread/revert"].includes(r.method)), false);
 assert.deepEqual(source, before); assert.equal(h.stopped, 1); assert.equal(h.tracked, 1);
});
test("resume recovery refuses any nonterminal turn instead of dropping history", async () => {
 for (const status of ["inProgress", "unknown", undefined, null]) {
  const h = codexHarness([turn("one"), { ...turn("two"), status }]);
  await assert.rejects(forkCodexHistoryForResume(resumeOpts()), /истор|заверш/iu);
  assert.equal(h.calls.some(r => r.method === "thread/fork"), false); assert.equal(h.stopped, 1);
 }
});
test("resume recovery verifies the entire ordered ID and status sequence", async () => {
 const source = [turn("one"), turn("two"), turn("three")];
 for (const fork of [source.slice(0, 2), [...source, turn("four")], [source[1], source[0], source[2]], [source[0], { ...source[1], status: "failed" }, source[2]], [source[0], source[0], source[2]]]) {
  const h = codexHarness(source, { fork });
  await assert.rejects(forkCodexHistoryForResume(resumeOpts()), /истор|границ/iu);
  assert.equal(h.stopped, 1);
 }
});
test("resume recovery requires a fresh nonempty fork ID and verifies legitimate empty history", async () => {
 for (const ignore of ["source", "", " ", 42]) {
  const h = codexHarness([turn("one")], { ignore });
  await assert.rejects(forkCodexHistoryForResume(resumeOpts()), /тред|истор/iu); assert.equal(h.stopped, 1);
 }
 const h = codexHarness([], { fork: [] });
 assert.deepEqual(await forkCodexHistoryForResume(resumeOpts()), { resumeSessionId: "fork" });
 assert.equal(h.calls.find(r => r.method === "thread/fork").params.lastTurnId, undefined);
});
test("resume recovery reads all metadata pages and retains method-not-found read compatibility", async () => {
 const source = [turn("one"), turn("two"), turn("three")], h = codexHarness(source, { fork: source });
 const write = h.child.stdin._write;
 h.child.stdin._write = (chunk, e, cb) => {
  const req = JSON.parse(chunk.toString()); if (req.method !== "thread/turns/list") return write(chunk, e, cb);
  h.calls.push(req); cb(); assert.equal(req.params.itemsView, "notLoaded");
  const index = Number(req.params.cursor ?? 0);
  h.child.stdout.write(JSON.stringify({ id: req.id, result: { data: [source[index]], nextCursor: index < 2 ? String(index + 1) : null } }) + "\n");
 };
 assert.deepEqual(await forkCodexHistoryForResume(resumeOpts()), { resumeSessionId: "fork" });
 assert.equal(h.calls.filter(r => r.method === "thread/turns/list").length, 6);
 const fallback = codexHarness(source, { fork: source, failList: true });
 await forkCodexHistoryForResume(resumeOpts()); assert.equal(fallback.calls.filter(r => r.method === "thread/read").length, 2);
});
test("resume recovery rejects duplicate turns, bad cursors and noncompatibility read failures", async () => {
 for (const mode of ["duplicate", "cursor", "repeat", "read-error", "malformed"]) {
  const h = codexHarness([turn("one")]); const write = h.child.stdin._write;
  h.child.stdin._write = (chunk, e, cb) => {
   const req = JSON.parse(chunk.toString()); if (req.method !== "thread/turns/list") return write(chunk, e, cb);
   h.calls.push(req); cb();
   const result = { data: mode === "duplicate" ? [turn("one"), turn("one")] : mode === "malformed" ? [{ id: "", status: "completed", items: [] }] : [turn("one")], nextCursor: mode === "cursor" ? 42 : mode === "repeat" ? "same" : null };
   h.child.stdout.write(JSON.stringify(mode === "read-error" ? { id: req.id, error: { code: -32000, message: "read failed" } } : { id: req.id, result }) + "\n");
  };
  await assert.rejects(forkCodexHistoryForResume(resumeOpts()));
  assert.equal(h.calls.some(r => r.method === "thread/read" || r.method === "thread/fork"), false); assert.equal(h.stopped, 1);
 }
});
test("resume recovery waits for confirmed helper cleanup and aborts after cleanup", async () => {
 const h = codexHarness([turn("one")], { fork: [turn("one")] }), ctrl = new AbortController();
 const stop = globalThis[key].stop; let release, done = false;
 globalThis[key].stop = async child => { h.stopped++; await new Promise(resolve => { release = resolve; }); child.exitCode = 0; child.emit("exit", 0); return true; };
 try {
  const pending = forkCodexHistoryForResume({ ...resumeOpts(), signal: ctrl.signal }); pending.finally(() => { done = true; }).catch(() => {});
  while (!release) await new Promise(r => setImmediate(r));
  assert.equal(done, false); ctrl.abort(); release(); await assert.rejects(pending, /abort/iu);
 } finally { globalThis[key].stop = stop; release?.(); }
});
test("resume recovery cannot return a usable ID after failed cleanup", async () => {
 const h = codexHarness([turn("one")], { fork: [turn("one")] }), stop = globalThis[key].stop;
 globalThis[key].stop = async () => false;
 try { await assert.rejects(forkCodexHistoryForResume(resumeOpts()), /процесс/iu); }
 finally { globalThis[key].stop = stop; }
 assert.equal(h.calls.some(r => r.method === "turn/start"), false);
});
