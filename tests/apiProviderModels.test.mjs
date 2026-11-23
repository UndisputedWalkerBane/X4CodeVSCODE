import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = await mkdtemp(join(tmpdir(), "agent-hub-models-"));
after(() => rm(dir, { recursive: true, force: true }));
const outfile = join(dir, "models.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/apiProviderModels.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm" });
const { fetchApiModelIds, isValidApiModelId, apiEffortLevels } = await import(pathToFileURL(outfile));
const key = "fake-test-credential";

async function endpoint(t, handle) {
  const server = createServer(handle);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return "http://127.0.0.1:" + server.address().port;
}

test("list fetches the bound base path, filters unsafe model IDs and keeps distinct IDs in provider order", async t => {
  let visits = 0;
  const baseUrl = await endpoint(t, (req, res) => {
    visits++;
    assert.equal(req.url, "/gateway/v1/models");
    assert.equal(req.headers.authorization, "Bearer " + key);
    res.end(JSON.stringify({ data: ["org/m:1", "alpha", "org/m:1", null, key, "x\ny", "x".repeat(300)].map(id => ({ id })) }));
  });
  assert.deepEqual(await fetchApiModelIds({ baseUrl:baseUrl + "/gateway/v1/", apiKey:key }), ["org/m:1","alpha"]);
  assert.equal(visits, 1);
});

test("model discovery refuses redirects and bounds both declared and streamed sizes", async t => {
  let forwarded = false;
  const destination = await endpoint(t, (_req,res) => { forwarded = true; res.end(); });
  const baseUrl = await endpoint(t, (req,res) => {
    if (req.url.startsWith("/redirect/")) res.writeHead(302, { location: destination }).end();
    else if (req.url.startsWith("/denied/")) res.writeHead(401).end(key);
    else if (req.url.startsWith("/declared/")) res.writeHead(200, { "content-length": 5000000 }).end();
    else { res.write(" ".repeat(600000)); res.end(" ".repeat(600000)); }
  });
  for (const variant of ["redirect","denied","declared","streamed"]) {
    await assert.rejects(fetchApiModelIds({ baseUrl: baseUrl + "/" + variant, apiKey:key }), err => !String(err).includes(key));
  }
  assert.equal(forwarded, false);
});

test("Responses effort levels match the chosen Abliteration model", () => {
  assert.deepEqual(apiEffortLevels("abliteration", "abliterated-model"), ["none","minimal","low","medium","high","xhigh"]);
  assert.deepEqual(apiEffortLevels("abliteration", "abliterated-model-large-v2"), ["low","high","max"]);
  assert.deepEqual(apiEffortLevels("abliteration", "abliterated-model-large-flash"), ["none","low","high","max"]);
  assert.deepEqual(apiEffortLevels("abliteration", "abliterated-model-large"), ["none","high","max"]);
  assert.ok(isValidApiModelId("org/model.v2:7b"));
  for (const v of [null,"","   ","m\rheader","a".repeat(257)]) assert.equal(isValidApiModelId(v), false);
});

test("simultaneous opens share a request only within the same endpoint, profile and credential", async t => {
  const requests = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let ready;
  const arrived = new Promise(resolve => { ready = resolve; });
  const baseUrl = await endpoint(t, async (req, res) => {
    requests.push(req.headers.authorization);
    if (requests.length === 2) ready();
    await gate;
    res.end(JSON.stringify({ data: [{ id: req.headers.authorization === "Bearer " + key ? "first" : "second" }] }));
  });
  const profile = { id: "shared", baseUrl, apiKey: key };
  const calls = [fetchApiModelIds(profile), fetchApiModelIds(profile), fetchApiModelIds({ ...profile, apiKey: "rotated" })];
  await arrived;
  release();
  assert.deepEqual(await Promise.all(calls), [["first"], ["first"], ["second"]]);
  assert.equal(requests.length, 2);
  await fetchApiModelIds(profile);
  assert.equal(requests.length, 3);
});
