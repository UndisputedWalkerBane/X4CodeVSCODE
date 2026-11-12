import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

// Bundle the actual backend with module-level process mocks. No source rewriting,
// real Codex processes, VS Code, network calls, or additional test dependencies.
const temp = await mkdtemp(join(tmpdir(), "agent-hub-backend-test-"));
const mockKey = Symbol.for("agent-hub.codex-backend-tests");
let current;
globalThis[mockKey] = {
  spawn: (...args) => {
    if (current.spawn) return current.spawn(...args);
    current.spawnArgs = args;
    return current.child;
  },
  execStart: (prompt, opts) => current.execCalls.push({ prompt, resumeSessionId: opts.resumeSessionId }),
  hardKill: (child) => {
    const h = child.harness;
    if (child.exitCode !== null || child.signalCode != null) return;
    h.kills++;
    child.exitCode = 0;
    child.emit("exit", 0);
  },
  stopCodex: async (child) => {
    const h = child.harness;
    if (h.stop) return h.stop(child);
    globalThis[mockKey].hardKill(child);
    return true;
  },
  stopStaleCodex: async () => current.staleCleanup,
  trackCodexProcess: (child) => current.processTracking.push({ child, writesAtTracking: current.writes.length }),
};
after(async () => {
  delete globalThis[mockKey];
  await rm(temp, { recursive: true, force: true });
});
const outfile = join(temp, "backend.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/agents/codexAppServerBackend.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  plugins: [{
    name: "mock-codex-process",
    setup(b) {
      b.onResolve({ filter: /^node:child_process$|^\.\/codexBackend$/ }, ({ path }) => ({ path, namespace: "mock" }));
      b.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
        contents: path === "node:child_process"
          ? 'export const spawn = (...args) => globalThis[Symbol.for("agent-hub.codex-backend-tests")].spawn(...args);'
          : `export class CodexBackend { async *start(prompt, opts) {
               globalThis[Symbol.for("agent-hub.codex-backend-tests")].execStart(prompt, opts);
               yield { kind: "notice", text: "mock exec fallback" };
               yield { kind: "result", ok: true };
             } }
             export const WRITER_CONFLICT_RE = /thread-store conflict/;
             export const codexDefaultModel = () => "test-model";
             export const hardKill = (child) => globalThis[Symbol.for("agent-hub.codex-backend-tests")].hardKill(child);
             export const stopCodex = (child) => globalThis[Symbol.for("agent-hub.codex-backend-tests")].stopCodex(child);
             export const stopStaleCodex = () => globalThis[Symbol.for("agent-hub.codex-backend-tests")].stopStaleCodex();
             export const trackCodexProcess = (child) => globalThis[Symbol.for("agent-hub.codex-backend-tests")].trackCodexProcess(child);
             export const killStaleCodex = () => false;
             export const trackCodex = () => {};
             export const untrackCodex = () => {};`,
      }));
    },
  }],
});
const { CodexAppServerBackend } = await import(pathToFileURL(outfile).href);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition) {
  for (let i = 0; i < 50; i++) {
    if (condition()) return;
    await tick();
  }
  assert.fail("mock app-server did not reach the expected state");
}

function fakeClock(t) {
  let now = 0;
  const timers = new Map();
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const timer = { unref() { return this; } };
    timers.set(timer, { callback, at: now + delay });
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => timers.delete(timer));
  return {
    get now() { return now; },
    get pending() { return timers.size; },
    advance(ms) {
      now += ms;
      for (const [timer, entry] of [...timers]) {
        if (entry.at > now) continue;
        timers.delete(timer);
        entry.callback();
      }
    },
  };
}

async function launch(t, { resume = false, start = true, waitFor = "turn", onInitialize, onThread, onEvent, config = {}, attachments, staleCleanup = true, messageId } = {}) {
  const h = {
    child: new EventEmitter(), writes: [], events: [], confirms: [], execCalls: [], processTracking: [], kills: 0, staleCleanup,
    done: false, thread: resume ? "resumed-main" : "main", turn: "main-turn", steer: {}, abort: new AbortController(),
  };
  current = h;
  h.child.harness = h;
  h.child.stdout = new PassThrough();
  h.child.stderr = new PassThrough();
  h.child.exitCode = null;
  h.send = (message) => h.child.stdout.write(JSON.stringify(message) + "\n");
  h.notify = (method, params) => h.send({ method, params });
  h.reply = (request, result) => h.send({ id: request.id, result });
  h.child.stdin = new Writable({
    write(chunk, encoding, callback) {
      const m = JSON.parse(chunk.toString());
      h.writes.push(m);
      if (m.method === "initialize") {
        if (onInitialize) onInitialize(m, h);
        else h.reply(m, {});
      }
      if (["thread/start", "thread/resume", "thread/fork"].includes(m.method)) {
        if (onThread) onThread(m, h);
        else h.reply(m, { thread: { id: h.thread }, model: "test-model" });
      }
      if (m.method === "turn/steer" || m.method === "turn/interrupt") h.reply(m, {});
      callback();
    },
  });
  h.turnRequests = () => h.writes.filter((m) => m.method === "turn/start");
  h.scope = (turn = h.turn) => ({ threadId: h.thread, turnId: turn });
  h.complete = (id = h.turn, status = "completed", threadId = h.thread) =>
    h.notify("turn/completed", { threadId, turn: { id, status, items: [], error: null } });
  h.acceptStart = (request = h.turnRequests().at(-1), id = h.turn) =>
    h.reply(request, { turn: { id, status: "inProgress", items: [] } });
  h.run = (async () => {
    for await (const event of new CodexAppServerBackend().start("work", {
      cwd: temp, config: { contextWindow: 0, ...config }, signal: h.abort.signal, attachments, messageId,
      steer: h.steer, ...(resume ? { resumeSessionId: h.thread } : {}),
      confirmTool: (...args) => {
        h.confirms.push(args);
        if (h.confirm) return h.confirm(...args);
        return Promise.resolve({ allow: true, answer: "answer" });
      },
    })) {
      h.events.push(event);
      onEvent?.(event, h);
    }
    h.done = true;
  })();
  t.after(async () => {
    h.releaseCleanup?.();
    h.complete();
    if (h.turnRequests().length > 0) h.acceptStart();
    await tick();
    if (!h.done) h.child.emit("exit", 0);
    await h.run;
  });
  await until(() => waitFor === "done" ? h.done : waitFor === "thread"
    ? h.writes.some((m) => m.method === "thread/start" || m.method === "thread/resume")
    : waitFor === "turn" ? h.turnRequests().length === 1 || h.done
      : h.writes.some((m) => m.method === waitFor) || h.done);
  if (start) {
    assert.equal(h.turnRequests().length, 1, "backend must start the requested task");
    h.acceptStart();
    await until(() => h.steer.handler);
    h.notify("turn/started", { threadId: h.thread, turn: { id: h.turn, status: "inProgress", items: [] } });
    await tick();
  }
  return h;
}

test("resuming long history omits stored turns from the startup response", async (t) => {
  const h = await launch(t, { resume: true });
  assert.equal(h.writes.find((m) => m.method === "thread/resume").params.excludeTurns, true);
  assert.deepEqual(h.events.filter((event) => event.kind === "session"), [{ kind: "session", sessionId: "resumed-main" }]);
});

