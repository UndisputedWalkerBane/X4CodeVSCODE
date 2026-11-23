import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-responses-"));
after(() => rm(temp, { recursive: true, force: true }));
const outfile = join(temp, "adapters.mjs");
const root = fileURLToPath(new URL("../src/agents", import.meta.url));
await build({ stdin: { contents: ["apiProviderLaunch", "codexBackend", "codexAppServerBackend"]
  .map(module => `export * from "./${module}";`).join("\n"), resolveDir: root },
  outfile, bundle: true, platform: "node", format: "esm" });
const { codexLaunch, CodexBackend, CodexAppServerBackend } = await import(pathToFileURL(outfile).href);
const credential = "fake-profile-key-for-tests";
const envKey = "AGENT_HUB_RESPONSES_API_KEY";
const model = "fixture-model";
const config = { contextWindow: 0, model, apiProvider: { id: "one", name: 'Fixture "Gateway"', baseUrl: "https://example.test/v1", apiKey: credential } };

test("provider overrides are private to the child and the native identity is endpoint-bound", () => {
  const profile = config.apiProvider;
  const original = process.env[envKey];
  const overrides = (fields) => codexLaunch({ ...config, apiProvider: { ...profile, ...fields } }, { LOCAL_ENV: "present", [envKey]: "inherited" });
  const launch = overrides({});
  assert.equal(launch.env[envKey], credential);
  assert.equal(launch.env.LOCAL_ENV, "present");
  assert.ok(!JSON.stringify([launch.thread, launch.args]).includes(credential));
  assert.ok(launch.args.includes(`shell_environment_policy.filters.${envKey}="exclude"`));
  assert.ok(launch.args.includes("web_search=\"disabled\""));
  assert.ok(launch.args.includes(`model_providers.${launch.thread.modelProvider}.supports_websockets=false`));
  assert.deepEqual(overrides({name:"renamed", baseUrl: profile.baseUrl + "/", apiKey:"rotated"}).thread, launch.thread);
  assert.notEqual(overrides({id:"two"}).thread.modelProvider, launch.thread.modelProvider);
  assert.notEqual(overrides({baseUrl:"https://example.test/v2"}).thread.modelProvider, launch.thread.modelProvider);
  assert.throws(() => overrides({baseUrl:"http://example.test/v1"}));
  assert.throws(() => overrides({apiKey:undefined}));
  assert.equal(overrides({baseUrl:"http://127.0.0.1:9000/v1", apiKey:undefined}).env[envKey], undefined);
  assert.equal(process.env[envKey], original);
  assert.deepEqual(codexLaunch({contextWindow:0}, { NATIVE_EXTRA:"yes" }).args, []);
});

