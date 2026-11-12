import { useEffect, useId, useRef, useState } from "react";
import type { HostToWebview, WebviewToHost } from "../src/shared/protocol";
import type { ProjectAccessConnectionField, ProjectAccessConnectionInput, ProjectAccessField, ProjectAccessInput, ProjectAccessProtocol, ProjectAccessSummary } from "../src/shared/projectAccesses";

export type ProjectAccessSnapshot = Extract<HostToWebview, { type: "projectAccesses" }>;
export type ProjectAccessTestResult = Extract<HostToWebview, { type: "projectAccessTestResult" }>;
type AccessRequest = Extract<WebviewToHost, { type: "getProjectAccesses" | "saveProjectAccess" | "deleteProjectAccess" | "testProjectAccess" }>;
type Draft = { id?: string; name: string; purpose: string; protocol?: ProjectAccessProtocol; port: string; portInvalid?: boolean; repository: string; values: Record<ProjectAccessField, string>; clearFields: ProjectAccessField[] };
type Pending = { requestId: string; kind: "load" | "refresh" | "save" | "delete" };
type InFlight = { requestId: string; projectPath: string; chatId?: string; id?: string; protocol: ProjectAccessProtocol; revision: number };
type Probe = InFlight & { mode: "draft" | "saved"; fingerprint: string; status: "pending" | "ok" | "fail"; message: string };