for (const stage of ["initialize", "thread/start", "thread/fork", "turn/start"]) {
  test(`an unanswered ${stage} startup request fails within 60 seconds without replay`, async (t) => {
    const clock = fakeClock(t);
    const h = await launch(t, {
      resume: stage === "thread/resume" || stage === "thread/fork",
      start: false, waitFor: stage,
      onInitialize(request, h) { if (stage !== "initialize") h.reply(request, {}); },
      onThread(request, h) {
        if (request.method === stage) return;
        if (stage === "thread/fork" && request.method === "thread/resume") conflictReply(h, request);
        else h.reply(request, { thread: { id: h.thread } });
      },
    });
    assert.equal(clock.pending, 1, "only the unanswered startup request should retain a deadline");
    clock.advance(59_999);
    await tick();
    assert.equal(h.done, false);
    clock.advance(1);
    await until(() => h.done);
    assert.equal(h.events.filter((e) => e.kind === "result").length, 1);
    assert.equal(h.events.at(-1).ok, false);
    assert.match(h.events.find((e) => e.kind === "error").message, new RegExp(stage));
    assert.match(h.events.find((e) => e.kind === "error").message, /60|тайм|врем/iu);
    assert.equal(h.execCalls.length, 0, "a timeout must not automatically replay the prompt");
    assert.equal(h.turnRequests().length, stage === "turn/start" ? 1 : 0);
    assert.equal(h.kills, 1);
    assert.equal(clock.pending, 0, "timeout and cleanup must clear every deadline");
    // A late reply cannot revive the stopped request or start the task again.
    h.reply(h.writes.find((m) => m.method === stage), { thread: { id: "late" }, turn: { id: "late" } });
    await tick();
    assert.equal(h.turnRequests().length, stage === "turn/start" ? 1 : 0);
  });
}

test("completed startup clears deadlines while model, tools, approvals and steering can wait", async (t) => {
  const clock = fakeClock(t);
  const h = await launch(t);
  assert.equal(clock.pending, 0);
  let resolveConfirmation;
  h.confirm = () => new Promise((resolve) => { resolveConfirmation = resolve; });
  h.send({ id: 100, method: "item/commandExecution/requestApproval", params: { ...h.scope(), command: "long task" } });
  await until(() => resolveConfirmation);
  h.notify("item/started", { ...h.scope(), item: { id: "tool", type: "commandExecution", command: "long task" } });
  // Withhold the steering response; the running turn has no startup deadline.
  const write = h.child.stdin._write;
  h.child.stdin._write = (chunk, encoding, callback) => {
    const request = JSON.parse(chunk.toString());
    if (request.method === "turn/steer") { h.writes.push(request); callback(); }
    else write(chunk, encoding, callback);
  };
  const steering = h.steer.handler("more context", "next");
  clock.advance(10 * 60_000);
  await tick();
  assert.equal(h.done, false);
  assert.equal(h.kills, 0);
  assert.equal(clock.pending, 0);
  resolveConfirmation({ allow: true });
  h.reply(h.writes.find((m) => m.method === "turn/steer"), {});
  await steering;
  h.complete();
  await h.run;
  assert.equal(h.events.at(-1).ok, true);
  assert.equal(clock.pending, 0);
});

test("abort during an unanswered startup request settles immediately and clears cleanup timers", async (t) => {
  const clock = fakeClock(t);
  const h = await launch(t, { start: false, waitFor: "initialize", onInitialize() {} });
  h.abort.abort();
  await until(() => h.done);
  assert.equal(h.turnRequests().length, 0);
  assert.equal(h.execCalls.length, 0);
  assert.equal(h.kills, 1);
  assert.equal(clock.pending, 0);
});

for (const event of ["error", "exit"]) {
  test(`process ${event} clears unanswered startup deadlines`, async (t) => {
    const clock = fakeClock(t);
    const h = await launch(t, { start: false, waitFor: "initialize", onInitialize() {} });
    if (event === "error") h.child.emit("error", new Error("spawn failed"));
    else { h.child.exitCode = 1; h.child.emit("exit", 1); }
    await h.run;
    assert.equal(clock.pending, 0);
    assert.equal(h.turnRequests().length, 0);
  });
}

test("child completion leaves the generator and process alive until the main final answer", async (t) => {
  const h = await launch(t);
  h.notify("turn/started", { threadId: "child", turn: { id: "child-turn" } });
  h.complete("child-turn", "completed", "child");
  await tick();
  assert.equal(h.done, false, "child completion must not finish the main generator");
  assert.equal(h.kills, 0, "child completion must not kill app-server");
  assert.equal(h.events.some((e) => e.kind === "result"), false);
  h.notify("item/completed", { ...h.scope(), item: { id: "final", type: "agentMessage", text: "Итог ✅" } });
  h.complete();
  await h.run;
  assert.deepEqual(h.events.filter((e) => e.kind === "assistantText"), [{ kind: "assistantText", text: "Итог ✅" }]);
  assert.equal(h.events.filter((e) => e.kind === "result").length, 1);
  assert.equal(h.events.at(-1).ok, true);
  assert.equal(h.kills, 1);
});

test("foreign and unscoped notifications cannot alter text, context, errors, model or activity", async (t) => {
  const h = await launch(t);
  const before = structuredClone(h.events);
  for (const threadId of ["child", undefined, null, 42, ""]) {
    const scope = { threadId, turnId: h.turn };
    h.notify("turn/started", { threadId, turn: { id: "foreign" } });
    h.notify("item/started", { ...scope, item: { id: "same", type: "commandExecution", command: "child command" } });
    h.notify("item/agentMessage/delta", { ...scope, itemId: "answer", delta: "child text" });
    h.notify("item/completed", { ...scope, item: { id: "child-answer", type: "agentMessage", text: "child final" } });
    h.notify("thread/tokenUsage/updated", { ...scope, tokenUsage: { last: { totalTokens: 999 } } });
    h.notify("model/rerouted", { ...scope, fromModel: "one", toModel: "foreign-model" });
    h.notify("error", { ...scope, error: { message: "foreign error" } });
    h.notify("thread/compacted", scope);
  }
  await tick();
  assert.deepEqual(h.events, before);
  h.notify("item/started", { ...h.scope(), item: { id: "same", type: "subAgentActivity", agentPath: "/root/reviewer", kind: "completed" } });
  h.notify("item/agentMessage/delta", { ...h.scope(), itemId: "answer", delta: "main text" });
  await tick();
  assert.equal(h.events.some((e) => e.kind === "toolUse" && e.toolName === "subAgentActivity"), true);
  assert.deepEqual(h.events.filter((e) => e.kind === "textDelta"), [{ kind: "textDelta", text: "\n\n" }, { kind: "textDelta", text: "main text" }]);
  assert.equal(h.done, false);
});

test("a different main-thread turn cannot replace the active turn or complete it", async (t) => {
  const h = await launch(t);
  h.notify("turn/started", { threadId: h.thread, turn: { id: "old-turn" } });
  h.notify("item/agentMessage/delta", { ...h.scope("old-turn"), itemId: "old", delta: "old text" });
  h.complete("old-turn");
  h.notify("turn/completed", { threadId: h.thread, turn: { status: "completed" } });
  await tick();
  assert.equal(h.done, false);
  await h.steer.handler("уточнение", "next");
  assert.deepEqual(h.writes.find((m) => m.method === "turn/steer").params, {
    threadId: h.thread, expectedTurnId: h.turn, input: [{ type: "text", text: "уточнение" }],
  });
  assert.equal(h.events.some((e) => e.kind === "textDelta"), false);
});

