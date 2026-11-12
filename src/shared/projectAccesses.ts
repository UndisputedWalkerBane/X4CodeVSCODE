/** Public card metadata. Saved values never cross the host/webview boundary. */
export type ProjectAccessField = "url" | "login" | "password" | "apiKey";

export interface ProjectAccessSummary {
  id: string;
  name: string;
  purpose: string;
  hasValues: Record<ProjectAccessField, boolean>;
  envNames: Record<ProjectAccessField, string>;
}

/** Empty patches preserve values; removing one requires an explicit clear. */
export interface ProjectAccessInput {
  id?: string;
  name: string;
  purpose: string;
  values?: Partial<Record<ProjectAccessField, string>>;
  clearFields?: ProjectAccessField[];
}
