import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, link, mkdtemp, readFile, readdir, rename, rm, stat, symlink, truncate, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-live-core-test-"));
after(() => rm(temp, { recursive: true, force: true }));
const outfile = join(temp, "live.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/liveAccessEnvironment.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
const { createLiveAccessChannel, createLiveAccessBridge } = await import(pathToFileURL(outfile).href);
const posixTest = process.platform === "win32" ? test.skip : test;
const shells = ["/bin/bash", "/bin/zsh"].filter(existsSync);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

function shell(command, environment, executable = "/bin/bash", flags = ["-c"]) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...flags, command], { env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function helper(bridge, extra = {}, denyIpc = false) {
  return new Promise((resolve, reject) => {
    const source = denyIpc
      ? 'require("node:net").connect = () => { const error = new Error("connect denied"); error.code = "EPERM"; throw error; }; require(process.argv[1]);'
      : 'require(process.argv[1]);';
    const child = spawn(process.execPath, ["-e", source, join(dirname(bridge.environment.BASH_ENV), "client.cjs")], {
      env: { ...process.env, ...bridge.environment, ...extra }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const readEnvironment = `${quote(process.execPath)} -e 'process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith("LIVE_TEST_")))))'`;
async function environment(bridge, executable, flags, inherited = {}) {
  const result = await shell(readEnvironment, { ...inherited, ...bridge.environment }, executable, flags);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("channel freezes copies, validates secret-free errors, serializes updates and recovers from listener failure", async () => {
  const original = { LIVE_TEST_A: "first" };
  const channel = createLiveAccessChannel(original, "public initial");
  original.LIVE_TEST_A = "outside";
  assert.deepEqual(channel.current, { LIVE_TEST_A: "first" });
  assert.equal(Object.isFrozen(channel.current), true);
  assert.equal(channel.revision, 0);
  const seen = [];
  const dispose = channel.subscribe(async (snapshot, revision) => {
    await new Promise((resolve) => setTimeout(resolve, revision === 1 ? 15 : 0));
    seen.push([revision, snapshot.LIVE_TEST_A]);
    if (revision === 1) throw new Error("observer failed");
  });
  const next = { LIVE_TEST_A: "second", LIVE_TEST_B: "new" };
  const first = channel.update(next, "public next");
  next.LIVE_TEST_A = "mutated while queued";
  const second = channel.update({ LIVE_TEST_C: "third" });
  await assert.rejects(first, /live access update/i);
  await second;
  assert.deepEqual(seen, [[1, "second"], [2, undefined]]);
  assert.deepEqual(channel.current, { LIVE_TEST_C: "third" });
  assert.deepEqual([...channel.ownedKeys].sort(), ["LIVE_TEST_A", "LIVE_TEST_B", "LIVE_TEST_C"]);
  assert.equal(channel.publicContext, "public next");
  dispose();
  await channel.update({});
  assert.equal(seen.length, 2);
  for (const name of ["BASHOPTS", "BASH_VERSINFO", "EUID", "PPID", "SHELLOPTS", "UID", "GID", "EGID", "ARGC", "HISTCMD", "LINENO", "TTYIDLE", "ZSH_EVAL_CONTEXT", "ZSH_SUBSHELL", "status", "zsh_eval_context", "pipestatus"]) {
    assert.throws(() => createLiveAccessChannel({ [name]: "fake-readonly-value" }), (error) => !String(error).includes("fake-readonly-value"), name);
  }
  for (const bad of [null, [], { "BAD-NAME": "fake-value-never-in-error" }, { LIVE_TEST_A: 1 }, { LIVE_TEST_A: "nul\0fake-value-never-in-error" }, { AGENT_HUB_LIVE_HANDLE: "fake-value-never-in-error" }, { BASH_ENV: "fake-value-never-in-error" }, { ZDOTDIR: "fake-value-never-in-error" }]) {
    assert.throws(() => createLiveAccessChannel(bad), (error) => !String(error).includes("fake-value-never-in-error"));
    await assert.rejects(channel.update(bad), (error) => !String(error).includes("fake-value-never-in-error"));
  }
});

posixTest("fresh Bash and Zsh commands see add, rotate, delete and literal special characters without host mutation", { timeout: 15000 }, async (t) => {
  const fake = "fake-live-🗝-\n'\"$`$(touch NEVER_EXECUTE)`\\end\n";
  const before = { ...process.env };
  const channel = createLiveAccessChannel({ LIVE_TEST_A: fake });
  const bridge = await createLiveAccessBridge(channel);
  t.after(() => bridge.dispose());
  const inherited = { LIVE_TEST_A: "stale", LIVE_TEST_B: "stale" };
  for (const [executable, flags] of [["/bin/bash", ["-c"]], ["/bin/zsh", ["-c"]], ["/bin/zsh", ["-lc"]], ["/bin/zsh", ["-lic"]]].filter(([executable]) => existsSync(executable))) {
    assert.deepEqual(await environment(bridge, executable, flags, inherited), { LIVE_TEST_A: fake, LIVE_TEST_B: "stale" });
  }
  await channel.update({ LIVE_TEST_A: "rotated", LIVE_TEST_B: fake });
  for (const executable of shells) assert.deepEqual(await environment(bridge, executable, ["-c"], inherited), { LIVE_TEST_A: "rotated", LIVE_TEST_B: fake });
  await channel.update({});
  for (const executable of shells) assert.deepEqual(await environment(bridge, executable, ["-c"], inherited), {});
  assert.deepEqual(Object.keys(process.env).sort(), Object.keys(before).sort());
  for (const [name, value] of Object.entries(before)) assert.equal(process.env[name] === value, true, `host environment changed: ${name}`);
  await assert.rejects(stat(join(process.cwd(), "NEVER_EXECUTE")), { code: "ENOENT" });
});

posixTest("generated metadata files and argv contain no values; xtrace hides refresh payload and restores shell tracing", { timeout: 10000 }, async (t) => {
  const fake = "fake-no-file-no-argv-\"'🔐";
  const channel = createLiveAccessChannel({ LIVE_TEST_A: fake }, "Public LIVE_TEST_A metadata");
  const bridge = await createLiveAccessBridge(channel);
  t.after(() => bridge.dispose());
  const directory = dirname(bridge.environment.BASH_ENV);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const file of await readdir(directory)) {
    const info = await stat(join(directory, file));
    if (info.isFile()) {
      const contents = await readFile(join(directory, file), "utf8");
      assert.equal(contents.includes(fake), false, file);
      assert.equal(contents.includes(bridge.environment.AGENT_HUB_LIVE_HANDLE), false, file);
      assert.equal(info.mode & 0o077, 0, file);
    }
  }
  assert.equal(JSON.stringify(bridge.environment).includes(fake), false);
  assert.equal(bridge.refreshCommand.includes(fake), false);
  assert.match(await readFile(bridge.contextPath, "utf8"), /Public LIVE_TEST_A metadata/);
  await channel.update({ LIVE_TEST_B: fake }, "Public LIVE_TEST_B metadata");
  assert.equal(await readFile(bridge.contextPath, "utf8"), "Public LIVE_TEST_B metadata");
  for (const executable of shells) {
    const result = await shell(`${bridge.refreshCommand}\ncase $- in *x*) printf trace-restored;; esac`, bridge.environment, executable, ["-xc"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "trace-restored");
    assert.equal(result.stderr.includes(fake), false);
    assert.equal(result.stderr.includes(bridge.environment.AGENT_HUB_LIVE_HANDLE), false);
    assert.equal(result.stderr.includes("export LIVE_TEST_B="), false);
  }
});

posixTest("separate bridges isolate same-folder profiles and remove all resources on disposal", { timeout: 10000 }, async (t) => {
  const a = await createLiveAccessBridge(createLiveAccessChannel({ LIVE_TEST_A: "profile-a" }));
  const b = await createLiveAccessBridge(createLiveAccessChannel({ LIVE_TEST_A: "profile-b" }));
  t.after(async () => { await a.dispose(); await b.dispose(); });
  assert.notEqual(a.environment.AGENT_HUB_LIVE_SNAPSHOT, b.environment.AGENT_HUB_LIVE_SNAPSHOT);
  assert.deepEqual(await environment(a, "/bin/bash", ["-c"]), { LIVE_TEST_A: "profile-a" });
  assert.deepEqual(await environment(b, "/bin/bash", ["-c"]), { LIVE_TEST_A: "profile-b" });
  await a.dispose();
  await a.dispose();
  await assert.rejects(stat(dirname(a.environment.BASH_ENV)), { code: "ENOENT" });
  const failed = await shell(`${a.refreshCommand}\nprintf should-not-run`, a.environment);
  assert.notEqual(failed.code, 0);
  assert.equal(failed.stdout, "");
  assert.deepEqual(await environment(b, "/bin/bash", ["-c"]), { LIVE_TEST_A: "profile-b" });
});

posixTest("bootstrap preserves original Bash and Zsh startup files while overlay wins after startup", { timeout: 10000 }, async (t) => {
  const home = join(temp, "startup-home");
  await mkdir(home);
  const originalBash = join(home, "original-bash");
  await writeFile(originalBash, "export LIVE_TEST_STARTUP=bash; export LIVE_TEST_A=stale\n");
  for (const name of [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) await writeFile(join(home, name), `export LIVE_TEST_STARTUP="\${LIVE_TEST_STARTUP-}${name}:"; export LIVE_TEST_A=stale\n`);
  const previous = { BASH_ENV: process.env.BASH_ENV, ZDOTDIR: process.env.ZDOTDIR };
  process.env.BASH_ENV = originalBash;
  process.env.ZDOTDIR = home;
  let bridge;
  try { bridge = await createLiveAccessBridge(createLiveAccessChannel({ LIVE_TEST_A: "fresh" })); }
  finally {
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
  t.after(() => bridge.dispose());
  assert.deepEqual(await environment(bridge, "/bin/bash", ["-c"]), { LIVE_TEST_STARTUP: "bash", LIVE_TEST_A: "fresh" });
  if (existsSync("/bin/zsh")) {
    const result = await environment(bridge, "/bin/zsh", ["-lic"]);
    assert.equal(result.LIVE_TEST_STARTUP, ".zshenv:.zprofile:.zshrc:.zlogin:");
    assert.equal(result.LIVE_TEST_A, "fresh");
  } else t.diagnostic("Zsh is unavailable on this runner; Bash startup assertions passed.");
});

posixTest("large snapshots remain atomic when shell requests race queued updates", { timeout: 15000 }, async (t) => {
  const first = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`LIVE_TEST_${i}`, "a"]));
  const second = Object.fromEntries(Object.keys(first).map((key) => [key, "b"]));
  const channel = createLiveAccessChannel(first);
  const bridge = await createLiveAccessBridge(channel);
  t.after(() => bridge.dispose());
  const update = channel.update(second);
  const values = await environment(bridge, "/bin/bash", ["-c"]);
  await update;
  assert.equal(Object.keys(values).length, 10000);
  assert.equal(new Set(Object.values(values)).size, 1);
  assert.deepEqual(channel.current, second);
});

posixTest("unavailable encrypted snapshot fails closed before Bash or Zsh executes the requested command", { timeout: 10000 }, async (t) => {
  const bridge = await createLiveAccessBridge(createLiveAccessChannel({ LIVE_TEST_A: "fake-unavailable-value" }));
  t.after(() => bridge.dispose());
  const invalid = { ...bridge.environment, AGENT_HUB_LIVE_SNAPSHOT: join(temp, "missing.snapshot") };
  for (const executable of shells) {
    const result = await shell("printf should-not-run", invalid, executable);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes("fake-unavailable-value"), false);
  }
});

posixTest("readonly startup variables cannot silently keep a stale partial snapshot", { timeout: 10000 }, async (t) => {
  const file = join(temp, "readonly-bash-env");
  await writeFile(file, "readonly LIVE_TEST_A=fake-stale-readonly\n");
  const previous = process.env.BASH_ENV;
  process.env.BASH_ENV = file;
  let bridge;
  try { bridge = await createLiveAccessBridge(createLiveAccessChannel({ LIVE_TEST_A: "fake-fresh-readonly", LIVE_TEST_B: "okay" })); }
  finally { previous === undefined ? delete process.env.BASH_ENV : process.env.BASH_ENV = previous; }
  t.after(() => bridge.dispose());
  const result = await shell("printf should-not-run", bridge.environment);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes("fake-fresh-readonly"), false);
});


posixTest("helper refreshes current credentials when sandbox denies IPC connect", { timeout: 10000 }, async (t) => {
  const channel = createLiveAccessChannel({ LIVE_TEST_A: "fake-denied-initial" });
  const bridge = await createLiveAccessBridge(channel);
  t.after(() => bridge.dispose());
  for (const value of ["fake-denied-initial", "fake-denied-rotated"]) {
    if (value.endsWith("rotated")) await channel.update({ LIVE_TEST_A: value });
    const result = await helper(bridge, {}, true);
    assert.equal(result.code, 0, "refresh must succeed despite connect EPERM");
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(quote(value)), true);
  }
  await channel.update({});
  const result = await helper(bridge, {}, true);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.includes("unset LIVE_TEST_A"), true);
  assert.equal(result.stdout.includes("fake-denied-"), false);
});


posixTest("encrypted snapshot contains no credential literals and each awaited revision replaces it atomically", { timeout: 15000 }, async (t) => {
  const fake = "fake-ciphertext-only-'\"🗝\n$`\\literal";
  const channel = createLiveAccessChannel({ LIVE_TEST_PRIVATE_DUMMY: fake });
  const bridge = await createLiveAccessBridge(channel);
  const directory = dirname(bridge.environment.BASH_ENV);
  const path = bridge.environment.AGENT_HUB_LIVE_SNAPSHOT;
  t.after(() => bridge.dispose());
  assert.equal(typeof path, "string");
  assert.equal(dirname(path), directory);
  assert.equal(path.startsWith(process.cwd()), false);
  const first = await readFile(path);
  const firstStat = await stat(path);
  assert.equal(first.includes(Buffer.from(fake)), false);
  assert.equal(first.includes(Buffer.from("LIVE_TEST_PRIVATE_DUMMY")), false);
  assert.equal(first.includes(Buffer.from(bridge.environment.AGENT_HUB_LIVE_HANDLE)), false);
  assert.equal(firstStat.mode & 0o777, 0o600);
  assert.equal(firstStat.nlink, 1);
  await channel.update({ LIVE_TEST_PRIVATE_DUMMY: fake }, "Only public names LIVE_TEST_PRIVATE_DUMMY");
  assert.notDeepEqual(await readFile(path), first, "the same plaintext needs a fresh nonce for each revision");
  assert.notEqual((await stat(path)).ino, firstStat.ino, "publication replaces the full file");
  assert.equal(await readFile(bridge.contextPath, "utf8"), "Only public names LIVE_TEST_PRIVATE_DUMMY");
  const reader = (async () => {
    for (let i = 0; i < 12; i++) {
      const result = await helper(bridge, {}, true);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout.includes("unset LIVE_TEST_PRIVATE_DUMMY"), true);
    }
  })();
  const updates = Array.from({ length: 24 }, (_, index) => channel.update({ [`LIVE_TEST_REV_${index}`]: fake }));
  await Promise.all([...updates, reader]);
  const result = await helper(bridge, {}, true);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.includes("export LIVE_TEST_REV_23="), true);
  assert.equal(result.stdout.includes("export LIVE_TEST_REV_22="), false);
  assert.deepEqual(await environment(bridge, "/bin/bash", ["-c"], { LIVE_TEST_PRIVATE_DUMMY: "stale" }), { LIVE_TEST_REV_23: fake });
  assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false);
  await bridge.dispose();
  await assert.rejects(stat(path), { code: "ENOENT" });
});

