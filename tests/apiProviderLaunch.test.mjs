import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { renderAbliterationCatalog } from "../resources/abliterationCatalog.mjs";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-responses-"));
after(() => rm(temp, { recursive: true, force: true }));
const outfile = join(temp, "adapters.mjs");
await writeFile(join(temp, "abliteration-models.json"), await renderAbliterationCatalog());
const root = fileURLToPath(new URL("../src/agents", import.meta.url));
await build({ stdin: { contents: ["apiProviderLaunch", "codexBackend", "codexAppServerBackend"]
  .map(module => `export * from "./${module}";`).join("\n"), resolveDir: root },
  outfile, define: { __dirname: JSON.stringify(temp) }, bundle: true, platform: "node", format: "esm" });
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
  await writeFile(join(codexHome,"config.toml"), 'model_reasoning_effort = "medium"\n[shell_environment_policy]\ninherit = "all"\nignore_default_excludes = true\n');
  const requests = [];
  const image = join(cwd, "pixel.png");
  let sequence = 0;
  const hasInstructions = (payload, text) => payload.instructions?.includes(text) || payload.input.some(item =>
    item.role === "developer" && item.content?.some(part => part.type === "input_text" && part.text.includes(text)));

  const hasImage = payload => payload.input.some(item => [item.content, item.output].some(parts =>
    Array.isArray(parts) && parts.some(part => part.type === "input_image")));
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method !== "POST" || !req.url.endsWith("/responses")) { res.writeHead(404).end(); return; }
    const payload = JSON.parse(body);
    const calls = requests.filter(r => r.route === req.url);
    requests.push({ route:req.url, auth:req.headers.authorization, payload });
    if (req.url.startsWith("/media/") && hasImage(payload) && payload.model === "abliterated-model-large-v2") {
      res.writeHead(400, {"content-type":"application/json"});
      res.end(JSON.stringify({error:{code:"media_images_not_supported", message:"This model does not accept image inputs."}}));
      return;
    }
    if (req.url.startsWith("/reject/")) {
      res.writeHead(400, {"content-type":"application/json"});
      res.end(JSON.stringify({error:{message:"Invalid profile credential: " + credential}}));
      return;
    }
    const id = String(++sequence);
    let toolCall;
    if (calls.length === 0 && req.url.startsWith("/tool-media/")) {
      toolCall = {name:"view_image", arguments:JSON.stringify({path:image})};
    } else if (calls.length === 0 && req.url.startsWith("/keyed/") && payload.tools.some(entry => entry.name === "exec_command")) {
      toolCall = {name:"exec_command", arguments:JSON.stringify({
        cmd:'if [ -z "${AGENT_HUB_RESPONSES_API_KEY+x}" ]; then echo KEY_ABSENT; else echo KEY_PRESENT; fi',
      })};
    }
    const text = `fixture reply ${id}`;
    const item = toolCall
      ? {id:"fc_" + id, type:"function_call", call_id:"call_" + id, ...toolCall}
      : {id:"msg_" + id, type:"message", role:"assistant", status:"completed", content:[{type:"output_text", text, annotations:[]}]};
    const response = {id:"resp_" + id, object:"response", created_at:1, status:"completed", output:[item],
      usage:{input_tokens:10, output_tokens:3, total_tokens:13}};
    res.writeHead(200, {"content-type":"text/event-stream"});
    const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({type,...fields})}\n\n`);
    event("response.created", {response:{...response, status:"in_progress", output:[]}});
    event("response.output_item.added", {output_index:0, item:{...item, ...(toolCall ? {arguments:""} : {content:[]})}});
    if (!toolCall) event("response.output_text.delta", {item_id:item.id, output_index:0, content_index:0, delta:text});
    event("response.output_item.done", {output_index:0, item});
    event("response.completed", {response});
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const runConfig = (name, key) => ({ ...config, sandbox: "read-only",
    apiProvider: { ...config.apiProvider, baseUrl: `${base}/${name}/v1`, apiKey: key } });
  const run = async (backend, name, key, resumeSessionId, parameters, {prompt = "Reply with a fixture greeting."} = {}) => {
    const events = [];
    for await (const event of backend.start(prompt, {cwd, config:{ ...runConfig(name, key), ...parameters }, resumeSessionId,
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
  for (const backend of [app, exec]) {
    const thread = await collect(backend, "parameters", credential, undefined, { model: "abliterated-model", effort: "high" });
    assert.equal(requests.at(-1).payload.model, "abliterated-model");
    assert.equal(requests.at(-1).payload.reasoning?.effort, "high");
    await collect(backend, "parameters", credential, thread.sessionId, { model: "abliterated-model-large-v2", effort: "max" });
    assert.equal(requests.at(-1).payload.model, "abliterated-model-large-v2");
    assert.equal(requests.at(-1).payload.reasoning?.effort, "max");
    await collect(backend, "parameters", credential, thread.sessionId, { model: "abliterated-model-large-v2" });
    // Resetting the chat override restores this isolated CLI home's configured default.
    assert.equal(requests.at(-1).payload.reasoning?.effort, "medium");
    await collect(backend, "parameters", credential, thread.sessionId, { model: "abliterated-model", effort: "none" });
    assert.equal(requests.at(-1).payload.reasoning?.effort, "none");
  }
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAC0lEQVR4nGNgQAYAAA4AAamRc7EAAAAASUVORK5CYII=", "base64"));
  const apiProvider = { ...runConfig("media", credential).apiProvider, id: "abliteration" };
  const textModel = "abliterated-model-large-v2";
  const oldText = "Text alongside the original photo.";
  // Reproduce the previous launch exactly: same provider identity and text-only model,
  // without the model catalog that tells Codex how to present its native history.
  const legacy = codexLaunch({ ...config, model:"abliterated-model", apiProvider });
  const child = spawn("codex", ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", ...legacy.args,
    "-c", `model=${JSON.stringify(textModel)}`, "-i", image, "-"], {
    cwd, env:legacy.env, stdio:["pipe", "pipe", "ignore"], signal:AbortSignal.timeout(20_000),
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  const closed = once(child, "close");
  child.stdin.end(oldText);
  assert.notEqual((await closed)[0], 0);
  const failure = output.trim().split("\n").map(line => JSON.parse(line));
  assert.ok(failure.some(event => event.type === "turn.failed"));
  const legacyRequest = requests.at(-1).payload;
  assert.equal(legacyRequest.model, textModel);
  assert.ok(hasImage(legacyRequest), "legacy turn sent an image to the text-only model");
  const originalSession = failure.find(event => event.type === "thread.started").thread_id;
  for (const backend of [app, exec]) {
    const followup = "Continue with text only.";
    const previousRequests = requests.length;
    const resumed = await collect(backend, "media", credential, originalSession, {apiProvider, model:textModel, effort:"max"}, {prompt:followup});
    assert.equal(requests.length, previousRequests + 1, "a text turn must succeed on the first request");
    assert.equal(resumed.sessionId, originalSession);
    const body = requests.at(-1).payload;
    assert.equal(hasImage(body), false);
    const originalInstructions = "You are a coding agent running in the Codex CLI";
    assert.ok([legacyRequest, body].every(request => hasInstructions(request, originalInstructions)),
      "keep the original agent instructions");
    assert.equal(body.reasoning?.effort, "max");
    for (const value of [oldText, followup]) assert.ok(JSON.stringify(body.input).includes(value), "lost conversation text");
  }
  // Model changes must not delete the original attachment from the native thread.
  await collect(app, "media", credential, originalSession, {apiProvider, model:"abliterated-model-large-flash"});
  assert.ok(hasImage(requests.at(-1).payload));
  const toolProvider = { ...apiProvider, baseUrl: `${base}/tool-media/v1` };
  const toolHistory = await collect(app, "tool-media", credential, undefined, {apiProvider:toolProvider, model:"abliterated-model"});
  assert.ok(hasImage(requests.at(-1).payload), "view_image must put a real image in a tool result");
  await collect(app, "tool-media", credential, toolHistory.sessionId, {apiProvider:toolProvider, model:textModel});
  assert.equal(hasImage(requests.at(-1).payload), false, "strip images from old tool results too");

  // A user-supplied native model catalog may also carry agent instructions and tool settings.
  // Check a fresh thread: resumed threads may carry old instructions even with a wrong catalog.
  const customCatalog = join(codexHome, "local-models.json");
  const descriptor = JSON.parse(await renderAbliterationCatalog()).models.find(entry => entry.slug === textModel);
  const instructions = "Reply only to this synthetic catalog fixture.";
  const originalCatalog = JSON.stringify({models:[
    {...descriptor, base_instructions:instructions, input_modalities:["text", "image"]},
    {...descriptor, slug:"private-project-model", base_instructions:"Another local model."},
  ]});
  await writeFile(customCatalog, originalCatalog);
  const configPath = join(codexHome, "config.toml");
  await writeFile(configPath, `model_catalog_json = ${JSON.stringify(customCatalog)}\n` + await readFile(configPath, "utf8"));
  for (const backend of [app, exec]) {
    await collect(backend, "media", credential, undefined, {apiProvider, model:textModel, effort:"max"});
    assert.ok(hasInstructions(requests.at(-1).payload, instructions), "keep the user’s custom model instructions");
  }
  assert.equal(await readFile(customCatalog, "utf8"), originalCatalog);

  for (const backend of [exec, app]) {
    const rejected = await run(backend, "reject", credential);
    assert.ok(rejected.some(e => e.kind === "error" && e.message.includes("Invalid profile credential")), JSON.stringify(rejected));
    assert.ok(rejected.some(e => e.kind === "result" && !e.ok));
    assert.ok(!JSON.stringify(rejected).includes(credential));
  }
});
