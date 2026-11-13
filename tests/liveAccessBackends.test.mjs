import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn as spawnShell } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, beforeEach, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-live-backends-"));
const key = Symbol.for("agent-hub.live-backends");
const state = 'globalThis[Symbol.for("agent-hub.live-backends")]';
globalThis[key] = {};
after(async () => { delete globalThis[key]; await rm(temp, { recursive: true, force: true }); });
async function load(file, realBridge = false) {
  const outfile = join(temp, `${file}${realBridge ? "-real" : ""}.mjs`);
  await build({
    entryPoints: [fileURLToPath(new URL(`../src/agents/${file}.ts`, import.meta.url))], outfile,
    bundle: true, platform: "node", format: "esm",
    plugins: [{ name: "isolated-live-boundaries", setup(b) {
      b.onResolve({ filter: /^node:child_process$|^@anthropic-ai\/claude-agent-sdk$|^\.\.\/liveAccessEnvironment$/ }, ({ path }) => realBridge && path === "../liveAccessEnvironment" ? undefined : ({ path, namespace: "boundary" }));
      b.onLoad({ filter: /.*/, namespace: "boundary" }, ({ path }) => ({ contents:
        path === "node:child_process" ? `export const spawn=(...args)=>${state}.spawn(...args);` :
        path === "../liveAccessEnvironment" ? `export const createLiveAccessBridge=(...args)=>${state}.createBridge(...args);` :
        `export const query=(...args)=>${state}.query(...args);export const forkSession=()=>{throw new Error("unexpected fork")};`,
      }));
    } }],
  });
  return import(pathToFileURL(outfile).href);
}
const { CodexBackend } = await load("codexBackend");
const { CodexAppServerBackend } = await load("codexAppServerBackend");
const { ClaudeBackend } = await load("claudeBackend");
// Synthetic native children exercise the POSIX adapter branch on every CI OS.
// Dedicated Windows cases below independently assert the unsupported-refresh notice.
beforeEach((t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  t.after(() => Object.defineProperty(process, "platform", platform));
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } assert.fail("fixture did not reach expected boundary"); }
const collect = async (stream) => { const events = []; for await (const event of stream) events.push(event); return events; };
function fixture() {
  const fixture = { bridges: [], calls: [], order: [], controller: new AbortController() };
  fixture.channel = { current: { LIVE_BACKEND_FAKE: "fake-sensitive-initial" }, revision: 0 };
  fixture.opts = { cwd: temp, liveAccess: fixture.channel, extraEnv: { LIVE_BACKEND_FAKE: "fake-sensitive-initial", BASH_ENV: "old-metadata-path" },
    config: { model: "test-model", effort: "high", sandbox: "read-only", contextWindow: 0 },
    attachments: [{ path: join(temp, "image.png"), isImage: true }], signal: fixture.controller.signal,
    steer: {}, confirmTool: async () => ({ allow: false }), messageId: "message-identity" };
  globalThis[key] = {
    createBridge: async (channel) => {
      assert.strictEqual(channel, fixture.channel);
      const index = fixture.bridges.length;
      const bridge = { environment: { BASH_ENV: `/private/fake-${index}/bash-env.sh`, ZDOTDIR: `/private/fake-${index}`, AGENT_HUB_LIVE_HANDLE: "opaque-handle", AGENT_HUB_LIVE_CONTEXT: `/private/fake-${index}/context.md` },
        refreshCommand: `. '/private/fake-${index}/refresh.sh' || exit 1`, contextPath: `/private/fake-${index}/context.md`,
        dispose: async () => { fixture.order.push(`dispose:${index}`); },
      };
      fixture.bridges.push(bridge);
      return bridge;
    },
  };
  return fixture;
}
let nextPid = 9_000_000;
function routeSignals(t, children) {
  t.mock.method(process, "kill", (pid, signal) => {
    const child = children.find((child) => -child.pid === pid);
    assert.ok(child, "only synthetic owned process groups may be signalled");
    return child.kill(signal);
  });
}
function child(f, label = "native", delayedExit = false) {
  const child = new EventEmitter();
  child.pid = nextPid++;
  child.exitCode = null; child.signalCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.complete = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = 0; child.stdout.end(); child.emit("exit", 0); child.emit("close", 0); f.order.push(`exit:${label}`);
  };
  child.kill = () => { f.order.push(`signal:${label}`); if (!delayedExit) child.complete(); return true; };
  return child;
}
function execSuccess(f, c) {
  c.stdin = new Writable({ write(chunk, _encoding, done) { f.prompt = chunk.toString(); done(); }, final(done) {
    done(); setImmediate(() => { c.stdout.write('{"type":"turn.completed"}\n'); c.complete(); });
  } });
}
function appServer(f, c, onRequest) {
  const reply = (request, result) => c.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
  c.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(chunk.toString()); f.calls.push(request);
    if (onRequest?.(request, reply)) { done(); return; }
    if (request.method === "initialize") reply(request, {});
    if (["thread/start", "thread/resume", "thread/fork"].includes(request.method)) reply(request, { thread: { id: request.method === "thread/fork" ? "fork-thread" : "test-thread" }, model: "test-model" });
    if (request.method === "turn/start") { reply(request, { turn: { id: "test-turn" } }); setImmediate(() => {
      c.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "test-thread", turn: { id: "test-turn", status: "completed" } } }) + "\n"); c.complete();
    }); }
    done();
  } });
}
function assertMetadata(f, args, opts, bridge = f.bridges[0]) {
  assert.ok(bridge, "live bridge must be prepared before spawn");
  assert.equal(opts.env.BASH_ENV, bridge.environment.BASH_ENV);
  assert.equal(opts.env.AGENT_HUB_LIVE_HANDLE, "opaque-handle");
  assert.equal(opts.env.LIVE_BACKEND_FAKE, "fake-sensitive-initial", "preserve initial env baseline");
  assert.equal(args.includes("--disable"), true);
  assert.equal(args.includes("shell_snapshot"), true);
  assert.equal(JSON.stringify(args).includes("fake-sensitive"), false);
  assert.equal(process.env.LIVE_BACKEND_FAKE, undefined);
}

