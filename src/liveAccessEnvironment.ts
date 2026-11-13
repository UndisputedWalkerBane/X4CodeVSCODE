import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveAccessBridge, LiveAccessChannel } from "./agents/types";

const INVALID_SNAPSHOT = "Invalid live access environment. Use portable variable names and string values; shell readonly variables, BASH_ENV, ZDOTDIR and AGENT_HUB_LIVE_* are reserved.";
// Assigning these built-in parameters fails in a clean Bash or Zsh shell.
const READONLY_SHELL_NAMES = new Set([
  "BASHOPTS", "BASH_VERSINFO", "EUID", "PPID", "SHELLOPTS", "UID", "GID", "EGID",
  "ARGC", "HISTCMD", "LINENO", "TTYIDLE", "ZSH_EVAL_CONTEXT", "ZSH_SUBSHELL",
  "status", "zsh_eval_context", "pipestatus",
]);
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_HEADER = Buffer.from("AHLS\0\0\0\x01", "binary");
const SNAPSHOT_KEY_DOMAIN = "Agent Hub live access snapshot encryption key v1\0";
const SNAPSHOT_AAD = "Agent Hub live access snapshot v1\0";
const SNAPSHOT_OVERHEAD = SNAPSHOT_HEADER.length + 12 + 16;

function copySnapshot(input: Record<string, string>): Readonly<Record<string, string>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(INVALID_SNAPSHOT);
  const snapshot: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || READONLY_SHELL_NAMES.has(name) || /^AGENT_HUB_LIVE_/i.test(name) || /^(BASH_ENV|ZDOTDIR)$/i.test(name)
      || typeof value !== "string" || value.includes("\0")) throw new Error(INVALID_SNAPSHOT);
    Object.defineProperty(snapshot, name, { value, enumerable: true, writable: false });
  }
  return Object.freeze(snapshot);
}