test("early notifications are matched against turn/start response before they are emitted", async (t) => {
  const h = await launch(t, { start: false, resume: true });
  h.complete("old-turn");
  h.notify("turn/started", { threadId: h.thread, turn: { id: h.turn } });
  h.notify("item/agentMessage/delta", { ...h.scope(), itemId: "early", delta: "early answer" });
  h.complete();
  await tick();
  assert.equal(h.done, false);
  assert.equal(h.kills, 0);
  h.acceptStart();
  await h.run;
  assert.deepEqual(h.events.filter((e) => e.kind === "textDelta"), [{ kind: "textDelta", text: "early answer" }]);
  assert.equal(h.events.at(-1).ok, true);
  assert.equal(h.events.filter((e) => e.kind === "result").length, 1);
  assert.equal(h.writes.find((m) => m.method === "thread/resume").params.threadId, h.thread);
});

test("interrupt/restart ignores old and child events and steers the replacement main turn", async (t) => {
  const h = await launch(t);
  await h.steer.handler("new instruction", "now");
  assert.deepEqual(h.writes.find((m) => m.method === "turn/interrupt").params, h.scope());
  h.complete(h.turn, "interrupted");
  await until(() => h.turnRequests().length === 2);
  h.complete(h.turn);
  h.notify("turn/started", { threadId: "child", turn: { id: "child-turn" } });
  h.complete("child-turn", "completed", "child");
  h.turn = "replacement-turn";
  h.notify("turn/started", { threadId: h.thread, turn: { id: h.turn } });
  h.notify("item/agentMessage/delta", { ...h.scope(), itemId: "new", delta: "replacement" });
  await tick();
  await assert.rejects(h.steer.handler("too early", "next"), /ход.*(завершён|запускается)/);
  h.acceptStart();
  await tick();
  assert.equal(h.done, false);
  await h.steer.handler("follow up", "next");
  assert.equal(h.writes.find((m) => m.method === "turn/steer").params.expectedTurnId, h.turn);
  h.complete("main-turn");
  await tick();
  assert.equal(h.done, false);
  h.complete();
  await h.run;
  assert.equal(h.events.filter((e) => e.kind === "result").length, 1);
  assert.equal(h.events.at(-1).ok, true);
});

test("foreign server requests receive explicit responses without main-thread confirmation", async (t) => {
  const h = await launch(t);
  const requests = [
    ["item/commandExecution/requestApproval", { command: "child command" }],
    ["item/fileChange/requestApproval", { grantRoot: "/child" }],
    ["item/tool/requestUserInput", { questions: [{ id: "q", question: "child question" }] }],
    ["item/permissions/requestApproval", {}],
  ];
  for (const [index, [method, params]] of requests.entries()) {
    h.send({ id: 100 + index, method, params: { threadId: "child", turnId: "child-turn", ...params } });
  }
  h.send({ id: 110, method: "item/commandExecution/requestApproval", params: { ...h.scope("old-turn"), command: "stale" } });
  h.send({ id: 111, method: "item/commandExecution/requestApproval", params: { command: "unscoped" } });
  await tick();
  assert.equal(h.confirms.length, 0);
  for (const id of [100, 101, 102, 103, 110, 111]) {
    const response = h.writes.find((m) => m.id === id && !m.method);
    assert.ok(response, `server request ${id} must receive a response`);
    assert.ok(response.error || response.result?.decision === "decline" || response.result?.answers || response.result?.permissions);
  }
  h.send({ id: 120, method: "item/commandExecution/requestApproval", params: { ...h.scope(), command: "main command" } });
  await tick();
  assert.equal(h.confirms.length, 1);
  assert.equal(h.confirms[0][1].command, "main command");
  assert.deepEqual(h.writes.find((m) => m.id === 120).result, { decision: "accept" });
});

test("an early main server request waits for the authoritative turn/start response", async (t) => {
  const h = await launch(t, { start: false });
  h.send({ id: 101, method: "item/tool/requestUserInput", params: {
    ...h.scope(), questions: [{ id: "q", question: "main question" }],
  } });
  await tick();
  assert.equal(h.confirms.length, 0);
  h.acceptStart();
  await until(() => h.writes.some((m) => m.id === 101 && !m.method));
  assert.equal(h.confirms.length, 1);
  assert.deepEqual(h.writes.find((m) => m.id === 101).result, { answers: { q: { answers: ["answer"] } } });
});

test("main notifications retain text deduplication, questions, tools, context and reroutes", async (t) => {
  const h = await launch(t);
  h.child.stdout.write("not json\n\n");
  h.notify("item/started", { ...h.scope(), item: { id: "reason", type: "reasoning" } });
  h.notify("item/started", { ...h.scope(), item: { id: "answer", type: "agentMessage" } });
  h.notify("item/agentMessage/delta", { ...h.scope(), itemId: "answer", delta: "Ответ ✅" });
  h.notify("item/completed", { ...h.scope(), item: { id: "answer", type: "agentMessage", text: "Ответ ✅" } });
  const tool = { id: "command", type: "commandExecution", command: "git status" };
  h.notify("item/started", { ...h.scope(), item: tool });
  h.notify("item/started", { ...h.scope(), item: tool });
  h.notify("item/started", { ...h.scope(), item: { id: "compact", type: "contextCompaction" } });
  h.notify("thread/tokenUsage/updated", { ...h.scope(), tokenUsage: { last: { totalTokens: 123 }, modelContextWindow: 456 } });
  h.notify("model/rerouted", { ...h.scope(), fromModel: "test-model", toModel: "fallback-model" });
  h.notify("error", { ...h.scope(), error: { message: "retryable" }, willRetry: true });
  h.notify("thread/compacted", { threadId: h.thread });
  h.notify("item/completed", { ...h.scope(), item: { id: "question", type: "agentMessage", questions: [
    { title: "Вариант?", options: ["Первый", { label: "Второй", description: "Детали" }, { label: "" }, null] },
    { question: "Ещё?" }, null,
  ] } });
  h.complete();
  await h.run;
  assert.deepEqual(h.events.filter((e) => e.kind === "textDelta"), [{ kind: "textDelta", text: "Ответ ✅" }]);
  assert.equal(h.events.some((e) => e.kind === "assistantText"), false);
  assert.equal(h.events.filter((e) => e.kind === "toolUse").length, 1);
  assert.deepEqual(h.events.find((e) => e.kind === "contextUsage"), { kind: "contextUsage", usedTokens: 123, maxTokens: 456 });
  assert.deepEqual(h.events.find((e) => e.kind === "model" && e.fallbackFrom), {
    kind: "model", model: "fallback-model", fallbackFrom: "test-model",
  });
  assert.deepEqual(h.events.find((e) => e.kind === "question").questions, [
    { title: "Вариант?", options: [{ label: "Первый" }, { label: "Второй", description: "Детали" }] },
    { title: "Ещё?", options: [] },
  ]);
  assert.equal(h.events.some((e) => e.kind === "notice" && e.text.includes("retryable")), true);
});