const FIELDS: ProjectAccessField[] = ["url", "login", "password", "apiKey"];
const CONNECTION_FIELDS: ProjectAccessConnectionField[] = ["url", "login", "password"];
const LABELS: Record<ProjectAccessField, string> = { url: "Адрес / URL", login: "Логин", password: "Пароль", apiKey: "API-ключ" };
const emptyValues = (): Draft["values"] => ({ url: "", login: "", password: "", apiKey: "" });
const requestId = () => `access-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const validPort = (port: string) => port === "" || (/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535);
const draftConnection = (draft: Draft): ProjectAccessConnectionInput => {
  const values = Object.fromEntries(CONNECTION_FIELDS.filter(field => draft.values[field].length > 0).map(field => [field, draft.values[field]]));
  const clearFields = CONNECTION_FIELDS.filter(field => draft.clearFields.includes(field));
  return { ...(draft.id ? { id: draft.id } : {}), protocol: draft.protocol ?? "ssh", ...(draft.port ? { port: Number(draft.port) } : {}),
    ...(Object.keys(values).length ? { values } : {}), ...(clearFields.length ? { clearFields } : {}) };
};
const savedConnection = (entry: ProjectAccessSummary): ProjectAccessConnectionInput => ({ id: entry.id, protocol: entry.protocol ?? "ssh", ...(entry.port !== undefined ? { port: entry.port } : {}) });
const repositoryHref = (repository: string): string | undefined => {
  try { const url = new URL(repository); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
};

/** Only metadata enters this editor; new values live in its local, keyed React state. */
export function ProjectAccesses({ projectPath, chatId, snapshot, testResult = null, onPost }: {
  projectPath: string;
  chatId?: string;
  snapshot: ProjectAccessSnapshot | null;
  testResult?: ProjectAccessTestResult | null;
  onPost: (request: AccessRequest) => void;
}) {
  const [entries, setEntries] = useState<ProjectAccessSummary[]>([]);
  const [revision, setRevision] = useState(0);
  const revisionRef = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState("");
  const postRef = useRef(onPost);
  postRef.current = onPost;
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const portRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const restoreAddFocusRef = useRef(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const probeRef = useRef<Probe | null>(null);
  const [inFlight, setInFlight] = useState<InFlight | null>(null);
  const inFlightRef = useRef<InFlight | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const needsRefreshRef = useRef(false);
  const invalidateProbe = () => { probeRef.current = null; setProbe(null); };

  const begin = (kind: Pending["kind"]): string => {
    invalidateProbe();
    const next = { kind, requestId: requestId() };
    pendingRef.current = next;
    setPending(next);
    setError(undefined);
    setNotice("");
    return next.requestId;
  };
  const load = () => {
    if (pendingRef.current) return;
    postRef.current({ type: "getProjectAccesses", projectPath, requestId: begin(needsRefreshRef.current ? "refresh" : "load") });
  };

  useEffect(() => {
    invalidateProbe();
    inFlightRef.current = null;
    setInFlight(null);
    needsRefreshRef.current = false;
    setNeedsRefresh(false);
    restoreAddFocusRef.current = false;
    pendingRef.current = null;
    revisionRef.current = 0;
    setRevision(0);
    setEntries([]);
    setLoaded(false);
    setDraft(null);
    setError(undefined);
    setNotice("");
    const next = { kind: "load" as const, requestId: requestId() };
    pendingRef.current = next;
    setPending(next);
    postRef.current({ type: "getProjectAccesses", projectPath, requestId: next.requestId });
  }, [projectPath, chatId]);

  useEffect(() => {
    if (!snapshot || snapshot.projectPath !== projectPath || snapshot.chatId !== chatId) return;
    if (snapshot.revision > revisionRef.current) invalidateProbe();
    const current = pendingRef.current;
    if (!current || snapshot.requestId !== current.requestId) return;
    const olderRevision = snapshot.revision < revisionRef.current;
    if (olderRevision && !snapshot.error) return;
    pendingRef.current = null;
    setPending(null);
    invalidateProbe();
    if (!olderRevision) {
      revisionRef.current = snapshot.revision;
      setRevision(snapshot.revision);
      setEntries(snapshot.entries);
    }
    setError(snapshot.error);
    if (snapshot.error) return;
    setLoaded(true);
    needsRefreshRef.current = false;
    setNeedsRefresh(false);
    if (current.kind !== "load" && current.kind !== "refresh") {
      setDraft(null);
      setNotice(current.kind === "save" ? "Доступ сохранён" : "Доступ удалён");
      restoreAddFocusRef.current = true;
    }
  }, [snapshot, projectPath, chatId]);

  useEffect(() => {
    const current = inFlightRef.current;
    if (!testResult || !current || testResult.projectPath !== current.projectPath || testResult.chatId !== current.chatId ||
        testResult.requestId !== current.requestId || testResult.id !== current.id || testResult.protocol !== current.protocol ||
        (testResult.ok && testResult.revision !== current.revision)) return;
    inFlightRef.current = null;
    setInFlight(null);
    if (!testResult.ok && testResult.revision > revisionRef.current) {
      needsRefreshRef.current = true;
      setNeedsRefresh(true);
      load();
      setError(testResult.message);
      return;
    }
    const visible = probeRef.current;
    if (!visible || visible.requestId !== current.requestId || revisionRef.current !== current.revision) return;
    const entry = entries.find(candidate => candidate.id === current.id);
    const access = visible.mode === "draft" ? draft ? draftConnection(draft) : null : entry ? savedConnection(entry) : null;
    if (!access || visible.fingerprint !== JSON.stringify([projectPath, chatId, revisionRef.current, visible.mode, access])) return;
    const next: Probe = { ...visible, status: testResult.ok ? "ok" : "fail", message: testResult.message };
    probeRef.current = next;
    setProbe(next);
  }, [testResult, projectPath, chatId]);

  useEffect(() => {
    if (!inFlight) return;
    const timer = globalThis.setTimeout(() => {
      if (inFlightRef.current?.requestId !== inFlight.requestId) return;
      inFlightRef.current = null;
      setInFlight(null);
      if (probeRef.current?.requestId === inFlight.requestId) {
        const next: Probe = { ...probeRef.current, status: "fail", message: "Проверка не завершилась вовремя. Повторите попытку." };
        probeRef.current = next;
        setProbe(next);
      }
    }, 17000);
    return () => globalThis.clearTimeout(timer);
  }, [inFlight]);

  const editing = !!draft;
  const editingId = draft?.id;
  useEffect(() => { if (editing) nameRef.current?.focus(); }, [editing, editingId]);
  useEffect(() => {
    if (!editing && !pending && loaded && restoreAddFocusRef.current) {
      restoreAddFocusRef.current = false;
      addRef.current?.focus();
    }
  }, [editing, pending, loaded]);
  const savedEntry = draft?.id ? entries.find(entry => entry.id === draft.id) : undefined;
  const portError = draft && (draft.portInvalid || !validPort(draft.port)) ? "Порт должен быть целым числом от 1 до 65535." : undefined;
  const hasValue = !!draft && FIELDS.some(field => draft.values[field].length > 0 ||
    (savedEntry?.hasValues[field] && !draft.clearFields.includes(field)));
  const validation = !draft ? undefined : portError || (!draft.name.trim() ? "Укажите название сервиса." :
    !hasValue ? "Добавьте хотя бы одно значение доступа." : undefined);
  const hasConnectionField = (field: "url" | "login") => !!draft && (!!draft.values[field].trim() ||
    (!!savedEntry?.hasValues[field] && !draft.clearFields.includes(field)));
  const checkValidation = !draft ? undefined : portError || (!hasConnectionField("url") || !hasConnectionField("login") ? "Для проверки укажите адрес и логин этого доступа." : undefined);
  const busy = !!pending;
  const cancel = () => {
    if (pendingRef.current) return;
    setDraft(null);
    setError(undefined);
    setNotice("");
    invalidateProbe();
    restoreAddFocusRef.current = true;
  };
  const open = (entry?: ProjectAccessSummary) => {
    if (!loaded || pendingRef.current || draft) return;
    invalidateProbe();
    setDraft({ ...(entry ? { id: entry.id } : {}), name: entry?.name ?? "", purpose: entry?.purpose ?? "", protocol: entry?.protocol,
      port: entry?.port === undefined ? "" : String(entry.port), repository: entry?.repository ?? "", values: emptyValues(), clearFields: [] });
    setError(undefined);
    setNotice("");
  };
  const updatePort = (input: Pick<HTMLInputElement, "value" | "validity">) => {
    const value = input.value;
    const invalid = !!input.validity?.badInput || input.validity?.valid === false || !validPort(value);
    invalidateProbe();
    setDraft(current => current ? { ...current, port: value, portInvalid: invalid } : current);
  };
  const guardNativePort = () => {
    const input = portRef.current;
    if (input && (input.validity?.badInput || input.validity?.valid === false || !validPort(input.value))) {
      updatePort(input);
      return false;
    }
    return true;
  };
  const save = () => {
    if (!draft || !loaded || pendingRef.current || inFlightRef.current || validation) return;
    if (!guardNativePort()) return;
    const values = Object.fromEntries(FIELDS.filter(field => draft.values[field].length > 0).map(field => [field, draft.values[field]]));
    const access: ProjectAccessInput = { ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(), purpose: draft.purpose.trim(),
      ...(draft.protocol ? { protocol: draft.protocol } : {}), ...(draft.port ? { port: Number(draft.port) } : {}), ...(draft.repository.trim() ? { repository: draft.repository.trim() } : {}),
      ...(Object.keys(values).length ? { values } : {}), ...(draft.clearFields.length ? { clearFields: [...draft.clearFields] } : {}) };
    postRef.current({ type: "saveProjectAccess", projectPath, requestId: begin("save"), expectedRevision: revision, access });
  };
  const testConnection = (access: ProjectAccessConnectionInput, mode: "draft" | "saved", canCheck: boolean) => {
    if (!loaded || pendingRef.current || inFlightRef.current || needsRefreshRef.current || !canCheck) return;
    if (mode === "draft" && !guardNativePort()) return;
    // Password-bearing comparison stays in memory and never enters persisted UI state or a result.
    const context: InFlight = { requestId: requestId(), projectPath, chatId, id: access.id, protocol: access.protocol, revision };
    const next: Probe = { ...context, mode,
      fingerprint: JSON.stringify([projectPath, chatId, revision, mode, access]), status: "pending", message: "" };
    probeRef.current = next;
    setProbe(next);
    inFlightRef.current = context;
    setInFlight(context);
    postRef.current({ type: "testProjectAccess", projectPath, requestId: next.requestId, expectedRevision: revision, access });
  };
  const testDraft = () => {
    if (!draft) return;
    testConnection(draftConnection(draft), "draft", !checkValidation);
  };

  return (
    <div className="project-accesses" role="region" aria-labelledby={`${id}-title`} aria-busy={busy}>
      <div className="project-accesses-heading">
        <h4 id={`${id}-title`}>Дополнительные доступы</h4>
        <button ref={addRef} type="button" className="finish-btn" disabled={!loaded || busy || editing} onClick={() => open()}>Добавить доступ</button>
      </div>
      <p className="project-accesses-hint">Отдельная карточка для каждого сервиса. Сохранённые значения не показываются; агент получает их через переменные окружения.</p>
      {!busy && (needsRefresh || (!loaded && error)) && <button type="button" className="finish-btn project-accesses-retry" onClick={load}>Повторить загрузку</button>}
      {loaded && entries.length === 0 && <p className="project-accesses-hint">Доступов пока нет.</p>}
      <div className="project-accesses-list">
        {entries.map(entry => (
          <article className="project-access-card" key={entry.id} aria-labelledby={`${id}-${entry.id}`}>
            <div className="project-accesses-heading">
              <h5 id={`${id}-${entry.id}`}>{entry.name}</h5>
              <div className="project-accesses-actions">
                <button type="button" className="finish-btn" aria-label={`Проверить доступ ${entry.name}`} disabled={busy || editing || !!inFlight || needsRefresh || !entry.hasValues.url || !entry.hasValues.login}
                  onClick={() => testConnection(savedConnection(entry), "saved", entry.hasValues.url && entry.hasValues.login)}>Проверить доступ</button>
                <button type="button" className="finish-btn" aria-label={`Изменить ${entry.name}`} disabled={busy || editing} onClick={() => open(entry)}>Изменить</button>
                <button type="button" className="finish-btn delete-btn" aria-label={`Удалить ${entry.name}`} disabled={busy || editing || !!inFlight} onClick={() => {
                  if (pendingRef.current || inFlightRef.current || draft) return;
                  postRef.current({ type: "deleteProjectAccess", projectPath, requestId: begin("delete"), expectedRevision: revision, id: entry.id });
                }}>Удалить</button>
              </div>
            </div>
            {entry.purpose && <p className="project-access-purpose">{entry.purpose}</p>}
            <p className="project-accesses-hint">{(entry.protocol ?? "ssh").toUpperCase()}{entry.port !== undefined ? ` · порт ${entry.port}` : ""}</p>
            {entry.repository && <div className="project-access-repository"><span>Репозиторий: </span>{repositoryHref(entry.repository)
              ? <a href={repositoryHref(entry.repository)} target="_blank" rel="noopener noreferrer">{entry.repository}</a>
              : <code>{entry.repository}</code>}</div>}
            <dl className="project-access-values">{FIELDS.map(field => (
              <div key={field}><dt>{LABELS[field]}</dt><dd>{entry.hasValues[field] ? "задано" : "не задано"}</dd></div>
            ))}</dl>
            <details className="project-access-env">
              <summary>Переменные для агента</summary>
              <dl>{FIELDS.filter(field => entry.hasValues[field]).map(field => (
                <div key={field}><dt>{LABELS[field]}</dt><dd><code>{entry.envNames[field]}</code></dd></div>
              ))}</dl>
            </details>
          </article>
        ))}
      </div>
      {draft && (
        <div className="project-access-editor" role="group" aria-labelledby={`${id}-editor`} onKeyDown={event => {
          if (event.key === "Escape" && !pendingRef.current) { event.stopPropagation(); cancel(); }
        }}>
          <h5 id={`${id}-editor`}>{draft.id ? "Изменить доступ" : "Новый доступ"}</h5>
          <div className="project-access-field">
            <label htmlFor={`${id}-name`}>Название / сервис</label>
            <input ref={nameRef} id={`${id}-name`} name="name" value={draft.name} required aria-required="true" disabled={busy}
              aria-describedby={`${id}-validation`} aria-invalid={!draft.name.trim()} autoComplete="off"
              onChange={event => setDraft({ ...draft, name: event.target.value })} />
          </div>
          <div className="project-access-field">
            <label htmlFor={`${id}-purpose`}>Для чего нужен доступ</label>
            <input id={`${id}-purpose`} name="purpose" value={draft.purpose} disabled={busy} autoComplete="off"
              onChange={event => setDraft({ ...draft, purpose: event.target.value })} />
          </div>
          <div className="project-access-field">
            <label htmlFor={`${id}-repository`}>Репозиторий кода на сервере</label>
            <input id={`${id}-repository`} name="repository" value={draft.repository} disabled={busy} autoComplete="off" aria-describedby={`${id}-repository-hint`}
              placeholder="https://github.com/team/repo или git@host:team/repo.git" onChange={event => setDraft({ ...draft, repository: event.target.value })} />
            <span id={`${id}-repository-hint`} className="project-accesses-hint">Публичный адрес без пароля и токена. Адрес виден агенту.</span>
          </div>
          <div className="project-access-connection-options">
            <div className="project-access-field">
              <label htmlFor={`${id}-protocol`}>Протокол проверки</label>
              <select id={`${id}-protocol`} name="protocol" value={draft.protocol ?? "ssh"} disabled={busy} onChange={event => {
                invalidateProbe(); setDraft({ ...draft, protocol: event.target.value as ProjectAccessProtocol });
              }}><option value="ssh">SSH</option><option value="sftp">SFTP</option><option value="ftp">FTP</option></select>
            </div>
            <div className="project-access-field">
              <label htmlFor={`${id}-port`}>Порт</label>
              <input ref={portRef} id={`${id}-port`} name="port" type="number" min={1} max={65535} step={1} value={draft.port} disabled={busy}
                placeholder={draft.protocol === "ftp" ? "21" : "22 / SSH config"} aria-invalid={!!portError} aria-describedby={`${id}-validation`}
                onInput={event => updatePort(event.currentTarget)} onChange={event => updatePort(event.target)} />
            </div>
          </div>
          <p className="project-accesses-hint" id={`${id}-preserve`}>Пустое поле сохраняет прежнее значение. Для удаления используйте «Очистить сохранённое».</p>
          <div className="project-access-credentials">{FIELDS.map(field => (
            <div className="project-access-field" key={field}>
              <label htmlFor={`${id}-${field}`}>{LABELS[field]}</label>
              <input id={`${id}-${field}`} name={field} type={field === "password" || field === "apiKey" ? "password" : "text"}
                value={draft.values[field]} disabled={busy || draft.clearFields.includes(field)} autoComplete={field === "password" ? "new-password" : "off"} spellCheck={false}
                aria-describedby={`${id}-preserve ${id}-${field}-state`} placeholder={savedEntry?.hasValues[field] ? "Задано · пусто — сохранить" : "Не задано"}
                onChange={event => { if (field !== "apiKey") invalidateProbe(); setDraft({ ...draft, values: { ...draft.values, [field]: event.target.value } }); }} />
              <span className="project-accesses-hint" id={`${id}-${field}-state`}>{draft.clearFields.includes(field) ? "Будет удалено при сохранении" : savedEntry?.hasValues[field] ? "Сохранённое значение задано" : "Можно оставить пустым"}</span>
              {savedEntry?.hasValues[field] && <button type="button" className="finish-btn project-access-clear" disabled={busy}
                aria-label={`${draft.clearFields.includes(field) ? "Не очищать" : "Очистить сохранённое"}: ${LABELS[field]}`} onClick={() => {
                  if (field !== "apiKey") invalidateProbe();
                  setDraft({ ...draft, values: { ...draft.values, [field]: "" }, clearFields: draft.clearFields.includes(field) ? draft.clearFields.filter(value => value !== field) : [...draft.clearFields, field] });
                }}>
                {draft.clearFields.includes(field) ? "Не очищать" : "Очистить сохранённое"}
              </button>}
            </div>
          ))}</div>
          <div id={`${id}-validation`} className="project-access-error" role={validation ? "alert" : undefined}>{validation}</div>
          <div className="project-accesses-actions">
            <button type="button" className="finish-btn" disabled={busy || !!inFlight || needsRefresh || !!checkValidation} onClick={testDraft} aria-describedby={`${id}-check-hint`}>Проверить текущие поля</button>
            <button type="button" className="finish-btn" aria-label="Сохранить доступ" disabled={busy || !!inFlight || !!validation} onClick={save}>Сохранить</button>
            <button type="button" className="finish-btn" aria-label="Отмена доступа" disabled={busy} onClick={cancel}>Отмена</button>
          </div>
          <p className="project-accesses-hint" id={`${id}-check-hint`}>{checkValidation || "Проверка не сохраняет поля. Пустые адрес, логин и пароль берутся только из этой карточки; API-ключ не проверяется."}</p>
        </div>
      )}
      {probe && <div className={probe.status === "fail" ? "project-access-error" : probe.status === "ok" ? "project-access-test-ok" : "project-accesses-hint"}
        role={probe.status === "fail" ? "alert" : "status"}>{probe.status === "pending" ? "Проверяю доступ…" : probe.message}</div>}
      {!probe && inFlight && <div className="project-accesses-hint" role="status">Предыдущая проверка завершается…</div>}
      {error && <div className="project-access-error" role="alert">{error}</div>}
      <div className="project-accesses-hint" role="status">{pending ? pending.kind === "load" ? "Загружаю доступы…" : pending.kind === "refresh" ? "Обновляю доступы…" : pending.kind === "save" ? "Сохраняю доступ…" : "Удаляю доступ…" : notice}</div>
    </div>
  );
}
