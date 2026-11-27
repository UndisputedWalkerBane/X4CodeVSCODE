// VS Code Explorer supplies the full selection in CodeFiles or its private URI list.
// A browser's standard URI list can contain just the first selected resource.
const dropTypes = ["CodeFiles", "ResourceURLs", "application/vnd.code.uri-list", "text/uri-list"] as const;

export function hasFileDropType(transfer: DataTransfer): boolean {
  const types = Array.from(transfer.types, type => type.toLowerCase());
  return types.includes("files") || dropTypes.some(type => types.includes(type.toLowerCase()));
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && !/[\x00-\x1f]/.test(value) &&
    /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value);
}

function localFileUri(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^file:\/\//i.test(value) || /%2f|[\\\x00-\x1f]/i.test(value)) return;
  try {
    const uri = new URL(value);
    if (uri.hostname || uri.search || uri.hash || uri.pathname.startsWith("//")) return;
    const path = decodeURIComponent(uri.pathname);
    if (path.startsWith("/\\")) return;
    const windowsDrive = /^\/[A-Za-z]:\//.test(path);
    if (windowsDrive && path.includes("\\")) return;
    const native = windowsDrive ? path.slice(1).replace(/\//g, "\\") : path;
    return absolutePath(native) ? native : undefined;
  } catch {
    return undefined;
  }
}

export function droppedLocalPaths(transfer: DataTransfer): string[] {
  for (const type of dropTypes) {
    const raw = transfer.getData(type);
    if (!raw) continue;
    let paths: string[];
    if (type === "CodeFiles" || type === "ResourceURLs") {
      let values: unknown;
      try { values = JSON.parse(raw); } catch { continue; }
      if (!Array.isArray(values)) continue;
      paths = type === "CodeFiles" ? values.filter(absolutePath) : values.map(localFileUri).filter(absolutePath);
    } else {
      paths = raw.split(/\r?\n/).map(localFileUri).filter(absolutePath);
    }
    if (paths.length) return [...new Set(paths)];
  }
  return [];
}

export function droppedBasename(path: string): string {
  return path.split(path.startsWith("/") ? "/" : /[\\/]/).at(-1) ?? "";
}

export function countDropNames(names: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

export function appendFilePaths(text: string, paths: readonly string[]): string {
  if (!paths.length) return text;
  const lines = paths.map(path => `Файл: ${/[\x00-\x1f]|\s$/.test(path) ? JSON.stringify(path) : path}`);
  return text + (text && !text.endsWith("\n") ? "\n" : "") + lines.join("\n");
}