for (const [name, Backend] of [["exec", CodexBackend], ["app-server", CodexAppServerBackend]]) {
  test(`${name} prepares one bridge, preserves input/options, disables snapshot per process and disposes after exit`, { timeout: 5000 }, async () => {
    const f = fixture(), c = child(f);
    if (name === "exec") execSuccess(f, c); else appServer(f, c);
    globalThis[key].spawn = (command, args, options) => {
      assert.equal(command, "codex"); assert.equal(args[0], name); assertMetadata(f, args, options);
      if (name === "exec") { assert.equal(args.includes("test-model"), true); assert.equal(args.includes(f.opts.attachments[0].path), true); }
      return c;
    };
    const events = await collect(new Backend().start("work-no-secrets", f.opts));
    assert.equal(events.some((event) => event.kind === "result" && event.ok), true);
    assert.equal(f.bridges.length, 1);
    assert.deepEqual(f.order, ["exit:native", "dispose:0"]);
    assert.equal(JSON.stringify(f.calls).includes("fake-sensitive"), false);
    if (name === "exec") assert.equal(f.prompt, "work-no-secrets");
    else assert.equal(f.calls.find((request) => request.method === "turn/start").params.input[0].text, "work-no-secrets");
  });
  test(`${name} bridge initialization failure cannot spawn or send task`, async () => {
    const f = fixture(); let spawned = false;
    globalThis[key].createBridge = async () => { throw new Error("fake-sensitive-error"); };
    globalThis[key].spawn = () => { spawned = true; assert.fail("must not spawn"); };
    const events = await collect(new Backend().start("task", f.opts));
    assert.equal(spawned, false);
    assert.equal(events.some((event) => event.kind === "result" && !event.ok), true);
    assert.equal(JSON.stringify(events).includes("fake-sensitive-error"), false);
  });
  test(`${name} Windows reports unsupported shell refresh and keeps initial environment baseline`, async (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    t.after(() => Object.defineProperty(process, "platform", platform));
    const f = fixture(), c = child(f);
    if (name === "exec") execSuccess(f, c); else appServer(f, c);
    globalThis[key].spawn = (_command, args, options) => { assert.equal(args.includes("shell_snapshot"), false); assert.equal(options.env.LIVE_BACKEND_FAKE, "fake-sensitive-initial"); return c; };
    const events = await collect(new Backend().start("task", f.opts));
    assert.equal(f.bridges.length, 0);
    assert.equal(events.some((event) => event.kind === "notice" && /Windows|PowerShell/i.test(event.text)), true);
  });
  test(`${name} setup exceptions after spawn still stop its child before disposing the bridge`, async (t) => {
    const f = fixture(), c = child(f);
    routeSignals(t, [c]);
    if (name === "exec") c.stdin.write = () => { throw new Error("fixture closed stdin"); };
    else c.stderr = null;
    globalThis[key].spawn = () => c;
    try { await collect(new Backend().start("task", f.opts)); } catch (error) { assert.match(String(error), /fixture closed stdin/); }
    assert.deepEqual(f.order, ["signal:native", "exit:native", "dispose:0"]);
  });
}

