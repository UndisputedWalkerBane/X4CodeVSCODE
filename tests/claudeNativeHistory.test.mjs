import assert from "node:assert/strict";
import fsPromises, { realpath, mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink, link, readdir } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test as nodeTest } from "node:test";
import { build } from "esbuild";
const temp=await realpath(await mkdtemp(join(tmpdir(),"agent-hub-claude-edit-")));
const key=Symbol.for("agent-hub.claude-native-tests");let current;
globalThis[key]={fork:(...a)=>current.fork(...a),query:(...a)=>current.query(...a)};
after(async()=>{delete globalThis[key];await rm(temp,{recursive:true,force:true});});
const out=join(temp,"backend.mjs");
await build({entryPoints:[fileURLToPath(new URL("../src/agents/claudeBackend.ts",import.meta.url))],outfile:out,bundle:true,platform:"node",format:"esm",plugins:[{name:"sdk-mock",setup(b){
 b.onResolve({filter:/^@anthropic-ai\/claude-agent-sdk$/},()=>({path:"sdk",namespace:"mock"}));
 b.onLoad({filter:/.*/,namespace:"mock"},()=>({contents:'export const forkSession=(...a)=>globalThis[Symbol.for("agent-hub.claude-native-tests")].fork(...a); export const query=(...a)=>globalThis[Symbol.for("agent-hub.claude-native-tests")].query(...a);'}));
}}]});
const {ClaudeBackend}=await import(pathToFileURL(out).href);
const safeHistoryFiles = Boolean(constants.O_NOFOLLOW && constants.O_DIRECTORY);
const test = (name, body) => nodeTest(name, { skip: !safeHistoryFiles && "native Claude history requires no-follow directory handles" }, body);
const sourceId="11111111-1111-4111-8111-111111111111",forkId="22222222-2222-4222-8222-222222222222";
const u1="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",a1="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",hidden="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",u2="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",u3="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
async function fixture(name,changes={}){
 const cwd=join(temp,name);await mkdir(cwd);const configDir=join(cwd,"config");const projectDir=join(configDir,"projects",cwd.replace(/[^a-zA-Z0-9]/g,"-"));await mkdir(projectDir,{recursive:true});
 const path=join(projectDir,`${sourceId}.jsonl`);
 const row=(type,uuid,parentUuid,message)=>({type,uuid,parentUuid,message,sessionId:sourceId,cwd});
 const rows=[row("user",u1,null,{role:"user",content:"first"}),row("assistant",a1,u1,{role:"assistant",content:[{type:"text",text:"answer"}]}),{...row("attachment",hidden,a1),attachment:{type:"queued_command",prompt:"hidden context"}},row("user",u2,hidden,{role:"user",content:"context\nedit me"}),row("user",u3,u2,{role:"user",content:"future"})];
 Object.assign(rows[3],changes);await writeFile(path,rows.map(r=>JSON.stringify(r)).join("\n")+"\n");
 const h=current={rows,path,cwd,projectDir,calls:[],fork:async(id,o)=>{
  h.calls.push({id,options:o});const index=rows.findIndex(r=>r.uuid===o.upToMessageId);const prefix=rows.slice(0,index+1).filter(r=>r.type!=="progress");
  const map=new Map(prefix.map((r,i)=>[r.uuid,`bbbbbbbb-bbbb-4bbb-8bbb-${String(i+1).padStart(12,"0")}`]));
  const forkRows=prefix.map(r=>({...r,uuid:map.get(r.uuid),parentUuid:map.get(r.parentUuid)??null,sessionId:forkId,forkedFrom:{sessionId:sourceId,messageUuid:r.uuid}}));
  // Exercise SDK's public scoped storage contract rather than writing a visible transcript.
  if(o.sessionStore){assert.deepEqual(await o.sessionStore.load({sessionId:id}),JSON.parse(JSON.stringify(rows)));await o.sessionStore.append({sessionId:forkId},forkRows);}
  else await writeFile(join(projectDir,`${forkId}.jsonl`),forkRows.map(r=>JSON.stringify(r)).join("\n"));
  return {sessionId:forkId};
 }};
 h.opts={cwd,sessionId:sourceId,anchor:{provider:"claude",sessionId:sourceId,userMessageUuid:u2,transcriptPath:path},extraEnv:{CLAUDE_CONFIG_DIR:configDir},signal:new AbortController().signal,config:{contextWindow:0}};return h;
}
test("Claude forks through actual hidden parent and remaps retained native UUIDs",async()=>{
 const h=await fixture("hidden-parent");const before=await readFile(h.path,"utf8");const result=await new ClaudeBackend().prepareEdit(h.opts);
 assert.equal(h.calls[0].options.upToMessageId,hidden);assert.equal(result.resumeSessionId,forkId);
 assert.equal(result.remappedAnchors[u1].sessionId,forkId);assert.notEqual(result.remappedAnchors[u1].userMessageUuid,u1);
 assert.equal(result.remappedAnchors[u2],undefined);assert.equal(result.remappedAnchors[u3],undefined);assert.equal(await readFile(h.path,"utf8"),before);
 const fork=await readFile(join(h.projectDir,`${forkId}.jsonl`),"utf8");assert.equal(fork.includes("edit me"),false);assert.equal(fork.includes("hidden context"),true);
});
test("Claude first user prompt returns fresh without invoking fork",async()=>{
 const h=await fixture("first");h.opts.anchor.userMessageUuid=u1;assert.deepEqual(await new ClaudeBackend().prepareEdit(h.opts),{});assert.equal(h.calls.length,0);
});
test("Claude missing parent refuses without inference or lossy copy",async()=>{
 const h=await fixture("missing",{parentUuid:"missing"});await assert.rejects(new ClaudeBackend().prepareEdit(h.opts),/parent|родител|истори/iu);assert.equal(h.calls.length,0);
});
test("Claude verifies session storage path and cwd before reading requested file",async()=>{
 const h=await fixture("outside");h.opts.anchor.transcriptPath=join(h.cwd,"private.jsonl");await writeFile(h.opts.anchor.transcriptPath,"do not read");await assert.rejects(new ClaudeBackend().prepareEdit(h.opts),/пут|path|storage|хранилищ/iu);assert.equal(h.calls.length,0);
});
test("Claude ambiguous legacy exact text is refused",async()=>{
 const h=await fixture("duplicate");h.rows[0].message.content="edit me";await writeFile(h.path,h.rows.map(r=>JSON.stringify(r)).join("\n"));h.opts.anchor=undefined;h.opts.legacyPrompt="edit me";
 await assert.rejects(new ClaudeBackend().prepareEdit(h.opts),/однознач|unique|ambiguous/iu);assert.equal(h.calls.length,0);
});
test("Claude captures the streamed input UUID from trusted provider hook",async()=>{
 const h=await fixture("capture");const hostId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";let input;
 h.query=({prompt,options})=>({async *[Symbol.asyncIterator](){input=(await prompt[Symbol.asyncIterator]().next()).value;await options.hooks.UserPromptSubmit[0].hooks[0]({hook_event_name:"UserPromptSubmit",session_id:sourceId,transcript_path:h.path,cwd:h.cwd,prompt:"hello",source:"sdk"});yield {type:"result",subtype:"success",total_cost_usd:0,duration_ms:1,num_turns:1};}});
 const events=[];for await(const e of new ClaudeBackend().start("hello",{...h.opts,messageId:hostId,confirmTool:async()=>({allow:true})}))events.push(e);
 assert.equal(input.uuid,hostId);assert.deepEqual(events.find(e=>e.kind==="nativePrompt"),{kind:"nativePrompt",messageId:hostId,anchor:{provider:"claude",sessionId:sourceId,userMessageUuid:hostId,transcriptPath:h.path}});
});