/** Ordered in-memory publication; a failed subscriber does not poison later publications. */
export function createLiveAccessChannel(initial: Record<string, string> = {}, publicContext?: string): LiveAccessChannel {
  let current = copySnapshot(initial);
  if (publicContext !== undefined && (typeof publicContext !== "string" || publicContext.includes("\0"))) throw new Error("Invalid live access public context.");
  let context = publicContext;
  let revision = 0;
  const owned = new Set(Object.keys(current));
  let ownedKeys = Object.freeze([...owned]);
  const subscribers = new Set<(snapshot: Readonly<Record<string, string>>, revision: number) => void | Promise<void>>();
  let queue = Promise.resolve();
  return {
    get current() { return current; },
    get revision() { return revision; },
    get publicContext() { return context; },
    get ownedKeys() { return ownedKeys; },
    update(next, nextContext) {
      let captured: Readonly<Record<string, string>>;
      try {
        captured = copySnapshot(next);
        if (nextContext !== undefined && (typeof nextContext !== "string" || nextContext.includes("\0"))) throw new Error("Invalid live access public context.");
      } catch (error) { return Promise.reject(error); }
      const operation = queue.then(async () => {
        current = captured;
        if (nextContext !== undefined) context = nextContext;
        revision++;
        for (const name of Object.keys(current)) owned.add(name);
        ownedKeys = Object.freeze([...owned]);
        const results = await Promise.allSettled([...subscribers].map(async (listener) => listener(current, revision)));
        if (results.some((result) => result.status === "rejected")) throw new Error("Live access update delivery failed.");
      });
      queue = operation.catch(() => {});
      return operation;
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
  };
}

const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const shellPath = (value: string): string => value.replace(/\\/g, "/");

/** No credentials or authentication handle are embedded in this on-disk helper. */
function helperSource(): string {
  return `"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const snapshot = process.env.AGENT_HUB_LIVE_SNAPSHOT;
const token = process.env.AGENT_HUB_LIVE_HANDLE;
const fail = () => { process.stderr.write("Live access refresh unavailable.\\n"); process.exit(1); };
let fd;
try {
  if (!snapshot || !path.isAbsolute(snapshot) || !/^[a-f0-9]{64}$/.test(token || "")) throw new Error();
  const posix = process.platform !== "win32";
  if (posix && typeof fs.constants.O_NOFOLLOW !== "number") throw new Error();
  const directory = fs.lstatSync(path.dirname(snapshot));
  if (!directory.isDirectory() || (posix && (directory.uid !== process.getuid() || (directory.mode & 0o7777) !== 0o700))) throw new Error();
  fd = fs.openSync(snapshot, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  const info = fs.fstatSync(fd);
  if (!info.isFile() || info.nlink !== 1 || info.size < ${SNAPSHOT_OVERHEAD} || info.size > ${MAX_SNAPSHOT_BYTES + SNAPSHOT_OVERHEAD}
    || (posix && (info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o600))) throw new Error();
  // Bounded descriptor reads cannot follow a replacement path or grow the allocation.
  const contents = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < contents.length) {
    const read = fs.readSync(fd, contents, offset, contents.length - offset, offset);
    if (read === 0) throw new Error();
    offset += read;
  }
  const after = fs.fstatSync(fd);
  if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino || after.dev !== info.dev) throw new Error();
  fs.closeSync(fd); fd = undefined;
  const header = Buffer.from(${JSON.stringify(SNAPSHOT_HEADER.toString("hex"))}, "hex");
  if (!contents.subarray(0, header.length).equals(header)) throw new Error();
  const key = crypto.createHash("sha256").update(${JSON.stringify(SNAPSHOT_KEY_DOMAIN)}).update(Buffer.from(token, "hex")).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, contents.subarray(header.length, header.length + 12));
  decipher.setAAD(Buffer.from(${JSON.stringify(SNAPSHOT_AAD)}));
  decipher.setAuthTag(contents.subarray(header.length + 12, ${SNAPSHOT_OVERHEAD}));
  // Never emit a partial plaintext: final() authenticates before stdout is touched.
  const script = Buffer.concat([decipher.update(contents.subarray(${SNAPSHOT_OVERHEAD})), decipher.final()]);
  process.stdout.write(script);
} catch {
  if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  fail();
}
`;
}

/** The first traceable operations use only shell flags; payload expansion happens with xtrace off. */
function refreshSource(helper: string): string {
  return `case $- in
  *x*) set +x; AGENT_HUB_LIVE_TRACE=1 ;;
  *) AGENT_HUB_LIVE_TRACE=0 ;;
esac
if AGENT_HUB_LIVE_PAYLOAD="$(NODE_OPTIONS= ELECTRON_RUN_AS_NODE=1 ${quote(shellPath(process.execPath))} ${quote(shellPath(helper))})"; then
  if eval "$AGENT_HUB_LIVE_PAYLOAD" 2>/dev/null; then
    unset AGENT_HUB_LIVE_PAYLOAD
  else
    unset AGENT_HUB_LIVE_PAYLOAD
    printf '%s\\n' 'Live access refresh unavailable.' >&2
    exit 1
  fi
else
  unset AGENT_HUB_LIVE_PAYLOAD
  printf '%s\\n' 'Live access refresh unavailable.' >&2
  exit 1
fi
if [ "$AGENT_HUB_LIVE_TRACE" = 1 ]; then
  unset AGENT_HUB_LIVE_TRACE
  set -x
else
  unset AGENT_HUB_LIVE_TRACE
fi
`;
}

function bashSource(refresh: string, bootstrap: string): string {
  return `if [ -n "\${AGENT_HUB_LIVE_ORIGINAL_BASH_ENV-}" ] && [ -r "$AGENT_HUB_LIVE_ORIGINAL_BASH_ENV" ]; then
  . "$AGENT_HUB_LIVE_ORIGINAL_BASH_ENV"
fi
export BASH_ENV=${quote(shellPath(bootstrap))}
. ${quote(shellPath(refresh))} || exit 1
`;
}

function zshSource(name: string, refresh: string, directory: string): string {
  return `if [ "\${AGENT_HUB_LIVE_ORIGINAL_ZDOTDIR_SET-}" = 1 ]; then
  export ZDOTDIR="$AGENT_HUB_LIVE_ORIGINAL_ZDOTDIR"
else
  unset ZDOTDIR
fi
if [ -r "\${ZDOTDIR-$HOME}/${name}" ]; then
  . "\${ZDOTDIR-$HOME}/${name}"
fi
if [ "\${ZDOTDIR+x}" = x ]; then
  export AGENT_HUB_LIVE_ORIGINAL_ZDOTDIR="$ZDOTDIR"
  export AGENT_HUB_LIVE_ORIGINAL_ZDOTDIR_SET=1
else
  unset AGENT_HUB_LIVE_ORIGINAL_ZDOTDIR
  export AGENT_HUB_LIVE_ORIGINAL_ZDOTDIR_SET=0
fi
export ZDOTDIR=${quote(shellPath(directory))}
. ${quote(shellPath(refresh))} || exit 1
`;
}

function snapshotScript(channel: LiveAccessChannel): string {
  // A channel revision commits synchronously, so snapshot and history cannot tear between reads.
  const snapshot = channel.current;
  return [...channel.ownedKeys.map((name) => `unset ${name} || exit 1`),
    ...Object.entries(snapshot).map(([name, value]) => `export ${name}=${quote(value)} || exit 1`), ""].join("\n");
}

/**
 * Per-run encrypted snapshots for newly launched Bash/Zsh processes. Persistent processes keep their existing env.
 * Native backend processes must stop before dispose removes their bootstrap files.
 */
export async function createLiveAccessBridge(channel: LiveAccessChannel): Promise<LiveAccessBridge> {
  const directory = await mkdtemp(join(tmpdir(), "agent-hub-live-"));
  const handle = randomBytes(32).toString("hex");
  const encryptionKey = createHash("sha256").update(SNAPSHOT_KEY_DOMAIN).update(Buffer.from(handle, "hex")).digest();
  const bootstrap = join(directory, "bash-env.sh");
  const refresh = join(directory, "refresh.sh");
  const helper = join(directory, "client.cjs");
  const contextPath = join(directory, "context.md");
  const snapshotPath = join(directory, "snapshot.enc");
  let closed = false;
  let disposal: Promise<void> | undefined;
  let unsubscribe = () => {};
  let publicationQueue = Promise.resolve();
  const publishSnapshot = (): Promise<void> => {
    const script = Buffer.from(snapshotScript(channel));
    const contents = channel.publicContext ?? `Live project environment names:\n${Object.keys(channel.current).sort().join("\n")}\n`;
    const operation = publicationQueue.then(async () => {
      if (closed) return;
      if (script.length > MAX_SNAPSHOT_BYTES) throw new Error("Live access snapshot publication failed.");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
      cipher.setAAD(Buffer.from(SNAPSHOT_AAD));
      const ciphertext = Buffer.concat([cipher.update(script), cipher.final()]);
      const encrypted = Buffer.concat([SNAPSHOT_HEADER, nonce, cipher.getAuthTag(), ciphertext]);
      const snapshotTemporary = join(directory, `snapshot-${randomBytes(8).toString("hex")}.tmp`);
      const contextTemporary = join(directory, `context-${randomBytes(8).toString("hex")}.tmp`);
      try {
        await writeFile(snapshotTemporary, encrypted, { mode: 0o600, flag: "wx" });
        await writeFile(contextTemporary, contents, { mode: 0o600, flag: "wx" });
        await rename(snapshotTemporary, snapshotPath);
        await rename(contextTemporary, contextPath);
      } finally {
        await Promise.all([snapshotTemporary, contextTemporary].map((path) => rm(path, { force: true })));
      }
    });
    publicationQueue = operation.catch(() => {});
    return operation;
  };
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    closed = true;
    unsubscribe();
    disposal = (async () => {
      await publicationQueue;
      await rm(directory, { recursive: true, force: true });
    })();
    return disposal;
  };
  try {
    await chmod(directory, 0o700);
    const files: Array<[string, string]> = [
      [helper, helperSource()], [refresh, refreshSource(helper)], [bootstrap, bashSource(refresh, bootstrap)],
      ...[".zshenv", ".zprofile", ".zshrc", ".zlogin"].map((name): [string, string] => [join(directory, name), zshSource(name, refresh, directory)]),
    ];
    await Promise.all(files.map(([path, contents]) => writeFile(path, contents, { mode: 0o600 })));
    unsubscribe = channel.subscribe(() => publishSnapshot());
    await publishSnapshot();
    const environment: Record<string, string> = {
      BASH_ENV: shellPath(bootstrap), ZDOTDIR: shellPath(directory),
      AGENT_HUB_LIVE_HANDLE: handle,
      AGENT_HUB_LIVE_SNAPSHOT: shellPath(snapshotPath),
      AGENT_HUB_LIVE_CONTEXT: shellPath(contextPath),
      AGENT_HUB_LIVE_ORIGINAL_BASH_ENV: process.env.BASH_ENV ?? "",
      AGENT_HUB_LIVE_ORIGINAL_ZDOTDIR_SET: process.env.ZDOTDIR === undefined ? "0" : "1",
      AGENT_HUB_LIVE_ORIGINAL_ZDOTDIR: process.env.ZDOTDIR ?? "",
    };
    return { environment, refreshCommand: `. ${quote(shellPath(refresh))} || exit 1`, contextPath, dispose };
  } catch {
    await dispose();
    throw new Error("Live access bridge initialization failed.");
  }
}