test("main failed completion emits its error and one unsuccessful result", async (t) => {
  const h = await launch(t);
  h.notify("error", { ...h.scope(), error: { message: "main error" }, willRetry: false });
  h.notify("turn/completed", { threadId: h.thread, turn: { id: h.turn, status: "failed", error: { message: "failure" } } });
  await h.run;
  assert.deepEqual(h.events.filter((e) => e.kind === "error"), [
    { kind: "error", message: "main error" }, { kind: "error", message: "failure" },
  ]);
  assert.equal(h.events.filter((e) => e.kind === "result").length, 1);
  assert.equal(h.events.at(-1).ok, false);
  assert.equal(h.kills, 1);
});

test("start failure settles queued server requests and returns an unsuccessful result", async (t) => {
  const h = await launch(t, { start: false });
  h.send({ id: 100, method: "item/commandExecution/requestApproval", params: { ...h.scope(), command: "early" } });
  h.send({ id: h.turnRequests()[0].id, error: { code: -32603, message: "start failed" } });
  await h.run;
  await tick();
  assert.equal(h.confirms.length, 0);
  assert.equal(h.events.at(-1).ok, false);
  assert.equal(h.events.some((e) => e.kind === "error" && e.message.includes("start failed")), true);
  assert.equal(h.writes.find((m) => m.id === 100).error.code, -32602);
});

test("restart start failure ends once with the continuation error", async (t) => {
  const h = await launch(t);
  await h.steer.handler("restart", "now");
  h.complete(h.turn, "interrupted");
  await until(() => h.turnRequests().length === 2);
  h.send({ id: h.turnRequests()[1].id, error: { code: -32603, message: "restart failed" } });
  await h.run;
  assert.equal(h.events.filter((e) => e.kind === "result").length, 1);
  assert.equal(h.events.at(-1).ok, false);
  assert.equal(h.events.some((e) => e.kind === "error" && e.message.includes("restart failed")), true);
});

test("confirmations resolved after restart cannot approve or continue the previous turn", async (t) => {
  const h = await launch(t);
  const resolveConfirmations = [];
  h.confirm = () => new Promise((resolve) => resolveConfirmations.push(resolve));
  const requests = [
    ["item/commandExecution/requestApproval", { command: "old command" }],
    ["item/fileChange/requestApproval", { grantRoot: "/old" }],
    ["item/tool/requestUserInput", { questions: [{ id: "q1", question: "Old question" }, { id: "q2", question: "Must not open" }] }],
  ];
  requests.forEach(([method, params], i) => h.send({ id: 100 + i, method, params: { ...h.scope(), ...params } }));
  await until(() => resolveConfirmations.length === 3);
  await h.steer.handler("restart", "now");
  h.complete(h.turn, "interrupted");
  await until(() => h.turnRequests().length === 2);
  h.turn = "replacement-turn";
  h.acceptStart();
  await tick();
  resolveConfirmations.forEach((resolve) => resolve({ allow: true, answer: "stale answer" }));
  await tick();
  assert.equal(h.confirms.length, 3, "the second old question must not open");
  await until(() => h.writes.filter((m) => m.id >= 100 && !m.method).length >= 3);
  for (const id of [100, 101, 102]) {
    assert.equal(h.writes.find((m) => m.id === id).error?.code, -32602, "stale confirmation must be rejected");
  }
});

test("confirmation resolved after abort cannot approve the cancelled turn", async (t) => {
  const h = await launch(t);
  let resolveConfirmation;
  h.confirm = () => new Promise((resolve) => { resolveConfirmation = resolve; });
  h.send({ id: 100, method: "item/commandExecution/requestApproval", params: { ...h.scope(), command: "pending" } });
  await until(() => resolveConfirmation);
  h.abort.abort();
  resolveConfirmation({ allow: true });
  await until(() => h.writes.some((m) => m.id === 100 && !m.method));
  assert.equal(h.writes.find((m) => m.id === 100).error?.code, -32602);
  h.complete(h.turn, "interrupted");
  await h.run;
});

for (const method of ["item/commandExecution/requestApproval", "item/tool/requestUserInput"]) {
  test(`a late ${method} response after closed stdin cannot reject outside the completed run`, async t => {
    const h = await launch(t);
    let resolveConfirmation;
    h.confirm = () => new Promise(resolve => { resolveConfirmation = resolve; });
    const details = method === "item/tool/requestUserInput"
      ? { questions: [{ id: "q", question: "Pending answer" }] } : { command: "pending" };
    h.send({ id: 100, method, params: { ...h.scope(), ...details } });
    await until(() => resolveConfirmation);
    h.child.stdin.destroy();
    h.child.exitCode = 1;
    h.child.emit("exit", 1);
    await h.run;
    resolveConfirmation({ allow: true, answer: "late answer" });
    await tick();
    await tick();
    assert.equal(h.writes.some(message => message.id === 100 && !message.method), false);
    assert.equal(h.events.filter(event => event.kind === "result").length, 1);
    assert.equal(h.events.at(-1).ok, false);
  });
}

test("a failed live confirmation response ends the run with one reported failure", async t => {
  const h = await launch(t);
  let resolveConfirmation;
  h.confirm = () => new Promise(resolve => { resolveConfirmation = resolve; });
  h.send({ id: 100, method: "item/commandExecution/requestApproval", params: { ...h.scope(), command: "pending" } });
  await until(() => resolveConfirmation);
  h.child.stdin.destroy();
  resolveConfirmation({ allow: true });
  await h.run;
  assert.equal(h.events.filter(event => event.kind === "result").length, 1);
  assert.equal(h.events.at(-1).ok, false);
  assert.ok(h.events.some(event => event.kind === "error" && /не удалось ответить/u.test(event.message)));
  assert.equal(h.kills, 1);
});

test("abort between confirmation continuation and JSON-RPC write rejects the approval", async (t) => {
  const h = await launch(t);
  let resolveConfirmation;
  const confirmation = new Promise((resolve) => { resolveConfirmation = resolve; });
  h.confirm = () => confirmation;
  h.send({ id: 100, method: "item/commandExecution/requestApproval", params: { ...h.scope(), command: "pending" } });
  await until(() => h.confirms.length === 1);
  // The backend's await resumes first; this reaction then aborts before the
  // outer handleServerRequest(...).then(write) continuation can send accept.
  confirmation.then(() => h.abort.abort());
  resolveConfirmation({ allow: true });
  await until(() => h.writes.some((m) => m.id === 100 && !m.method));
  assert.equal(h.writes.find((m) => m.id === 100).error?.code, -32602);
  h.complete(h.turn, "interrupted");
  await h.run;
});

const writerConflict = "thread-store conflict: writer already active";
const conflictReply = (h, request, message = writerConflict) => h.send({ id: request.id, error: { code: -32603, message } });