test("installed Claude SDK native fork preserves hidden parent with custom scoped store offline",async()=>{
 const {forkSession}=await import("@anthropic-ai/claude-agent-sdk");
 const h=await fixture("actual-sdk");h.fork=(id,options)=>forkSession(id,options);
 const result=await new ClaudeBackend().prepareEdit(h.opts);
 assert.notEqual(result.resumeSessionId,sourceId);assert.ok(result.remappedAnchors[u1]);
 const copied=JSON.parse((await readFile(result.remappedAnchors[u1].transcriptPath,"utf8")).split("\n").filter(Boolean)[2]);
 assert.equal(copied.type,"attachment");assert.equal(copied.forkedFrom.messageUuid,hidden);
});

test("Claude refuses fork boundaries ignored by the provider",async()=>{
 const h=await fixture("ignored-boundary");const original=h.fork;h.fork=(id,o)=>original(id,{...o,upToMessageId:u3});
 await assert.rejects(new ClaudeBackend().prepareEdit(h.opts),/границ|истори/iu);
});
test("Claude cancellation prevents late provider append after prepare returns",async()=>{
 const h=await fixture("abort");const ctrl=new AbortController();h.opts.signal=ctrl.signal;let captured;
 h.fork=async(_id,o)=>{captured=o;return new Promise(()=>{});};const p=new ClaudeBackend().prepareEdit(h.opts);
 for(let i=0;i<100&&!captured;i++)await new Promise(r=>setImmediate(r));assert.ok(captured);ctrl.abort();await assert.rejects(p,/abort|отмен/iu);
 await assert.rejects(captured.sessionStore.append({sessionId:forkId},[]),/abort|отмен/iu);
});
test("Claude rejects a transcript whose cwd differs from the active project",async()=>{
 const h=await fixture("wrong-cwd");h.rows[0].cwd=temp;await writeFile(h.path,h.rows.map(r=>JSON.stringify(r)).join("\n"));
 await assert.rejects(new ClaudeBackend().prepareEdit(h.opts),/рабоч|папк/iu);assert.equal(h.calls.length,0);
});
test("Claude legacy unique exact suffix can fork using a scoped source filename",async()=>{
 const h=await fixture("legacy");h.opts.anchor=undefined;h.opts.legacyPrompt="edit me";
 assert.equal((await new ClaudeBackend().prepareEdit(h.opts)).resumeSessionId,forkId);assert.equal(h.calls[0].options.upToMessageId,hidden);
});

