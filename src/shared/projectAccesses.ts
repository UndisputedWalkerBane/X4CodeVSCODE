/** Public card metadata. Saved values never cross the host/webview boundary. */
export type ProjectAccessField = "url" | "login" | "password" | "apiKey";
export type ProjectAccessProtocol = "ssh" | "sftp" | "ftp";
export type ProjectAccessConnectionField = "url" | "login" | "password";

export interface ProjectAccessConnectionInput {
  id?: string;
  protocol: ProjectAccessProtocol;
  port?: number;
  values?: Partial<Record<ProjectAccessConnectionField, string>>;
  clearFields?: ProjectAccessConnectionField[];
}

export interface ProjectAccessSummary {
  id: string;
  name: string;
  purpose: string;
  protocol?: ProjectAccessProtocol;
  port?: number;
  repository?: string;
  hasValues: Record<ProjectAccessField, boolean>;
  envNames: Record<ProjectAccessField, string>;
}

/** Empty patches preserve values; removing one requires an explicit clear. */
export interface ProjectAccessInput {
  id?: string;
  name: string;
  purpose: string;
  protocol?: ProjectAccessProtocol;
  port?: number;
  repository?: string;
  values?: Partial<Record<ProjectAccessField, string>>;
  clearFields?: ProjectAccessField[];
}