test("resume writer conflict forks stored history and starts the prompt once in the new session", async (t) => {
  const h = await launch(t, {
    resume: true,
    config: { model: "gpt-6-astra", effort: "high", sandbox: "read-only", contextWindow: 123 },
    attachments: [{ path: "/test/image.png", isImage: true }],
    onThread(request, h) {
      if (request.method === "thread/resume") conflictReply(h, request);
      if (request.method === "thread/fork") {
        h.thread = "forked-main";
        h.reply(request, { thread: { id: h.thread, forkedFromId: "resumed-main" }, model: "gpt-6-astra" });
      }
    },
  });
  assert.deepEqual(h.spawnArgs[1], ["app-server", "--listen", "stdio://"]);
  assert.equal(h.execCalls.length, 0);
  const forks = h.writes.filter((m) => m.method === "thread/fork");
  assert.equal(forks.length, 1);
  assert.deepEqual(forks[0].params, {
    threadId: "resumed-main", cwd: temp, model: "gpt-6-astra", sandbox: "read-only", approvalPolicy: "never", excludeTurns: true,
  });
  assert.deepEqual(h.events.filter((e) => e.kind === "session"), [{ kind: "session", sessionId: "forked-main", forkedFromSessionId: "resumed-main" }]);
  const notice = h.events.findIndex((e) => e.kind === "notice" && /отдельн.*тред|отдельн.*ветк/iu.test(e.text));
  assert.ok(notice >= 0, "recovery must explain that continuation uses a separate thread");
  assert.match(h.events[notice].text, /истори/iu);
  assert.ok(notice < h.events.findIndex((e) => e.kind === "session"));
  assert.equal(h.turnRequests().length, 1);
  assert.deepEqual(h.turnRequests()[0].params, {
    threadId: "forked-main", effort: "high", input: [{ type: "text", text: "work" }, { type: "localImage", path: "/test/image.png" }],
  });
  const before = structuredClone(h.events);
  h.notify("item/agentMessage/delta", { threadId: "resumed-main", turnId: h.turn, itemId: "old", delta: "original text" });
  h.complete(h.turn, "completed", "resumed-main");
  await tick();
  assert.deepEqual(h.events, before);
  assert.equal(h.done, false);
  assert.equal(h.kills, 0);
  h.notify("item/completed", { ...h.scope(), item: { type: "agentMessage", id: "final", text: "Fork final" } });
  h.complete();
  await h.run;
  assert.equal(h.events.find((e) => e.kind === "assistantText").text, "Fork final");
  assert.equal(h.events.at(-1).ok, true);
});

for (const [label, forkResult] of [
  ["missing", {}], ["empty", { thread: { id: "" } }], ["whitespace", { thread: { id: "   " } }],
  ["same", { thread: { id: "resumed-main" } }], ["invalid", { thread: { id: 42 } }],
]) {
  test(`fork recovery rejects ${label} thread id without sending a task or exec fallback`, async (t) => {
    const h = await launch(t, {
      resume: true, start: false, waitFor: "thread",
      onThread(request, h) {
        if (request.method === "thread/resume") conflictReply(h, request);
        if (request.method === "thread/fork") h.reply(request, forkResult);
      },
    });
    await h.run;
    assert.equal(h.writes.filter((m) => m.method === "thread/fork").length, 1);
    assert.equal(h.turnRequests().length, 0);
    assert.equal(h.execCalls.length, 0);
    assert.equal(h.events.some((e) => e.kind === "session"), false);
    assert.equal(h.events.some((e) => e.kind === "error"), true);
    assert.equal(h.events.at(-1).ok, false);
  });
}

test("fork writer conflict fails clearly without recursion or another backend", async (t) => {
  const h = await launch(t, {
    resume: true, start: false, waitFor: "thread", onThread: (request, h) => conflictReply(h, request),
  });
  await h.run;
  assert.equal(h.writes.filter((m) => m.method === "thread/resume").length, 1);
  assert.equal(h.writes.filter((m) => m.method === "thread/fork").length, 1);
  assert.equal(h.turnRequests().length, 0);
  assert.equal(h.execCalls.length, 0);
  assert.match(h.events.find((e) => e.kind === "error").message, /не удалось.*(тред|ветк)/iu);
  assert.equal(h.events.at(-1).ok, false);
});

test("a non-conflict resume error retains the existing exec fallback", async (t) => {
  const h = await launch(t, {
    resume: true, start: false, waitFor: "thread", onThread: (request, h) => conflictReply(h, request, "unsupported thread/resume"),
  });
  await h.run;
  assert.equal(h.writes.some((m) => m.method === "thread/fork"), false);
  assert.deepEqual(h.execCalls, [{ prompt: "work", resumeSessionId: "resumed-main" }]);
  assert.equal(h.events.at(-1).ok, true);
});

for (const during of ["resume", "fork"]) {
  test(`abort during ${during} recovery never sends a new task`, async (t) => {
    const h = await launch(t, {
      resume: true, start: false, waitFor: "thread",
      onThread(request, h) {
        if (request.method === `thread/${during}`) h.abort.abort();
        if (request.method === "thread/resume") conflictReply(h, request);
        if (request.method === "thread/fork") h.reply(request, { thread: { id: "forked-main" } });
      },
    });
    await h.run;
    assert.equal(h.writes.filter((m) => m.method === "thread/fork").length, during === "fork" ? 1 : 0);
    assert.equal(h.turnRequests().length, 0);
    assert.equal(h.execCalls.length, 0);
    assert.equal(h.events.some((e) => e.kind === "session"), false);
  });
}

test("abort when the fork notice is shown prevents sending the new task", async (t) => {
  const h = await launch(t, {
    resume: true, start: false, waitFor: "thread",
    onThread(request, h) {
      if (request.method === "thread/resume") conflictReply(h, request);
      if (request.method === "thread/fork") h.reply(request, { thread: { id: "forked-main" } });
    },
    onEvent(event, h) { if (event.kind === "notice") h.abort.abort(); },
  });
  await h.run;
  assert.equal(h.writes.filter((m) => m.method === "thread/fork").length, 1);
  assert.equal(h.turnRequests().length, 0);
  assert.equal(h.execCalls.length, 0);
});

test("a writer conflict after turn/start never forks or replays the prompt", async (t) => {
  const h = await launch(t, { resume: true, start: false });
  conflictReply(h, h.turnRequests()[0]);
  await h.run;
  assert.equal(h.writes.some((m) => m.method === "thread/fork"), false);
  assert.equal(h.turnRequests().length, 1);
  assert.equal(h.execCalls.length, 0);
  assert.equal(h.events.at(-1).ok, false);
});

test("backend completion waits for its child cleanup promise", async (t) => {
  const h = await launch(t);
  let stopRequested = false;
  h.stop = () => {
    stopRequested = true;
    return new Promise((resolve) => {
      h.releaseCleanup = () => {
        h.child.exitCode = 0;
        h.child.emit("exit", 0);
        resolve(true);
      };
    });
  };
  h.complete();
  await until(() => stopRequested);
  assert.equal(h.events.at(-1).kind, "result");
  assert.equal(h.done, false, "the generator must retain ownership until cleanup resolves");
  assert.equal(h.child.exitCode, null);
  h.releaseCleanup();
  await h.run;
  assert.equal(h.done, true);
});

test("failed cleanup of a previous owned process prevents spawning another child", async (t) => {
  const h = await launch(t, { resume: true, start: false, waitFor: "done", staleCleanup: false });
  assert.equal(h.spawnArgs, undefined);
  assert.equal(h.processTracking.length, 0);
  assert.equal(h.writes.length, 0);
  assert.equal(h.execCalls.length, 0);
  assert.equal(h.events.some((e) => e.kind === "error"), true);
  assert.equal(h.events.at(-1).ok, false);
});