test("Claude verifies hidden provider payload, not only message UUIDs",async()=>{
 const h=await fixture("hidden-mutated");const fork=h.fork;h.fork=async(id,o)=>{
  const result=await fork(id,o);const path=join(h.projectDir,`${forkId}.jsonl`);const rows=(await readFile(path,"utf8")).split("\n").filter(Boolean).map(JSON.parse);
  rows[2].attachment.prompt="wrong hidden context";await writeFile(path,rows.map(r=>JSON.stringify(r)).join("\n"));return result;
 };
 await assert.rejects(new ClaudeBackend().prepareEdit(h.opts),/истори|контекст/iu);
});
test("Claude compacted first visible prompt cannot silently become a fresh context",async()=>{
 const h=await fixture("compacted");h.rows.splice(0,3,{type:"system",subtype:"compact_boundary",uuid:hidden,parentUuid:null,sessionId:sourceId,cwd:h.cwd});
 await writeFile(h.path,h.rows.map(r=>JSON.stringify(r)).join("\n"));await assert.rejects(new ClaudeBackend().prepareEdit(h.opts),/сжат|истори/iu);assert.equal(h.calls.length,0);
});
test("Claude native-history timeout blocks late SDK writes without mutating global env",async(t)=>{
 const h=await fixture("timeout");const before=process.env.CLAUDE_CONFIG_DIR;let captured;const timers=new Map();
 t.mock.method(globalThis,"setTimeout",cb=>{const timer={unref(){return this;}};timers.set(timer,cb);return timer;});t.mock.method(globalThis,"clearTimeout",timer=>timers.delete(timer));
 let entered;const forkEntered=new Promise(resolve=>{entered=resolve;});
 h.fork=async(_id,o)=>{captured=o;entered();return new Promise(()=>{});};const p=new ClaudeBackend().prepareEdit(h.opts);
 await Promise.race([forkEntered,p.then(()=>assert.fail("preparation completed before the timeout"))]);assert.ok(captured);[...timers.values()][0]();await assert.rejects(p,/60|врем/iu);
 await assert.rejects(captured.sessionStore.append({sessionId:forkId},[]),/60|врем/iu);assert.equal(process.env.CLAUDE_CONFIG_DIR,before);assert.equal(timers.size,0);
});