test("Claude adds a Bash-only metadata refresh hook without permission decisions and preserves existing hooks", { timeout: 5000 }, async () => {
  const f = fixture(); let options;
  globalThis[key].query = (request) => {
    options = request.options;
    assert.equal(options.env.BASH_ENV, f.bridges[0].environment.BASH_ENV);
    assert.ok(options.hooks.UserPromptSubmit); assert.ok(options.hooks.PostModelSwitch);
    return (async function* () {
      const submitted = await request.prompt[Symbol.asyncIterator]().next();
      assert.equal(JSON.stringify(submitted).includes("fake-sensitive"), false);
      const hook = options.hooks.PreToolUse.find((hook) => hook.matcher === "Bash").hooks[0];
      const toolInput = { command: "printf fixture", timeout: 1000, description: "test" };
      const output = await hook({ tool_name: "Bash", tool_input: toolInput });
      assert.deepEqual(output, { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...toolInput, command: f.bridges[0].refreshCommand + "\n" + toolInput.command } } });
      assert.equal("permissionDecision" in output.hookSpecificOutput, false);
      assert.equal(JSON.stringify(output).includes("fake-sensitive"), false);
      f.channel.current = { LIVE_BACKEND_FAKE: "fake-sensitive-rotated" };
      const next = await hook({ tool_name: "Bash", tool_input: toolInput });
      assert.deepEqual(next, output, "commands retain metadata only; broker resolves newest channel snapshot");
      assert.deepEqual(await hook({ tool_name: "Read", tool_input: { file_path: "fixture" } }), {});
      yield { type: "result", subtype: "success" };
    })();
  };
  const events = await collect(new ClaudeBackend().start("work-no-secrets", f.opts));
  assert.equal(events.some((event) => event.kind === "result" && event.ok), true);
  assert.equal(f.bridges.length, 1); assert.deepEqual(f.order, ["dispose:0"]);
  assert.equal(process.env.LIVE_BACKEND_FAKE, undefined);
});

test("Claude query construction failure still clears steering and disposes metadata bridge", async () => {
  const f = fixture();
  globalThis[key].query = () => { throw new Error("fixture query failed"); };
  await assert.rejects(collect(new ClaudeBackend().start("task", f.opts)), /fixture query failed/);
  assert.equal(f.opts.steer.handler, undefined);
  assert.deepEqual(f.order, ["dispose:0"]);
});

test("Claude bridge initialization failure never starts a query or leaks failure details", async () => {
  const f = fixture(); let queried = false;
  globalThis[key].createBridge = async () => { throw new Error("fake-sensitive-error"); };
  globalThis[key].query = () => { queried = true; assert.fail("must not query"); };
  const events = await collect(new ClaudeBackend().start("task", f.opts));
  assert.equal(queried, false);
  assert.equal(events.some((event) => event.kind === "result" && !event.ok), true);
  assert.equal(JSON.stringify(events).includes("fake-sensitive-error"), false);
});

for (const [name, Backend] of [["exec", CodexBackend], ["app-server", CodexAppServerBackend]]) {
  test(`${name} consumer exit retains bridge until owned child cleanup confirms exit`, { timeout: 5000 }, async (t) => {
    const f = fixture(), c = child(f, "native", true);
    routeSignals(t, [c]);
    if (name === "app-server") appServer(f, c);
    let spawned = false;
    globalThis[key].spawn = () => { spawned = true; return c; };
    const run = new Backend().start("task", f.opts)[Symbol.asyncIterator]();
    const next = run.next();
    await until(() => spawned);
    if (name === "exec") c.stdout.write('{"type":"turn.started"}\n');
    assert.equal((await next).done, false);
    const returned = run.return();
    await until(() => f.order.includes("signal:native"));
    assert.equal(f.order.some((entry) => entry.startsWith("dispose:")), false);
    c.complete(); await returned;
    assert.deepEqual(f.order, ["signal:native", "exit:native", "dispose:0"]);
  });
}