test("the owned app-server is tracked before its thread handshake completes", async (t) => {
  let threadRequest;
  const h = await launch(t, {
    resume: true, start: false, waitFor: "thread",
    onThread(request) { threadRequest = request; },
  });
  assert.deepEqual(h.processTracking, [{ child: h.child, writesAtTracking: 0 }]);
  assert.equal(h.turnRequests().length, 0);
  h.reply(threadRequest, { thread: { id: h.thread } });
  await until(() => h.turnRequests().length === 1);
  h.acceptStart();
  await until(() => h.steer.handler);
  h.complete();
  await h.run;
});

test("ordinary Codex prompt captures only authoritative turn/start response ID", async (t) => {
 const h=await launch(t,{start:false,messageId:"host-user-uuid"});
 h.notify("turn/started",{threadId:h.thread,turn:{id:"unrelated",status:"inProgress",items:[]}});
 h.acceptStart(undefined,"authoritative");await until(()=>h.events.some(e=>e.kind==="nativePrompt"));
 assert.deepEqual(h.events.find(e=>e.kind==="nativePrompt"),{kind:"nativePrompt",messageId:"host-user-uuid",anchor:{provider:"codex",sessionId:h.thread,turnId:"authoritative"}});
 h.complete("authoritative");await h.run;
});

async function launchResumeRecovery(t, { onRequest, onStop, onEvent, source = [{ id: "saved-one", status: "completed", items: [] }], config = {}, attachments, extraEnv, messageId } = {}) {
  const h = current = { children: [], writes: [], calls: [], events: [], lifecycle: [], execCalls: [], processTracking: [], kills: 0, staleCleanup: true, abort: new AbortController(), steer: {}, confirms: [], done: false, source, sourceBefore: structuredClone(source) };
  h.send = (child, message) => child.stdout.write(JSON.stringify(message) + "\n");
  h.reply = (child, request, result) => h.send(child, { id: request.id, result });
  h.stop = async child => {
    if (child.exitCode !== null) return true;
    h.lifecycle.push(`stop:${child.role}`);
    if (onStop && (await onStop(child, h)) === false) return false;
    child.exitCode = 0; child.emit("exit", 0); return true;
  };
  h.spawn = (...args) => {
    const role = ["original", "recovery"][h.children.length] ?? "unexpected";
    const child = new EventEmitter(); Object.assign(child, { harness: h, role, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, spawnArgs: args, forkReady: false });
    h.children.push(child); h.lifecycle.push(`spawn:${role}`);
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString()); h.writes.push(request); h.calls.push({ role, request }); callback();
      if (onRequest?.(role, request, h, child)) return;
      if (request.method === "initialize") h.reply(child, request, {});
      if (role === "recovery" && request.method === "thread/turns/list") h.reply(child, request, { data: source, nextCursor: null });
      if (role === "recovery" && request.method === "thread/read") h.reply(child, request, { thread: { id: request.params.threadId, status: { type: "idle" }, turns: source } });
      if (role === "recovery" && request.method === "thread/fork") {
        child.forkReady = true;
        h.reply(child, request, { thread: { id: "verified-fork", status: { type: "idle" } }, model: "server-chosen-model" });
      }
      if (role !== "original" && request.method === "thread/resume") {
        h.send(child, { id: request.id, error: { code: -32000, message: "a ready fork must not be resumed again" } });
      }
      if (request.method === "turn/start") {
        h.lifecycle.push(`task:${role}`);
        if (!child.forkReady || role !== "recovery") {
          h.send(child, { id: request.id, error: { code: -32000, message: "task must use the live fork connection" } }); return;
        }
        h.reply(child, request, { turn: { id: "new-task", status: "inProgress", items: [] } });
        setImmediate(() => h.send(child, { method: "turn/completed", params: { threadId: "verified-fork", turn: { id: "new-task", status: "completed", items: [] } } }));
      }
    } });
    return child;
  };
  h.options = {
    cwd: temp, resumeSessionId: "source-main", signal: h.abort.signal, config: { contextWindow: 0, ...config }, attachments, extraEnv, messageId, steer: h.steer,
    confirmTool: async (...args) => { h.confirms.push(args); return { allow: true, answer: "preserved" }; },
  };
  h.run = (async () => {
    try {
      for await (const event of new CodexAppServerBackend().start("original work 📌", h.options)) { h.events.push(event); onEvent?.(event, h); }
    } catch (err) { h.runError = err; }
    finally { h.done = true; }
  })();
  t.after(async () => { h.releaseCleanup?.(); h.abort.abort(); for (const child of h.children) if (child.exitCode === null) { child.exitCode = 0; child.emit("exit", 0); } await h.run; });
  await until(() => h.calls.some(c => c.role === "original" && c.request.method === "thread/resume"));
  return h;
}

const tasks = h => h.calls.filter(c => c.request.method === "turn/start");

for (const id of ["source-main", "", " ", 42, undefined]) {
  test(`recovered fork must provide a fresh valid ID instead of ${String(id)}`, async t => {
    const clock = fakeClock(t);
    const h = await launchResumeRecovery(t, {
      onRequest(role, request, h, child) {
        if (role === "recovery" && request.method === "thread/fork") {
          h.reply(child, request, { thread: { id } }); return true;
        }
      },
    });
    clock.advance(60_000); await until(() => h.done);
    assert.equal(tasks(h).length, 0);
    assert.equal(h.events.some(event => event.kind === "session"), false);
    assert.equal(h.events.at(-1).ok, false); assert.equal(h.execCalls.length, 0);
    assert.equal(h.children.length, 2); assert.equal(clock.pending, 0);
  });
}

test("resume timeout keeps the verified ready fork connection and starts the task exactly once without another resume", async t => {
  const clock = fakeClock(t);
  t.mock.method(Date, "now", () => clock.now);
  const attachments = [{ path: "/tmp/picture.png", isImage: true }, { path: "/tmp/info.txt", isImage: false }];
  const source = [{ id: "saved-one", status: "completed", items: [] }, { id: "saved-two", status: "interrupted", items: [] }, { id: "saved-three", status: "failed", items: [] }];
  const h = await launchResumeRecovery(t, { source, config: { model: "chosen-model", effort: "high", sandbox: "read-only" }, attachments, extraEnv: { TEST_RESUME_VALUE: "preserved" }, messageId: "host-user" });
  clock.advance(60_000); await until(() => h.done);
  assert.equal(h.runError, undefined);
  assert.deepEqual(h.lifecycle, ["spawn:original", "stop:original", "spawn:recovery", "task:recovery", "stop:recovery"]);
  assert.equal(tasks(h).length, 1); assert.equal(tasks(h)[0].role, "recovery");
  assert.deepEqual(tasks(h)[0].request.params, { threadId: "verified-fork", input: [{ type: "text", text: "original work 📌" }, { type: "localImage", path: "/tmp/picture.png" }], effort: "high" });
  const fork = h.calls.find(c => c.role === "recovery" && c.request.method === "thread/fork").request;
  assert.deepEqual(fork.params, { threadId: "source-main", lastTurnId: "saved-three", cwd: temp, model: "chosen-model", sandbox: "read-only", approvalPolicy: "never", excludeTurns: true });
  assert.equal(h.calls.filter(c => c.request.method === "thread/resume").length, 1, "a fork ACK already provides a usable thread");
  assert.ok(h.children.every(child => child.spawnArgs[2].env.TEST_RESUME_VALUE === "preserved"));
  assert.deepEqual(h.events.find(e => e.kind === "session"), { kind: "session", sessionId: "verified-fork", forkedFromSessionId: "source-main" });
  assert.deepEqual(h.events.find(e => e.kind === "model"), { kind: "model", model: "server-chosen-model" });
  assert.deepEqual(h.events.find(e => e.kind === "nativePrompt"), { kind: "nativePrompt", messageId: "host-user", anchor: { provider: "codex", sessionId: "verified-fork", turnId: "new-task" } });
  assert.match(h.events.find(e => e.kind === "notice").text, /истор/iu);
  assert.equal(h.events.filter(e => e.kind === "result").length, 1);
  assert.equal(h.events.at(-1).durationMs, 60_000, "duration includes the initial resume timeout");
  assert.equal(h.events.some(e => e.kind === "error"), false, "the old child's queued exit cannot leak into recovery");
  assert.equal(h.events.at(-1).ok, true); assert.equal(h.execCalls.length, 0); assert.equal(clock.pending, 0); assert.equal(h.steer.handler, undefined);
  assert.deepEqual(h.source, h.sourceBefore);
  const oldResume = h.calls.find(c => c.role === "original" && c.request.method === "thread/resume").request;
  h.reply(h.children[0], oldResume, { thread: { id: "late-old" } }); await tick(); assert.equal(tasks(h).length, 1);
});

