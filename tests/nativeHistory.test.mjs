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
await build({
  entryPoints: [fileURLToPath(new URL("../src/agents/codexAppServerBackend.ts", import.meta.url))],
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
const { CodexAppServerBackend } = await import(pathToFileURL(outfile).href);
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