// Run explicitly on a machine with Codex installed. Both the workspace and CLI home
// are temporary. The simulated provider is loopback-only and all credentials are fixtures.
test("installed Codex routes HTTP Responses turns and tool output to the selected profile", {
  skip: process.env.AGENT_HUB_TEST_CODEX_CLI !== "1", timeout: 90_000,
}, async t => {
  const home = join(temp, "home");
  const cwd = join(temp, "project");
  const codexHome = join(home, ".codex");
  await Promise.all([mkdir(codexHome, {recursive:true}), mkdir(cwd)]);
  const inherited = process.env;
  process.env = { PATH:inherited.PATH, HOME:home, CODEX_HOME:codexHome, TMPDIR:temp, SHELL:"/bin/sh",
    OPENAI_API_KEY:"fake-native-key", [envKey]:"stale-key-from-another-run" };
  t.after(() => { process.env = inherited; });
  await writeFile(join(codexHome,"auth.json"), JSON.stringify({OPENAI_API_KEY:"fake-saved-account-key", auth_mode:"apikey"}));
  await writeFile(join(codexHome,"config.toml"), '[shell_environment_policy]\ninherit = "all"\nignore_default_excludes = true\n');
  const requests = [];
  let sequence = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method !== "POST" || !req.url.endsWith("/responses")) { res.writeHead(404).end(); return; }
    const payload = JSON.parse(body);
    const calls = requests.filter(r => r.route === req.url);
    requests.push({ route:req.url, auth:req.headers.authorization, payload });
    if (req.url.startsWith("/reject/")) {
      res.writeHead(400, {"content-type":"application/json"});
      res.end(JSON.stringify({error:{message:"Invalid profile credential: " + credential}}));
      return;
    }
    const id = String(++sequence);
    const tool = payload.tools.find(entry => entry.name === "exec_command");
    const useTool = req.url.startsWith("/keyed/") && calls.length === 0 && !!tool;
    const text = `fixture reply ${id}`;
    const item = useTool
      ? {id:"fc_" + id, type:"function_call", name:"exec_command", call_id:"call_" + id, arguments:JSON.stringify({
        cmd:'if [ -z "${AGENT_HUB_RESPONSES_API_KEY+x}" ]; then echo KEY_ABSENT; else echo KEY_PRESENT; fi',
      })}
      : {id:"msg_" + id, type:"message", role:"assistant", status:"completed", content:[{type:"output_text", text, annotations:[]}]};
    const response = {id:"resp_" + id, object:"response", created_at:1, status:"completed", output:[item],
      usage:{input_tokens:10, output_tokens:3, total_tokens:13}};
    res.writeHead(200, {"content-type":"text/event-stream"});
    const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({type,...fields})}\n\n`);
    event("response.created", {response:{...response, status:"in_progress", output:[]}});
    event("response.output_item.added", {output_index:0, item:{...item, ...(useTool ? {arguments:""} : {content:[]})}});
    if (!useTool) event("response.output_text.delta", {item_id:item.id, output_index:0, content_index:0, delta:text});
    event("response.output_item.done", {output_index:0, item});
    event("response.completed", {response});
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const runConfig = (name, key) => ({ ...config, sandbox: "read-only",
    apiProvider: { ...config.apiProvider, baseUrl: `${base}/${name}/v1`, apiKey: key } });
  const run = async (backend, name, key, resumeSessionId) => {
    const events = [];
    for await (const event of backend.start("Reply with a fixture greeting.", {cwd, config:runConfig(name, key), resumeSessionId,
      messageId:"fixture-prompt", signal:AbortSignal.timeout(20_000), confirmTool:async () => ({allow:true})})) events.push(event);
    return events;
  };
  const collect = async (...args) => {
    const events = await run(...args);
    assert.ok(events.some(e => e.kind === "result" && e.ok), JSON.stringify(events));
    assert.ok(events.some(e => (e.kind === "assistantText" || e.kind === "textDelta") && e.text.includes("fixture reply")), JSON.stringify(events));
    return { sessionId: events.find(e => e.kind === "session").sessionId,
      anchor: events.find(e => e.kind === "nativePrompt")?.anchor };
  };
  const app = new CodexAppServerBackend();
  const exec = new CodexBackend();
  const first = await collect(app, "keyed", credential);
  const second = await collect(app, "keyed", credential, first.sessionId);
  assert.equal(second.sessionId, first.sessionId);
  const prepared = await app.prepareEdit({cwd, sessionId:first.sessionId, anchor:second.anchor,
    config:runConfig("keyed", credential), signal:AbortSignal.timeout(20_000)});
  assert.ok(prepared.resumeSessionId && prepared.resumeSessionId !== first.sessionId);
  await collect(exec, "keyed", credential, prepared.resumeSessionId);
  await collect(exec, "anonymous", undefined);
  assert.ok(requests.every(r => r.payload.model === model && r.payload.stream === true));
  assert.ok(requests.every(r => !r.payload.tools.some(tool => tool.type.includes("web_search"))));
  const keyed = requests.filter(r => r.route === "/keyed/v1/responses");
  assert.ok(keyed.length >= 3, JSON.stringify(keyed.map(r => r.payload.tools.map(t => t.name ?? t.type))));
  assert.ok(keyed.every(r => r.auth === "Bearer " + credential));
  assert.ok(keyed.some(r => r.payload.input.some(item => item.type === "function_call_output" && JSON.stringify(item.output).includes("KEY_ABSENT"))));
  assert.ok(keyed.every(r => !JSON.stringify(r.payload).includes(credential)));
  const anon = requests.filter(r => r.route === "/anonymous/v1/responses");
  assert.equal(anon.length, 1);
  assert.equal(anon[0].auth, undefined);
  for (const backend of [exec, app]) {
    const rejected = await run(backend, "reject", credential);
    assert.ok(rejected.some(e => e.kind === "error" && e.message.includes("Invalid profile credential")), JSON.stringify(rejected));
    assert.ok(rejected.some(e => e.kind === "result" && !e.ok));
    assert.ok(!JSON.stringify(rejected).includes(credential));
  }
});