test("resume recovery waits for original cleanup before fork and retains ownership through task cleanup", async t => {
  const clock = fakeClock(t); let stopping;
  const h = await launchResumeRecovery(t, { onStop(child, h) { stopping = child.role; return new Promise(resolve => { h.releaseCleanup = resolve; }); } });
  clock.advance(60_000); await until(() => stopping === "original");
  assert.equal(h.children.length, 1); assert.equal(tasks(h).length, 0);
  h.releaseCleanup(); await until(() => stopping === "recovery");
  assert.equal(h.children.length, 2); assert.equal(tasks(h).length, 1); assert.equal(h.done, false);
  h.releaseCleanup(); await until(() => h.done); assert.equal(h.events.at(-1).ok, true);
});

for (const stage of ["original-cleanup", "source-read", "fork", "verify-read", "notice", "session", "model"]) {
  test(`abort during resume recovery ${stage} prevents the new task`, async t => {
    const clock = fakeClock(t);
    const h = await launchResumeRecovery(t, {
      onStop(child, h) { if (stage === `${child.role}-cleanup`) h.abort.abort(); },
      onEvent(event, h) { if (["notice", "session", "model"].includes(stage) && event.kind === stage) h.abort.abort(); },
      onRequest(role, request, h) {
        if (role !== "recovery") return;
        if ((stage === "source-read" && request.method === "thread/turns/list" && request.params.threadId === "source-main") || (stage === "fork" && request.method === "thread/fork") || (stage === "verify-read" && request.method === "thread/turns/list" && request.params.threadId === "verified-fork")) { h.abort.abort(); return true; }
      },
    });
    clock.advance(60_000); await until(() => h.done);
    assert.equal(tasks(h).length, 0); assert.equal(h.execCalls.length, 0); assert.equal(clock.pending, 0);
    assert.equal(h.children.length, ["original-cleanup", "notice"].includes(stage) ? 1 : 2);
  });
}

test("abort during recovery task cleanup cannot replay the accepted task", async t => {
  const clock = fakeClock(t);
  const h = await launchResumeRecovery(t, { onStop(child, h) { if (child.role === "recovery") h.abort.abort(); } });
  clock.advance(60_000); await until(() => h.done);
  assert.equal(tasks(h).length, 1); assert.equal(h.children.length, 2); assert.equal(h.execCalls.length, 0); assert.equal(clock.pending, 0);
});

for (const failure of ["source-read", "fork", "mismatch", "original-cleanup", "recovery-cleanup", "fork-conflict", "verify-read"]) {
  test(`resume recovery ${failure} failure is terminal without another fork, exec or task replay`, async t => {
    const clock = fakeClock(t);
    const h = await launchResumeRecovery(t, {
      onStop(child) { if (failure === `${child.role}-cleanup`) return false; },
      onRequest(role, request, h, child) {
        if (role !== "recovery") return;
        if ((failure === "source-read" && request.method === "thread/turns/list") || (failure === "fork" && request.method === "thread/fork") || (failure === "verify-read" && request.method === "thread/turns/list" && request.params.threadId !== "source-main") || (failure === "fork-conflict" && request.method === "thread/fork")) {
          h.send(child, { id: request.id, error: { code: -32000, message: failure === "fork-conflict" ? "thread-store conflict" : "history failed" } }); return true;
        }
        if (failure === "mismatch" && request.method === "thread/turns/list" && request.params.threadId !== "source-main") { h.reply(child, request, { data: [], nextCursor: null }); return true; }
      },
    });
    clock.advance(60_000); await until(() => h.done);
    assert.equal(tasks(h).length, failure === "recovery-cleanup" ? 1 : 0); assert.equal(h.execCalls.length, 0); assert.equal(h.events.at(-1)?.ok, false);
    assert.equal(h.children.length, failure === "original-cleanup" ? 1 : 2, "the intended failure stage must actually be reached");
    assert.ok(h.calls.filter(c => c.request.method === "thread/fork").length <= 1);
    if (failure !== "recovery-cleanup") assert.equal(h.events.some(event => ["session", "model"].includes(event.kind)), false);
    assert.equal(clock.pending, 0); assert.deepEqual(h.source, h.sourceBefore);
  });
}

test("closed app-server stdin fails immediately and clears startup deadlines", async t => {
  const clock = fakeClock(t);
  const h = await launch(t, { resume: true, start: false, waitFor: "done", onInitialize(request, h) { h.reply(request, {}); h.child.stdin.destroy(); } });
  assert.equal(h.done, true);
  assert.equal(clock.pending, 0);
  assert.equal(h.turnRequests().length, 0);
  assert.equal(h.writes.some(request => request.method === "thread/resume"), false);
});

for (const stage of ["initialize", "source-read", "fork", "verify-read", "source-read-fallback", "verify-read-fallback", "turn/start"]) {
 test(`a second timeout at recovery ${stage} is terminal and stays bounded`, async t => {
  const clock = fakeClock(t);
  const method = ["source-read", "verify-read"].includes(stage) ? "thread/turns/list" : stage.endsWith("fallback") ? "thread/read" : stage === "fork" ? "thread/fork" : stage;
  const thread = stage.startsWith("source") ? "source-main" : "verified-fork";
  const h = await launchResumeRecovery(t, { onRequest(role, req, h, child) {
    if (role !== "recovery") return;
    if (stage.endsWith("fallback") && req.method === "thread/turns/list") { h.send(child, { id: req.id, error: { code: -32601, message: "method not found" } }); return true; }
    return req.method === method && (!stage.includes("read") || req.params.threadId === thread);
  } });
  clock.advance(60_000); await until(() => h.calls.some(c => c.role === "recovery" && c.request.method === method && (!stage.includes("read") || c.request.params.threadId === thread)));
  clock.advance(60_000); await until(() => h.done);
  assert.equal(h.events.at(-1).ok, false); assert.equal(h.execCalls.length, 0); assert.equal(tasks(h).length, stage === "turn/start" ? 1 : 0); assert.equal(h.children.length, 2); assert.equal(clock.pending, 0);
  assert.equal(h.calls.filter(c => c.request.method === "thread/resume").length, 1);
  if (stage === "turn/start") assert.match(h.events.find(e => e.kind === "error").message, /мог быть принят/iu);
 });
}