for (const [name, Backend] of [["exec", CodexBackend], ["app-server", CodexAppServerBackend], ["Claude", ClaudeBackend]]) {
  test(`${name} abort during bridge setup disposes it without starting native work`, async () => {
    const f = fixture(); let release, entered = false;
    const create = globalThis[key].createBridge;
    globalThis[key].createBridge = async (channel) => { entered = true; await new Promise((resolve) => { release = resolve; }); return create(channel); };
    globalThis[key].spawn = () => assert.fail("cancelled launch must not spawn");
    globalThis[key].query = () => assert.fail("cancelled launch must not query");
    const running = collect(new Backend().start("task", f.opts));
    await until(() => entered); f.controller.abort(); release();
    assert.deepEqual(await running, []);
    assert.deepEqual(f.order, ["dispose:0"]);
  });
}

test("app-server fallback cleans its original child before exec and disposes each bridge after its child", { timeout: 5000 }, async (t) => {
  const f = fixture(), server = child(f, "server"), exec = child(f, "exec");
  routeSignals(t, [server, exec]);
  appServer(f, server, (request) => {
    if (request.method !== "initialize") return false;
    server.stdout.write(JSON.stringify({ id: request.id, error: { code: -32601, message: "old protocol" } }) + "\n"); return true;
  });
  execSuccess(f, exec);
  let spawns = 0;
  globalThis[key].spawn = (_command, args, options) => {
    const isExec = spawns++ > 0;
    assertMetadata(f, args, options, f.bridges[isExec ? 1 : 0]);
    if (isExec) assert.equal(f.order.includes("exit:server"), true);
    return isExec ? exec : server;
  };
  const events = await collect(new CodexAppServerBackend().start("task", f.opts));
  assert.equal(events.some((event) => event.kind === "result" && event.ok), true);
  assert.equal(f.bridges.length, 2);
  assert.deepEqual(f.order, ["signal:server", "exit:server", "exit:exec", "dispose:1", "dispose:0"]);
});

test("resume timeout retains one bridge across verified ready fork recovery without another resume", { timeout: 5000 }, async (t) => {
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const originalTimer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => originalTimer(callback, delay === 60_000 ? 10 : delay, ...args));
  const f = fixture(); f.opts.resumeSessionId = "original-thread";
  const children = []; routeSignals(t, children);
  const source = [{ id: "saved-turn", status: "completed", items: [] }];
  let spawns = 0;
  globalThis[key].spawn = (_command, args, options) => {
    const role = spawns++ === 0 ? "original" : "recovery";
    const c = child(f, role);
    children.push(c);
    assertMetadata(f, args, options);
    appServer(f, c, (request, reply) => {
      if (request.method === "thread/resume") { assert.equal(role, "original"); return true; }
      if (request.method === "thread/turns/list") { reply(request, { data: source, nextCursor: null }); return true; }
      if (request.method === "thread/fork") { reply(request, { thread: { id: "ready-fork", status: { type: "idle" } }, model: "ready-model" }); return true; }
      if (request.method === "turn/start") {
        assert.equal(role, "recovery"); assert.equal(request.params.threadId, "ready-fork");
        reply(request, { turn: { id: "live-task" } });
        setImmediate(() => { c.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "ready-fork", turn: { id: "live-task", status: "completed" } } }) + "\n"); c.complete(); }); return true;
      }
      return false;
    });
    return c;
  };
  const events = await collect(new CodexAppServerBackend().start("task", f.opts));
  assert.equal(events.some((event) => event.kind === "result" && event.ok), true);
  assert.equal(f.bridges.length, 1); assert.equal(spawns, 2);
  assert.equal(f.calls.filter((request) => request.method === "thread/resume").length, 1);
  assert.equal(f.calls.filter((request) => request.method === "turn/start").length, 1);
  assert.deepEqual(f.order, ["signal:original", "exit:original", "exit:recovery", "dispose:0"]);
});