posixTest("snapshot authentication and file safety reject tampering, foreign profiles and unsafe replacements", { timeout: 15000 }, async (t) => {
  const fake = "fake-never-in-failure-'🔒";
  const bridge = await createLiveAccessBridge(createLiveAccessChannel({ LIVE_TEST_A: fake }));
  const foreign = await createLiveAccessBridge(createLiveAccessChannel({ LIVE_TEST_A: "fake-foreign-profile" }));
  t.after(async () => { await bridge.dispose(); await foreign.dispose(); });
  const path = bridge.environment.AGENT_HUB_LIVE_SNAPSHOT;
  const original = await readFile(path);
  const restore = async () => { await rm(path, { recursive: true, force: true }); await writeFile(path, original, { mode: 0o600 }); };
  const reject = async (extra = {}) => {
    const result = await helper(bridge, extra);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Live access refresh unavailable.\n");
  };
  const corrupt = Buffer.from(original);
  corrupt[corrupt.length - 1] ^= 1;
  await writeFile(path, corrupt);
  await reject();
  await truncate(path, 4);
  await reject();
  await writeFile(path, Buffer.from("export LIVE_TEST_A=fake-plaintext-replacement\n"));
  await reject();
  await writeFile(path, await readFile(foreign.environment.AGENT_HUB_LIVE_SNAPSHOT));
  await reject();
  await restore();
  await reject({ AGENT_HUB_LIVE_HANDLE: foreign.environment.AGENT_HUB_LIVE_HANDLE });
  await reject({ AGENT_HUB_LIVE_HANDLE: "00".repeat(32) });
  await reject({ AGENT_HUB_LIVE_HANDLE: "invalid" });
  await reject({ AGENT_HUB_LIVE_SNAPSHOT: foreign.environment.AGENT_HUB_LIVE_SNAPSHOT });
  await chmod(path, 0o644);
  await reject();
  await restore();
  const secondLink = join(dirname(path), "linked.snapshot");
  await link(path, secondLink);
  await reject();
  await rm(secondLink);
  const target = join(dirname(path), "original.snapshot");
  await rename(path, target);
  await symlink(target, path);
  await reject();
  await rm(target);
  await restore();
  await writeFile(path, Buffer.alloc(32 * 1024 * 1024 + 256));
  await reject();
  await rm(path);
  await mkdir(path, { mode: 0o700 });
  await reject();
  await restore();
  assert.equal((await helper(bridge)).code, 0);
  await chmod(dirname(path), 0o755);
  await reject();
  await chmod(dirname(path), 0o700);
  assert.equal((await helper(bridge)).code, 0);
});

posixTest("channel update rejects delivery when encrypted snapshot publication fails", { timeout: 10000 }, async (t) => {
  const channel = createLiveAccessChannel({ LIVE_TEST_A: "fake-publication-first" });
  const bridge = await createLiveAccessBridge(channel);
  const directory = dirname(bridge.environment.BASH_ENV);
  const moved = `${directory}-moved`;
  t.after(async () => { await bridge.dispose(); await rm(moved, { recursive: true, force: true }); });
  await rename(directory, moved);
  await assert.rejects(channel.update({ LIVE_TEST_A: "fake-publication-next" }), (error) => {
    assert.equal(String(error).includes("fake-publication"), false);
    return /live access update delivery failed/i.test(String(error));
  });
  await rename(moved, directory);
  await channel.update({ LIVE_TEST_B: "fake-publication-recovered" });
  assert.deepEqual(await environment(bridge, "/bin/bash", ["-c"], { LIVE_TEST_A: "stale" }), { LIVE_TEST_B: "fake-publication-recovered" });
});