test("recovery verifies all paginated metadata before exposing lineage or accepting late original responses", async t => {
 const clock = fakeClock(t), source = ["one", "two", "three"].map(id => ({ id, status: "completed", items: [] }));
 const h = await launchResumeRecovery(t, { source, onRequest(role, request, h, child) {
  if (role !== "recovery" || request.method !== "thread/turns/list") return;
  assert.deepEqual({ ...request.params, cursor: undefined }, { threadId: request.params.threadId, sortDirection: "asc", itemsView: "notLoaded", limit: 100, cursor: undefined });
  if (request.params.threadId === "verified-fork" && request.params.cursor === "2") { h.verifyRequest = request; return true; }
  const index = Number(request.params.cursor ?? 0);
  h.reply(child, request, { data: [source[index]], nextCursor: index < 2 ? String(index + 1) : null }); return true;
 } });
 clock.advance(60_000); await until(() => h.verifyRequest);
 assert.equal(h.events.some(e => ["session", "model"].includes(e.kind)), false); assert.equal(tasks(h).length, 0);
 const old = h.calls.find(c => c.role === "original" && c.request.method === "thread/resume").request;
 h.reply(h.children[0], old, { thread: { id: "late-original" } });
 h.send(h.children[0], { method: "model/rerouted", params: { threadId: "source-main", turnId: "old", toModel: "late-model" } });
 await tick(); assert.equal(tasks(h).length, 0); assert.equal(h.events.some(e => ["session", "model"].includes(e.kind)), false);
 h.reply(h.children[1], h.verifyRequest, { data: [source[2]], nextCursor: null });
 await until(() => h.done);
 assert.equal(h.calls.filter(c => c.request.method === "thread/turns/list").length, 6);
 assert.equal(h.options.resumeSessionId, "source-main"); assert.deepEqual(h.source, h.sourceBefore);
 assert.equal(tasks(h).length, 1); assert.equal(h.events.at(-1).ok, true); assert.equal(clock.pending, 0);
});

for (const code of [-32601, -32000]) {
 test(`recovery falls back from metadata listing only on RPC code ${code}`, async t => {
  const clock = fakeClock(t);
  const h = await launchResumeRecovery(t, { onRequest(role, request, h, child) {
   if (role === "recovery" && request.method === "thread/turns/list") { h.send(child, { id: request.id, error: { code, message: "list unavailable" } }); return true; }
  } });
  clock.advance(60_000); await until(() => h.done);
  assert.equal(h.calls.filter(c => c.request.method === "thread/read").length, code === -32601 ? 2 : 0);
  assert.equal(tasks(h).length, code === -32601 ? 1 : 0); assert.equal(h.events.at(-1).ok, code === -32601);
  assert.equal(h.children.length, 2); assert.equal(clock.pending, 0);
 });
}

for (const where of ["fork-ack", "source-read", "fork-read"]) {
 test(`recovery rejects a known unready ${where} before exposing session or model`, async t => {
  const clock = fakeClock(t);
  const h = await launchResumeRecovery(t, { onRequest(role, request, h, child) {
   if (role !== "recovery") return;
   if (where === "fork-ack" && request.method === "thread/fork") { h.reply(child, request, { thread: { id: "verified-fork", status: { type: "notLoaded" } }, model: "unverified-model" }); return true; }
   if (where !== "fork-ack" && request.method === "thread/turns/list") { h.send(child, { id: request.id, error: { code: -32601, message: "old CLI" } }); return true; }
   if (request.method === "thread/read") {
    const unready = where === "source-read" ? request.params.threadId === "source-main" : request.params.threadId === "verified-fork";
    h.reply(child, request, { thread: { id: request.params.threadId, status: { type: unready ? "active" : "notLoaded" }, turns: h.source } }); return true;
   }
  } });
  clock.advance(60_000); await until(() => h.done);
  assert.equal(tasks(h).length, 0); assert.equal(h.events.some(e => ["session", "model"].includes(e.kind)), false);
  assert.equal(h.events.at(-1).ok, false); assert.equal(h.children.length, 2); assert.equal(h.execCalls.length, 0); assert.equal(clock.pending, 0);
 });
}

test("recovery applies YOLO configuration to the live fork and preserves the original start options", async t => {
 const clock = fakeClock(t);
 const h = await launchResumeRecovery(t, { config: { model: "chosen-model", yolo: true, sandbox: "read-only" } });
 clock.advance(60_000); await until(() => h.done);
 const fork = h.calls.find(c => c.request.method === "thread/fork").request;
 assert.equal(fork.params.sandbox, "danger-full-access"); assert.equal(fork.params.approvalPolicy, "never");
 assert.equal(fork.params.model, "chosen-model"); assert.equal(h.options.resumeSessionId, "source-main");
 assert.equal(h.options.config.sandbox, "read-only"); assert.equal(h.children.length, 2); assert.equal(h.events.at(-1).ok, true);
});

test("recovery preserves confirmation and steering callbacks on the fork connection", async t => {
 const clock = fakeClock(t);
 const h = await launchResumeRecovery(t, { onRequest(role, request, h, child) {
  if (role !== "recovery") return;
  if (request.method === "turn/start") {
   h.reply(child, request, { turn: { id: "new-task", status: "inProgress", items: [] } });
   h.send(child, { id: 800, method: "item/tool/requestUserInput", params: { threadId: "verified-fork", turnId: "new-task", questions: [{ id: "question", question: "Continue?", options: [] }] } });
   return true;
  }
  if (request.method === "turn/steer") { h.reply(child, request, {}); return true; }
 } });
 clock.advance(60_000); await until(() => h.calls.some(c => c.request.id === 800 && c.request.result));
 assert.deepEqual(h.confirms, [["AskUserQuestion", { questions: [{ question: "Continue?", options: [] }] }]]);
 assert.deepEqual(h.calls.find(c => c.request.id === 800 && c.request.result).request.result, { answers: { question: { answers: ["preserved"] } } });
 await h.steer.handler("follow up", "steer");
 assert.deepEqual(h.calls.find(c => c.request.method === "turn/steer").request.params, { threadId: "verified-fork", expectedTurnId: "new-task", input: [{ type: "text", text: "follow up" }] });
 h.send(h.children[1], { method: "turn/completed", params: { threadId: "verified-fork", turn: { id: "new-task", status: "completed", items: [] } } });
 await until(() => h.done);
 assert.equal(tasks(h).length, 1); assert.equal(h.events.at(-1).ok, true); assert.equal(h.steer.handler, undefined); assert.equal(clock.pending, 0);
});

test("closed recovery stdin cannot send a task or fall back to exec", async t => {
 const clock = fakeClock(t);
 const h = await launchResumeRecovery(t, { onRequest(role, request, h, child) {
  if (role === "recovery" && request.method === "thread/turns/list" && request.params.threadId === "verified-fork") {
   h.reply(child, request, { data: h.source, nextCursor: null }); child.stdin.destroy(); return true;
  }
 } });
 clock.advance(60_000); await until(() => h.done);
 assert.equal(tasks(h).length, 0); assert.equal(h.execCalls.length, 0); assert.equal(h.children.length, 2); assert.equal(h.events.at(-1).ok, false); assert.equal(clock.pending, 0);
});
