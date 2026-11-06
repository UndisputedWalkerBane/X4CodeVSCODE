import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { constants, type Stats } from "node:fs";
import { open, realpath, lstat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { NativePromptAnchor, PrepareEditOptions, PreparedEdit } from "./types";
import { uniqueLegacyIndex } from "./nativeHistory";

type Entry = { type: string; [key: string]: unknown };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSCRIPT_TYPES = new Set(["user", "assistant", "system", "attachment", "progress"]);
const historyError = () => new Error("Нативная история Claude недоступна или неоднозначна (возможно, сжата). Выберите другое сообщение или откройте новый чат; исходная история сохранена.");
const storageError = () => new Error("Claude: путь или файл хранилища сессий изменился либо небезопасен.");
const MAX_TRANSCRIPT_SIZE = 128 * 1024 * 1024;
type StorageScope = { cwd: string; root: string; projectDir: string; directory: FileHandle; identity: Stats };
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

async function verifyStorage(storage: StorageScope): Promise<void> {
  const pinned = await storage.directory.stat();
  const current = await lstat(storage.projectDir);
  if (!pinned.isDirectory() || !current.isDirectory() || !sameFile(pinned, storage.identity) || !sameFile(current, pinned) ||
    await realpath(storage.projectDir) !== storage.projectDir || await realpath(storage.root) !== storage.root) throw storageError();
}

async function verifyTranscriptFile(storage: StorageScope, path: string, file: FileHandle): Promise<Stats> {
  await verifyStorage(storage);
  const opened = await file.stat();
  const current = await lstat(path);
  if (!opened.isFile() || opened.nlink !== 1 || !current.isFile() || !sameFile(opened, current) ||
    dirname(path) !== storage.projectDir || await realpath(path) !== path) throw storageError();
  if (opened.size > MAX_TRANSCRIPT_SIZE) throw new Error("История Claude слишком велика для безопасного редактирования (более 128 МБ).");
  await verifyStorage(storage);
  return opened;
}

/** Claude Code's project-directory encoding (SDK 0.3.280). */
function projectKey(cwd: string): string {
  const plain = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (plain.length <= 200) return plain;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  return `${plain.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

async function scopedStorage(opts: Pick<PrepareEditOptions, "cwd" | "extraEnv">) {
  // Node has no portable openat; platforms without these flags cannot safely use
  // the verified-handle fallback and must fail closed.
  if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) throw storageError();
  const env = { ...process.env, ...opts.extraEnv };
  const config = env.CLAUDE_CONFIG_DIR;
  if (config && (!isAbsolute(config) || config.includes("\0"))) throw new Error("Claude: некорректный путь CLAUDE_CONFIG_DIR.");
  const cwd = (await realpath(opts.cwd)).normalize("NFC");
  const root = await realpath(join(config || join(homedir(), ".claude"), "projects"));
  const override = config && env.CLAUDE_CODE_PROJECT_DIR_NAME;
  const key = override && /^[A-Za-z0-9_-]{1,64}$/.test(override) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(override)
    ? override : projectKey(cwd);
  const projectDir = await realpath(join(root, key));
  if (dirname(projectDir) !== root) throw new Error("Claude: путь проекта выходит за границы хранилища сессий.");
  const directory = await open(projectDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const storage = { cwd, root, projectDir, directory, identity: await directory.stat() };
    await verifyStorage(storage);
    return storage;
  } catch (error) {
    await directory.close();
    throw error;
  }
}

async function scopedTranscriptPath(storage: StorageScope, sessionId: string, transcriptPath: string): Promise<string> {
  if (!UUID.test(sessionId) || !isAbsolute(transcriptPath) || basename(transcriptPath) !== `${sessionId}.jsonl`) throw new Error("Claude: неверный путь нативного хранилища сессии.");
  const parent = await realpath(dirname(transcriptPath));
  if (parent !== storage.projectDir) throw new Error("Claude: путь транскрипта не относится к хранилищу этого проекта.");
  await verifyStorage(storage);
  return join(parent, `${sessionId}.jsonl`);
}

/** Validate hook/persisted paths against provider storage, not a caller-selected file. */
export async function verifiedClaudePath(
  opts: Pick<PrepareEditOptions, "cwd" | "extraEnv">,
  sessionId: string,
  transcriptPath: string,
): Promise<string> {
  const storage = await scopedStorage(opts);
  // The first UserPromptSubmit may run before the JSONL file has been created.
  try { return await scopedTranscriptPath(storage, sessionId, transcriptPath); }
  finally { await storage.directory.close(); }
}

async function readTranscript(storage: StorageScope, path: string, opts: PrepareEditOptions): Promise<Entry[]> {
  opts.signal.throwIfAborted();
  await verifyStorage(storage);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try {
    await verifyTranscriptFile(storage, path, file);
    text = await file.readFile({ encoding: "utf8", signal: opts.signal });
    await verifyTranscriptFile(storage, path, file);
  } finally { await file.close(); }
  const rows: Entry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Entry;
    try { row = JSON.parse(line); } catch { throw historyError(); }
    if (!row || typeof row !== "object" || typeof row.type !== "string") throw historyError();
    if (row.sessionId != null && row.sessionId !== opts.sessionId) throw historyError();
    rows.push(row);
  }
  const cwd = (await realpath(opts.cwd)).normalize("NFC");
  const recordedCwds = [...new Set(rows.filter((r) => typeof r.cwd === "string").map((r) => r.cwd as string))];
  if (recordedCwds.length === 0) throw historyError();
  for (const recorded of recordedCwds) {
    if ((await realpath(recorded)).normalize("NFC") !== cwd) throw new Error("Claude: сессия относится к другой рабочей папке.");
  }
  opts.signal.throwIfAborted();
  return rows;
}

async function writeTranscript(storage: StorageScope, path: string, entries: readonly unknown[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await verifyStorage(storage);
  // O_EXCL creates only an empty inode. Verify the opened object and its pinned
  // parent before writing any retained provider data; a rejected open may leave
  // an empty orphan, which must never be removed through an unverified pathname.
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const opened = await verifyTranscriptFile(storage, path, file);
    if (opened.size !== 0 || (opened.mode & 0o077) !== 0) throw storageError();
    signal.throwIfAborted();
    const text = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await file.writeFile(text, { encoding: "utf8", signal });
    if ((await verifyTranscriptFile(storage, path, file)).size !== Buffer.byteLength(text)) throw storageError();
  } finally { await file.close(); }
}

const isPrompt = (row: Entry) => row.type === "user" && !row.isMeta && !row.isSidechain &&
  (row.message as {role?: unknown} | undefined)?.role === "user" &&
  (typeof (row.message as {content?: unknown}).content === "string" ||
    (Array.isArray((row.message as {content?: unknown}).content) && ((row.message as {content: Entry[]}).content).some((block) => block.type === "text")));
const promptText = (row: Entry): string | undefined => {
  if (!isPrompt(row)) return undefined;
  const content = (row.message as {content: unknown}).content;
  return typeof content === "string" ? content : (content as Entry[]).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
};

export async function prepareClaudeEdit(opts: PrepareEditOptions): Promise<PreparedEdit> {
  opts.signal.throwIfAborted();
  if (!UUID.test(opts.sessionId) || (opts.anchor && (opts.anchor.provider !== "claude" || opts.anchor.sessionId !== opts.sessionId))) throw historyError();
  const storage = await scopedStorage(opts);
  try { return await prepareScopedClaudeEdit(opts, storage); }
  finally { await storage.directory.close(); }
}

async function prepareScopedClaudeEdit(opts: PrepareEditOptions, storage: StorageScope): Promise<PreparedEdit> {
  const requestedPath = opts.anchor?.provider === "claude" ? opts.anchor.transcriptPath : join(storage.projectDir, `${opts.sessionId}.jsonl`);
  const sourcePath = await scopedTranscriptPath(storage, opts.sessionId, requestedPath);
  const rows = await readTranscript(storage, sourcePath, opts);
  const transcript = rows.filter((r) => TRANSCRIPT_TYPES.has(r.type) && typeof r.uuid === "string" && !r.isSidechain);
  const byId = new Map<string, Entry>();
  for (const row of transcript) {
    if (byId.has(row.uuid as string)) throw historyError();
    byId.set(row.uuid as string, row);
  }
  const index = opts.anchor?.provider === "claude"
    ? transcript.findIndex((r) => r.uuid === (opts.anchor as {userMessageUuid: string}).userMessageUuid)
    : uniqueLegacyIndex(transcript.map(promptText), opts.legacyPrompt);
  const target = transcript[index];
  if (!target || !isPrompt(target)) throw historyError();
  if (!transcript.slice(0, index).some(isPrompt)) {
    // A compacted first visible prompt can still have a real provider parent.
    // Only an actual root user message proves that its native prefix is empty.
    if (target.parentUuid != null) throw historyError();
    return {};
  }
  const parent = target.parentUuid;
  const parentIndex = transcript.findIndex((r) => r.uuid === parent);
  if (typeof parent !== "string" || parentIndex < 0 || parentIndex >= index) throw new Error("Claude: реальный родительский узел промпта отсутствует в нативной истории.");
  const prefix = transcript.slice(0, parentIndex + 1).filter((r) => r.type !== "progress");
  if (!prefix.some(isPrompt)) throw historyError();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Claude: истекло время подготовки истории (60 с).")), 60_000);
  timer.unref();
  try {
    let writtenSessionId: string | undefined;
    // Pass-through storage scopes the native SDK fork to the verified JSONL, including
    // custom CLAUDE_CONFIG_DIR. The SDK alone selects/remaps provider entries; no
    // visible chat text is synthesized and no process-global environment is changed.
    const fork = forkSession(opts.sessionId, {
      dir: opts.cwd, upToMessageId: parent,
      sessionStore: {
        async load(key) {
          controller.signal.throwIfAborted();
          if (key.sessionId !== opts.sessionId || key.subpath) throw historyError();
          return rows;
        },
        async append(key, entries) {
          controller.signal.throwIfAborted();
          if (!UUID.test(key.sessionId) || key.sessionId === opts.sessionId || key.subpath || writtenSessionId) throw historyError();
          writtenSessionId = key.sessionId;
          await writeTranscript(storage, join(storage.projectDir, `${key.sessionId}.jsonl`), entries, controller.signal);
        },
      },
    });
    let onCancel: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onCancel = () => reject(controller.signal.reason ?? new Error("Подготовка редактирования Claude отменена."));
      controller.signal.addEventListener("abort", onCancel, { once: true });
      if (controller.signal.aborted) onCancel();
    });
    let result: Awaited<typeof fork>;
    try { result = await Promise.race([fork, cancelled]); }
    finally { if (onCancel) controller.signal.removeEventListener("abort", onCancel); }
    if (!UUID.test(result.sessionId) || result.sessionId === opts.sessionId || result.sessionId !== writtenSessionId) throw historyError();
    const forkPath = join(storage.projectDir, `${result.sessionId}.jsonl`);
    const forkRows = (await readTranscript(storage, forkPath, { ...opts, sessionId: result.sessionId })).filter((r) => TRANSCRIPT_TYPES.has(r.type) && typeof r.uuid === "string");
    if (forkRows.length !== prefix.length) throw new Error("Claude не подтвердил точную границу истории: выбранный или последующий промпт попал в копию.");
    const remappedAnchors: Record<string, NativePromptAnchor> = {};
    const mapping = new Map<string, string>();
    for (let i = 0; i < prefix.length; i++) {
      const old = prefix[i], actual = forkRows[i];
      const from = actual.forkedFrom as {sessionId?: unknown; messageUuid?: unknown} | undefined;
      if (from?.sessionId !== opts.sessionId || from.messageUuid !== old.uuid || typeof actual.uuid !== "string" || !UUID.test(actual.uuid) || mapping.has(old.uuid as string) || actual.type !== old.type) throw historyError();
      mapping.set(old.uuid as string, actual.uuid);
      if (isPrompt(old)) remappedAnchors[old.uuid as string] = { provider: "claude", sessionId: result.sessionId, userMessageUuid: actual.uuid, transcriptPath: forkPath };
    }
    if (new Set(mapping.values()).size !== mapping.size) throw historyError();
    const payload = (row: Entry) => {
      const { uuid, parentUuid, sessionId, timestamp, forkedFrom, logicalParentUuid,
        isSidechain, teamName, agentName, sessionKind, slug, sourceToolAssistantUUID,
        ...content } = row;
      if (content.type === "system" && content.subtype === "model_refusal_fallback") delete content.neutralizedByFork;
      return content;
    };
    for (let i = 0; i < prefix.length; i++) {
      const expected = payload(prefix[i]);
      if (expected.type === "attachment" && typeof expected.attachment === "object" && expected.attachment !== null) {
        const attachment = { ...expected.attachment as Entry };
        if (attachment.type === "queued_command" && typeof attachment.source_uuid === "string" && mapping.has(attachment.source_uuid)) attachment.source_uuid = mapping.get(attachment.source_uuid);
        if (attachment.type === "deferred_tools_record" && Array.isArray(attachment.nameOnlyAnnouncements)) attachment.nameOnlyAnnouncements = attachment.nameOnlyAnnouncements.flatMap((id) => typeof id === "string" && mapping.has(id) ? [mapping.get(id)] : []);
        expected.attachment = attachment;
      }
      if (!isDeepStrictEqual(expected, payload(forkRows[i]))) throw historyError();
      const logical = prefix[i].logicalParentUuid;
      if (forkRows[i].logicalParentUuid !== (logical == null ? logical : mapping.get(logical as string) ?? null)) throw historyError();
      let parentId = prefix[i].parentUuid;
      const seen = new Set<unknown>();
      while (typeof parentId === "string" && byId.get(parentId)?.type === "progress") {
        if (seen.has(parentId)) throw historyError();
        seen.add(parentId); parentId = byId.get(parentId)?.parentUuid;
      }
      if (parentId != null && !mapping.has(parentId as string)) throw historyError();
      if (forkRows[i].parentUuid !== (mapping.get(parentId as string) ?? null)) throw historyError();
    }
    opts.signal.throwIfAborted();
    controller.signal.throwIfAborted();
    return { resumeSessionId: result.sessionId, remappedAnchors };
  } finally {
    controller.abort();
    clearTimeout(timer);
    opts.signal.removeEventListener("abort", onAbort);
  }
}