test("Claude refuses a replaced project directory before copying retained context outside its pinned store",async()=>{
 const h=await fixture("directory-swap");const original=h.fork;const outside=join(h.cwd,"outside");await mkdir(outside);
 const moved=join(h.cwd,"original-store");const before=await readFile(h.path,"utf8");
 h.fork=(id,o)=>original(id,{...o,sessionStore:{...o.sessionStore,async load(key){
  const rows=await o.sessionStore.load(key);await rename(h.projectDir,moved);await symlink(outside,h.projectDir,"dir");return rows;
 }}});
 await assert.rejects(new ClaudeBackend().prepareEdit(h.opts));
 assert.equal(await readFile(join(moved,`${sourceId}.jsonl`),"utf8"),before);
 for(const entry of await readdir(outside))assert.equal(await readFile(join(outside,entry),"utf8"),"","rejected copies must not contain retained transcript bytes");
});

test("Claude refuses a hardlinked source transcript before invoking the native fork",async()=>{
 const h=await fixture("source-hardlink");const outside=join(h.cwd,"outside.jsonl");await rename(h.path,outside);await link(outside,h.path);
 const before=await readFile(outside,"utf8");await assert.rejects(new ClaudeBackend().prepareEdit(h.opts));
 assert.equal(h.calls.length,0);assert.equal(await readFile(outside,"utf8"),before);
});

test("Claude refuses a symlinked source transcript before invoking the native fork",async()=>{
 const h=await fixture("source-symlink");const outside=join(h.cwd,"outside.jsonl");await rename(h.path,outside);await symlink(outside,h.path);
 const before=await readFile(outside,"utf8");await assert.rejects(new ClaudeBackend().prepareEdit(h.opts));
 assert.equal(h.calls.length,0);assert.equal(await readFile(outside,"utf8"),before);
});

test("Claude verifies an empty opened destination after a directory swap at file creation",async(t)=>{
 const h=await fixture("open-directory-swap");const outside=join(h.cwd,"outside");await mkdir(outside);
 const moved=join(h.cwd,"original-store");const before=await readFile(h.path,"utf8");const originalOpen=fsPromises.open;let swapped=false;
 const mock=t.mock.method(fsPromises,"open",async(path,...args)=>{
  if(path===join(h.projectDir,`${forkId}.jsonl`)){
   swapped=true;await rename(h.projectDir,moved);await symlink(outside,h.projectDir,"dir");
  }
  return originalOpen(path,...args);
 });syncBuiltinESMExports();
 try{
  await assert.rejects(new ClaudeBackend().prepareEdit(h.opts));assert.equal(swapped,true);
  assert.equal(await readFile(join(outside,`${forkId}.jsonl`),"utf8"),"","the redirected file must remain empty");
  assert.equal(await readFile(join(moved,`${sourceId}.jsonl`),"utf8"),before);
 }finally{mock.mock.restore();syncBuiltinESMExports();}
});

test("Claude refuses source replacement at open before reading through the file handle",async(t)=>{
 const h=await fixture("open-source-swap");const preserved=join(h.cwd,"original.jsonl");const outside=join(h.cwd,"outside.jsonl");
 await writeFile(outside,h.rows.map(r=>JSON.stringify(r)).join("\n"));const before=await readFile(h.path,"utf8");const originalOpen=fsPromises.open;let swapped=false;
 const mock=t.mock.method(fsPromises,"open",async(path,...args)=>{
  const file=await originalOpen(path,...args);
  if(path===h.path){swapped=true;await rename(h.path,preserved);await symlink(outside,h.path);}
  return file;
 });syncBuiltinESMExports();
 try{
  await assert.rejects(new ClaudeBackend().prepareEdit(h.opts));assert.equal(swapped,true);assert.equal(h.calls.length,0);
  assert.equal(await readFile(preserved,"utf8"),before);
 }finally{mock.mock.restore();syncBuiltinESMExports();}
});

nodeTest("Claude native edit fails closed without required platform file flags", { skip: safeHistoryFiles }, async () => {
 const h = await fixture("unsupported-file-flags");
 await assert.rejects(new ClaudeBackend().prepareEdit(h.opts));
 assert.equal(h.calls.length, 0, "unsupported platforms must not invoke a native fork");
 assert.deepEqual(await readdir(h.projectDir), [`${sourceId}.jsonl`]);
});
