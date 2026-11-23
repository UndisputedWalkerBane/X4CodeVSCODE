import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { renderAbliterationCatalog } from "../resources/abliterationCatalog.mjs";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-model-catalog-test-"));
after(() => rm(temp, { recursive: true, force: true }));
const bundled = join(temp, "abliteration-models.json");
await writeFile(bundled, await renderAbliterationCatalog());
const fallback = JSON.parse(await readFile(bundled, "utf8"));
const outfile = join(temp, "launch.mjs");
const boundary = Symbol.for("agent-hub-test-debug-models");
after(() => { delete globalThis[boundary]; });
await build({
  entryPoints: [fileURLToPath(new URL("../src/agents/apiProviderLaunch.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm", define: { __dirname: JSON.stringify(temp) },
  plugins: [{ name: "catalog-probe", setup(b) {
    b.onResolve({ filter: /^node:child_process$/ }, ({ path }) => ({ path, namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
      contents: 'export const execFile = (...args) => globalThis[Symbol.for("agent-hub-test-debug-models")](...args);',
    }));
  } }],
});
const { codexLaunch, withCodexInferenceLaunch } = await import(pathToFileURL(outfile).href);
const textModel = "abliterated-model-large-v2";
const large = "abliterated-model-large";
const flash = large + "-flash";
const opts = {
  cwd: temp, signal: new AbortController().signal,
  config: { model: textModel, contextWindow: 0, apiProvider: {
    id: "abliteration", name: "Fixture", baseUrl: "https://example.test/v1", apiKey: "fixture-key",
  } },
  extraEnv: { CATALOG_FIXTURE: "local" },
};
function probe(t, source, onStart) {
  let calls = 0;
  globalThis[boundary] = (command, args, options, callback) => {
    calls++;
    assert.equal(command, "codex");
    const launch = codexLaunch(opts.config, opts.extraEnv);
    assert.deepEqual(args, ["debug", "models", ...launch.args.filter(a => a !== "--strict-config")]);
    assert.equal(options.cwd, opts.cwd);
    assert.deepEqual(options.env, launch.env);
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(options.timeout > 0 && options.timeout <= 30_000);
    assert.ok(options.maxBuffer >= 1024 * 1024 && options.maxBuffer <= 32 * 1024 * 1024);
    const child = execFile(process.execPath, ["-e", source], options, callback);
    onStart?.();
    return child;
  };
  t.after(() => { delete globalThis[boundary]; });
  return () => calls;
}
function getPath(launch) {
  const arg = launch.args.find(a => a.startsWith("model_catalog_json="));
  return arg && JSON.parse(arg.slice("model_catalog_json=".length));
}
async function* inspect(launch) {
  const path = getPath(launch);
  yield { path, mode: (await stat(path)).mode & 0o777, data: JSON.parse(await readFile(path, "utf8")) };
}
const entry = (data, slug) => data.models.find(m => m.slug === slug);
const writeCatalog = catalog => 'process.stdout.write(' + JSON.stringify(JSON.stringify(catalog)) + ')';
const removed = path => assert.rejects(stat(path), { code: "ENOENT" });

test("history, native providers, unrestricted and unknown models retain the caller catalog", async () => {
  assert.equal(getPath(codexLaunch(opts.config)), undefined);
  for (const config of [
    { ...opts.config, model: flash }, { ...opts.config, model: large + "-future" },
    { ...opts.config, apiProvider: { ...opts.config.apiProvider, id: "other" } }, { contextWindow: 0 },
  ]) {
    async function* collect(launch) { yield getPath(launch); }
    assert.deepEqual(await Array.fromAsync(withCodexInferenceLaunch({ ...opts, config }, collect)), [undefined]);
  }
});

test("overlays exact and inherited text models while retaining other native metadata and modalities", async t => {
  const other = { slug: "unrelated", input_modalities: ["audio"], private_metadata: { k: "v" } };
  const parent = { slug: large, model_messages: { instructions_template: "project instructions" },
    input_modalities: ["text", "image"], display_name: "Custom display", support_verbosity: true };
  const base = { slug: "abliterated-model", input_modalities: ["text"], context_window: 12345 };
  const original = { source: "effective", models: [other, base, parent] };
  const calls = probe(t, writeCatalog(original));
  const [a, b] = await Promise.all([1, 2].map(() => Array.fromAsync(withCodexInferenceLaunch(opts, inspect))));
  assert.equal(calls(), 2);
  assert.notEqual(a[0].path, b[0].path);
  assert.notEqual(a[0].path, bundled);
  if (process.platform !== "win32") assert.equal(a[0].mode, 0o600);
  assert.equal(a[0].data.source, original.source);
  assert.deepEqual(a[0].data.models.slice(0, 3), [other, base, { ...parent, input_modalities: ["text"] }]);
  assert.deepEqual(entry(a[0].data, textModel), { ...parent, slug: textModel, input_modalities: ["text"] });
  assert.deepEqual(entry(a[0].data, flash), { ...parent, slug: flash });
  assert.deepEqual(a[0].data, b[0].data);
  await Promise.all([removed(a[0].path), removed(b[0].path)]);
});

test("preserves an explicitly restricted flash and uses packaged instructions only for genuinely unknown slugs", async t => {
  const restricted = { slug: flash, input_modalities: ["text"], base_instructions: "flash-specific" };
  const custom = { slug: textModel, input_modalities: ["text", "image"], base_instructions: "v2-specific", priority: 3 };
  probe(t, writeCatalog({ models: [restricted, custom] }));
  const [result] = await Array.fromAsync(withCodexInferenceLaunch(opts, inspect));
  assert.deepEqual(entry(result.data, flash), restricted);
  assert.deepEqual(entry(result.data, textModel), { ...custom, input_modalities: ["text"] });
  assert.deepEqual(entry(result.data, large), entry(fallback, large));
});

test("only a missing debug models command permits the bundled fallback", async t => {
  probe(t, 'console.error("error: unrecognized subcommand \'models\'"); process.exitCode = 2');
  const [result] = await Array.fromAsync(withCodexInferenceLaunch(opts, inspect));
  assert.deepEqual(result.data, fallback);
  await removed(result.path);
});

for (const [reason, source] of [
  ["config error", 'console.error("failed to load secret-fixture.config"); process.exitCode = 2'],
  ["a nested error quoting a CLI diagnostic", 'console.error("configuration error\\nerror: unrecognized subcommand \'models\'"); process.exitCode = 2'],
  ["invalid JSON", 'console.log("secret-fixture")'],
  ["invalid catalog entry", writeCatalog({ models: [null] })],
]) {
  test(reason + " stops inference without exposing probe output", async t => {
    probe(t, source);
    await assert.rejects(Array.fromAsync(withCodexInferenceLaunch(opts, inspect)), error =>
      /каталог/i.test(error.message) && !error.message.includes("secret-fixture"));
  });
}

test("consumer failure and early return both remove their private file", async t => {
  probe(t, writeCatalog({ models: [] }));
  let path;
  async function* fail(launch) { path = getPath(launch); throw new Error("consumer failed"); }
  await assert.rejects(Array.fromAsync(withCodexInferenceLaunch(opts, fail)), /consumer failed/);
  await removed(path);
  const it = withCodexInferenceLaunch(opts, inspect);
  const first = await it.next();
  await it.return();
  await removed(first.value.path);
});

test("fallback reuses the outer catalog and leaves cleanup to its owner", async t => {
  const calls = probe(t, writeCatalog({ models: [] }));
  async function* useFallback(owner) {
    const [borrowed] = await Array.fromAsync(withCodexInferenceLaunch(opts, inspect, owner.catalogPath));
    assert.equal(borrowed.path, getPath(owner));
    assert.ok((await stat(borrowed.path)).isFile());
    yield borrowed.path;
  }
  const [path] = await Array.fromAsync(withCodexInferenceLaunch(opts, useFallback));
  assert.equal(calls(), 1);
  await removed(path);
});

test("aborting a pending catalog read cancels the probe before inference", async t => {
  const controller = new AbortController();
  const calls = probe(t, 'setTimeout(() => {}, 60_000)', () => controller.abort());
  const events = await Array.fromAsync(withCodexInferenceLaunch({ ...opts, signal: controller.signal }, inspect));
  assert.deepEqual(events, []);
  assert.equal(calls(), 1);
});

test("an aborted inference run removes the overlay after the child stops", async t => {
  probe(t, writeCatalog({ models: [] }));
  const controller = new AbortController();
  const options = { ...opts, signal: controller.signal };
  async function* child(launch) {
    yield getPath(launch);
    options.signal.throwIfAborted();
  }
  const it = withCodexInferenceLaunch(options, child);
  const first = await it.next();
  controller.abort();
  await assert.rejects(it.next(), { name: "AbortError" });
  await removed(first.value);
});
