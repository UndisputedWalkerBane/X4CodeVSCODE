import { useEffect, useId, useRef, useState } from "react";
import type { HostToWebview, WebviewToHost } from "../src/shared/protocol";
import type { ProjectAccessField, ProjectAccessInput, ProjectAccessSummary } from "../src/shared/projectAccesses";

export type ProjectAccessSnapshot = Extract<HostToWebview, { type: "projectAccesses" }>;
type AccessRequest = Extract<WebviewToHost, { type: "getProjectAccesses" | "saveProjectAccess" | "deleteProjectAccess" }>;
type Draft = { id?: string; name: string; purpose: string; values: Record<ProjectAccessField, string>; clearFields: ProjectAccessField[] };
type Pending = { requestId: string; kind: "load" | "save" | "delete" };

const FIELDS: ProjectAccessField[] = ["url", "login", "password", "apiKey"];
const LABELS: Record<ProjectAccessField, string> = { url: "Адрес / URL", login: "Логин", password: "Пароль", apiKey: "API-ключ" };
const emptyValues = (): Draft["values"] => ({ url: "", login: "", password: "", apiKey: "" });
const requestId = () => `access-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

/** Only metadata enters this editor; new values live in its local, keyed React state. */
export function ProjectAccesses({ projectPath, chatId, snapshot, onPost }: {
  projectPath: string;
  chatId?: string;
  snapshot: ProjectAccessSnapshot | null;
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
  const addRef = useRef<HTMLButtonElement>(null);
  const restoreAddFocusRef = useRef(false);

  const begin = (kind: Pending["kind"]): string => {
    const next = { kind, requestId: requestId() };
    pendingRef.current = next;
    setPending(next);
    setError(undefined);
    setNotice("");
    return next.requestId;
  };
  const load = () => {
    if (pendingRef.current) return;
    postRef.current({ type: "getProjectAccesses", projectPath, requestId: begin("load") });
  };

  useEffect(() => {
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
    const current = pendingRef.current;
    if (!snapshot || !current || snapshot.projectPath !== projectPath || snapshot.chatId !== chatId ||
        snapshot.requestId !== current.requestId) return;
    const olderRevision = snapshot.revision < revisionRef.current;
    if (olderRevision && !snapshot.error) return;
    pendingRef.current = null;
    setPending(null);
    if (!olderRevision) {
      revisionRef.current = snapshot.revision;
      setRevision(snapshot.revision);
      setEntries(snapshot.entries);
    }
    setError(snapshot.error);
    if (snapshot.error) return;
    setLoaded(true);
    if (current.kind !== "load") {
      setDraft(null);
      setNotice(current.kind === "save" ? "Доступ сохранён" : "Доступ удалён");
      restoreAddFocusRef.current = true;
    }
  }, [snapshot, projectPath, chatId]);

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
  const hasValue = !!draft && FIELDS.some(field => draft.values[field].length > 0 ||
    (savedEntry?.hasValues[field] && !draft.clearFields.includes(field)));
  const validation = !draft ? undefined : !draft.name.trim() ? "Укажите название сервиса." :
    !hasValue ? "Добавьте хотя бы одно значение доступа." : undefined;
  const busy = !!pending;
  const cancel = () => {
    if (pendingRef.current) return;
    setDraft(null);
    setError(undefined);
    setNotice("");
    restoreAddFocusRef.current = true;
  };
  const open = (entry?: ProjectAccessSummary) => {
    if (!loaded || pendingRef.current || draft) return;
    setDraft({ ...(entry ? { id: entry.id } : {}), name: entry?.name ?? "", purpose: entry?.purpose ?? "", values: emptyValues(), clearFields: [] });
    setError(undefined);
    setNotice("");
  };
  const save = () => {
    if (!draft || !loaded || pendingRef.current || validation) return;
    const values = Object.fromEntries(FIELDS.filter(field => draft.values[field].length > 0).map(field => [field, draft.values[field]]));
    const access: ProjectAccessInput = { ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(), purpose: draft.purpose.trim(),
      ...(Object.keys(values).length ? { values } : {}), ...(draft.clearFields.length ? { clearFields: [...draft.clearFields] } : {}) };
    postRef.current({ type: "saveProjectAccess", projectPath, requestId: begin("save"), expectedRevision: revision, access });
  };

  return (
    <div className="project-accesses" role="region" aria-labelledby={`${id}-title`} aria-busy={busy}>
      <div className="project-accesses-heading">
        <h4 id={`${id}-title`}>Дополнительные доступы</h4>
        <button ref={addRef} type="button" className="finish-btn" disabled={!loaded || busy || editing} onClick={() => open()}>Добавить доступ</button>
      </div>
      <p className="project-accesses-hint">Отдельная карточка для каждого сервиса. Сохранённые значения не показываются; агент получает их через переменные окружения.</p>
      {!loaded && !busy && error && <button type="button" className="finish-btn project-accesses-retry" onClick={load}>Повторить загрузку</button>}
      {loaded && entries.length === 0 && <p className="project-accesses-hint">Доступов пока нет.</p>}
      <div className="project-accesses-list">
        {entries.map(entry => (
          <article className="project-access-card" key={entry.id} aria-labelledby={`${id}-${entry.id}`}>
            <div className="project-accesses-heading">
              <h5 id={`${id}-${entry.id}`}>{entry.name}</h5>
              <div className="project-accesses-actions">
                <button type="button" className="finish-btn" aria-label={`Изменить ${entry.name}`} disabled={busy || editing} onClick={() => open(entry)}>Изменить</button>
                <button type="button" className="finish-btn delete-btn" aria-label={`Удалить ${entry.name}`} disabled={busy || editing} onClick={() => {
                  if (pendingRef.current || draft) return;
                  postRef.current({ type: "deleteProjectAccess", projectPath, requestId: begin("delete"), expectedRevision: revision, id: entry.id });
                }}>Удалить</button>
              </div>
            </div>
            {entry.purpose && <p className="project-access-purpose">{entry.purpose}</p>}
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
          <p className="project-accesses-hint" id={`${id}-preserve`}>Пустое поле сохраняет прежнее значение. Для удаления используйте «Очистить сохранённое».</p>
          <div className="project-access-credentials">{FIELDS.map(field => (
            <div className="project-access-field" key={field}>
              <label htmlFor={`${id}-${field}`}>{LABELS[field]}</label>
              <input id={`${id}-${field}`} name={field} type={field === "password" || field === "apiKey" ? "password" : "text"}
                value={draft.values[field]} disabled={busy || draft.clearFields.includes(field)} autoComplete={field === "password" ? "new-password" : "off"} spellCheck={false}
                aria-describedby={`${id}-preserve ${id}-${field}-state`} placeholder={savedEntry?.hasValues[field] ? "Задано · пусто — сохранить" : "Не задано"}
                onChange={event => setDraft({ ...draft, values: { ...draft.values, [field]: event.target.value } })} />
              <span className="project-accesses-hint" id={`${id}-${field}-state`}>{draft.clearFields.includes(field) ? "Будет удалено при сохранении" : savedEntry?.hasValues[field] ? "Сохранённое значение задано" : "Можно оставить пустым"}</span>
              {savedEntry?.hasValues[field] && <button type="button" className="finish-btn project-access-clear" disabled={busy}
                aria-label={`${draft.clearFields.includes(field) ? "Не очищать" : "Очистить сохранённое"}: ${LABELS[field]}`} onClick={() => setDraft({ ...draft,
                  values: { ...draft.values, [field]: "" }, clearFields: draft.clearFields.includes(field) ? draft.clearFields.filter(value => value !== field) : [...draft.clearFields, field] })}>
                {draft.clearFields.includes(field) ? "Не очищать" : "Очистить сохранённое"}
              </button>}
            </div>
          ))}</div>
          <div id={`${id}-validation`} className="project-access-error" role={validation ? "alert" : undefined}>{validation}</div>
          <div className="project-accesses-actions">
            <button type="button" className="finish-btn" aria-label="Сохранить доступ" disabled={busy || !!validation} onClick={save}>Сохранить</button>
            <button type="button" className="finish-btn" aria-label="Отмена доступа" disabled={busy} onClick={cancel}>Отмена</button>
          </div>
        </div>
      )}
      {error && <div className="project-access-error" role="alert">{error}</div>}
      <div className="project-accesses-hint" role="status">{pending ? pending.kind === "load" ? "Загружаю доступы…" : pending.kind === "save" ? "Сохраняю доступ…" : "Удаляю доступ…" : notice}</div>
    </div>
  );
}
