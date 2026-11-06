import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { isDeepStrictEqual } from "node:util";
import { stopCodex, trackCodexProcess } from "./codexBackend";
import type { PrepareEditOptions, PreparedEdit } from "./types";

type Json = Record<string, unknown>;
const EDIT_TIMEOUT_MS = 60_000;
const unavailable = () => new Error("Не удалось однозначно найти исходный промпт в нативной истории. Откройте новый чат или выберите сообщение с сохранённой привязкой провайдера.");

/** Only a unique exact suffix is allowed for chats saved before native IDs existed. */
export function uniqueLegacyIndex(texts: (string | undefined)[], prompt: string | undefined): number {
  if (!prompt) throw unavailable();
  const matches = texts.flatMap((text, index) => text?.endsWith(prompt) ? [index] : []);
  if (matches.length !== 1) throw unavailable();
  return matches[0];
}

/** Fork persisted history only. This connection never resumes a thread or starts inference. */
export async function prepareCodexEdit(opts: PrepareEditOptions): Promise<PreparedEdit> {
  opts.signal.throwIfAborted();
  if (!opts.sessionId || (opts.anchor && (opts.anchor.provider !== "codex" || opts.anchor.sessionId !== opts.sessionId))) throw unavailable();
  const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
    cwd: opts.cwd, env: { ...process.env, ...(opts.extraEnv ?? {}) },
    stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
  });
  trackCodexProcess(child);
  const pending = new Map<number, { resolve: (value: Json) => void; reject: (err: Error) => void }>();
  let nextId = 0;
  const rejectAll = (err: Error) => { for (const entry of [...pending.values()]) entry.reject(err); };
  const onAbort = () => rejectAll(new Error("Подготовка редактирования отменена."));
  const onError = (err: Error) => rejectAll(err);
  const onExit = () => rejectAll(new Error("Codex закрыл соединение при чтении истории."));
  child.on("error", onError);
  child.on("exit", onExit);
  // Drain stderr without retaining provider output or unrelated local data.
  child.stderr.resume();
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let message: Json;
    try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message.id as number);
    if (!entry) return;
    if (message.error) {
      const error = message.error as Json;
      entry.reject(Object.assign(new Error(String(error.message ?? "Codex RPC failed")), { code: error.code }));
    } else entry.resolve((message.result ?? {}) as Json);
  });
  opts.signal.addEventListener("abort", onAbort, { once: true });
  const request = (method: string, params: Json) => new Promise<Json>((resolve, reject) => {
    if (opts.signal.aborted) { reject(new Error("Подготовка редактирования отменена.")); return; }
    const id = ++nextId;
    const timer = setTimeout(() => pending.get(id)?.reject(new Error(`Codex ${method}: истекло время ожидания истории (60 с). Обновите CLI и повторите.`)), EDIT_TIMEOUT_MS);
    timer.unref();
    const settle = () => { pending.delete(id); clearTimeout(timer); };
    pending.set(id, { resolve: (value) => { settle(); resolve(value); }, reject: (err) => { settle(); reject(err); } });
    try {
      if (!child.stdin.writable) throw new Error("Codex: соединение закрыто");
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    } catch (err) { pending.get(id)?.reject(err instanceof Error ? err : new Error(String(err))); }
  });
  const readTurns = async (threadId: string): Promise<Json[]> => {
    const turns: Json[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    const full = !opts.anchor;
    let pages = 0;
    try {
      do {
        if (++pages > 1_000) throw new Error("История Codex слишком велика для безопасного чтения; выберите более новый чат.");
        const page = await request("thread/turns/list", { threadId, sortDirection: "asc", itemsView: full ? "full" : "notLoaded", limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page.data)) throw new Error("Codex не вернул полную историю ходов.");
        turns.push(...page.data as Json[]);
        if (page.nextCursor != null && typeof page.nextCursor !== "string") throw new Error("Codex вернул неверный курсор истории.");
        cursor = page.nextCursor as string | undefined;
        if (cursor && seen.has(cursor)) throw new Error("Codex повторил страницу истории.");
        if (cursor) seen.add(cursor);
      } while (cursor);
    } catch (err) {
      if ((err as {code?: unknown}).code !== -32601) throw err;
      const response = await request("thread/read", { threadId, includeTurns: true });
      const thread = response.thread as Json | undefined;
      if (thread?.id !== threadId || !Array.isArray(thread.turns)) throw new Error("Codex не поддерживает чтение полной нативной истории. Обновите CLI.");
      turns.splice(0, turns.length, ...thread.turns as Json[]);
    }
    const ids = new Set<string>();
    for (const turn of turns) {
      if (typeof turn.id !== "string" || !turn.id || ids.has(turn.id) || !Array.isArray(turn.items) || (full && turn.itemsView != null && turn.itemsView !== "full")) throw new Error("Codex вернул неполную или неоднозначную историю.");
      ids.add(turn.id);
    }
    return turns;
  };
  try {
    await request("initialize", { clientInfo: { name: "agent-hub", title: "Agent Hub", version: "1.0.0" } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const source = await readTurns(opts.sessionId);
    const index = opts.anchor?.provider === "codex"
      ? source.findIndex((turn) => turn.id === (opts.anchor as { turnId: string }).turnId)
      : uniqueLegacyIndex(source.map((turn) => {
          const users = (turn.items as Json[]).filter((item) => item.type === "userMessage");
          if (users.length !== 1 || !Array.isArray(users[0].content)) return undefined;
          return (users[0].content as Json[]).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
        }), opts.legacyPrompt);
    if (index < 0) throw unavailable();
    if (index === 0) return {};
    const prefix = source.slice(0, index);
    if (prefix.some((turn) => !["completed", "interrupted", "failed"].includes(String(turn.status)))) throw new Error("Дождитесь завершения предыдущих ходов Codex перед редактированием.");
    const fork = await request("thread/fork", { threadId: opts.sessionId, lastTurnId: prefix.at(-1)?.id, cwd: opts.cwd, excludeTurns: true });
    const id = (fork.thread as Json | undefined)?.id;
    if (typeof id !== "string" || !id.trim() || id === opts.sessionId) throw new Error("Codex не создал отдельный тред для редактирования. Обновите CLI.");
    const actual = await readTurns(id);
    const comparable = (turns: Json[]) => turns.map(({ id, status, items }) => opts.anchor ? { id, status } : { id, status, items });
    if (!isDeepStrictEqual(comparable(prefix), comparable(actual))) throw new Error("Codex не подтвердил точную границу истории: выбранный или последующий ход мог попасть в копию. Обновите CLI; исходный чат сохранён.");
    opts.signal.throwIfAborted();
    return { resumeSessionId: id };
  } finally {
    opts.signal.removeEventListener("abort", onAbort);
    rejectAll(new Error("Codex: соединение закрыто"));
    rl.close();
    if (!(await stopCodex(child))) throw new Error("Не удалось завершить собственный процесс подготовки истории Codex.");
    child.removeListener("error", onError);
    child.removeListener("exit", onExit);
  }
}