test("Claude early consumer exit closes the SDK query before removing its bridge", async () => {
  const f = fixture();
  globalThis[key].query = () => {
    const stream = (async function* () { try { yield { type: "result", subtype: "success" }; } finally { f.order.push("query-finished"); } })();
    stream.close = () => { f.order.push("close-query"); };
    return stream;
  };
  const run = new ClaudeBackend().start("task", f.opts)[Symbol.asyncIterator]();
  assert.equal((await run.next()).value.kind, "result"); await run.return();
  assert.deepEqual(f.order, ["query-finished", "close-query", "dispose:0"]);
  assert.equal(f.opts.steer.handler, undefined);
});

test("legacy Claude launches preserve hooks and do not create a bridge or Bash input rewrite", async () => {
  const f = fixture(); delete f.opts.liveAccess;
  globalThis[key].query = ({ options }) => {
    assert.equal(options.hooks.PreToolUse, undefined);
    assert.ok(options.hooks.UserPromptSubmit); assert.ok(options.hooks.PostModelSwitch);
    return (async function* () { yield { type: "result", subtype: "success" }; })();
  };
  await collect(new ClaudeBackend().start("task", f.opts));
  assert.equal(f.bridges.length, 0);
});

test("Claude awaits the SDK query's async cleanup after closing before disposing bootstrap files", async () => {
  const f = fixture();
  globalThis[key].query = () => ({
    [Symbol.asyncIterator]: () => (async function* () { yield { type: "result", subtype: "success" }; })(),
    close: () => { f.order.push("close-query"); },
    return: async () => { await tick(); f.order.push("query-cleanup"); return { done: true }; },
  });
  await collect(new ClaudeBackend().start("task", f.opts));
  assert.deepEqual(f.order, ["close-query", "query-cleanup", "dispose:0"]);
});

test("Claude's actual Bash prefix fetches add, rotation and deletion after a stale shell snapshot", { timeout: 10000, skip: process.platform === "win32" }, async () => {
  const outfile = join(temp, "channel.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/liveAccessEnvironment.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
  const { createLiveAccessChannel } = await import(pathToFileURL(outfile).href);
  const { ClaudeBackend: RealBridgeClaude } = await load("claudeBackend", true);
  const f = fixture(); f.opts.liveAccess = createLiveAccessChannel({ LIVE_BACKEND_FAKE: "fake-initial" });
  delete f.opts.extraEnv.BASH_ENV;
  let bootstrap;
  globalThis[key].query = ({ options }) => {
    bootstrap = options.env.BASH_ENV;
    return (async function* () {
      const hook = options.hooks.PreToolUse[0].hooks[0];
      for (const [snapshot, expected] of [[{ LIVE_BACKEND_FAKE: "fake-added-🗝-'$`", LIVE_BACKEND_NEW: "fake-new" }, "fake-added-🗝-'$`|fake-new"], [{ LIVE_BACKEND_FAKE: "fake-rotated" }, "fake-rotated|missing"], [{}, "missing|missing"]]) {
        await f.opts.liveAccess.update(snapshot);
        const rewrite = await hook({ tool_name: "Bash", tool_input: { command: "printf '%s|%s' \"${LIVE_BACKEND_FAKE-missing}\" \"${LIVE_BACKEND_NEW-missing}\"" } });
        const command = "export LIVE_BACKEND_FAKE=fake-stale-snapshot\n" + rewrite.hookSpecificOutput.updatedInput.command;
        const result = await new Promise((resolve, reject) => {
          const child = spawnShell("/bin/bash", ["-c", command], { env: options.env, stdio: ["ignore", "pipe", "pipe"] });
          let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
          child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
        });
        assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, expected);
        assert.equal(rewrite.hookSpecificOutput.updatedInput.command.includes("fake-rotated"), false);
      }
      yield { type: "result", subtype: "success" };
    })();
  };
  await collect(new RealBridgeClaude().start("task", f.opts));
  const { stat } = await import("node:fs/promises");
  await assert.rejects(stat(bootstrap), { code: "ENOENT" });
  assert.equal(process.env.LIVE_BACKEND_FAKE, undefined);
});
